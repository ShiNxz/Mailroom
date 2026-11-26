import { and, eq, inArray, sql } from 'drizzle-orm'
import MailComposer from 'nodemailer/lib/mail-composer'
import { db, schema } from '../db'
import { randomToken } from '../lib/ids'
import { errorMessage, log } from '../lib/log'
import { recordMailEvent } from '../events/mail-events'
import { publishEvent } from '../lib/redis'
import { describeConnectionError, settingsOf, smtpTransport } from './connect'
import { inlineDataImages } from './inline-images'
import { htmlToText } from './parse'
import { sanitizeComposerHtml } from './sanitize'
import type { MailboxSync } from './sync'

type OutboxRow = typeof schema.outbox.$inferSelect

const MAX_ATTEMPTS = 4

/** Items that were mid-send when the worker stopped. Retrying could send twice, so they are failed with a note. */
export async function failInterrupted() {
	const rows = await db
		.update(schema.outbox)
		.set({
			status: 'failed',
			error: 'The server restarted while this was sending. Check Sent before sending it again.',
		})
		.where(eq(schema.outbox.status, 'sending'))
		.returning()
	for (const r of rows)
		await publishEvent({ type: 'outbox', mailboxId: r.mailboxId, id: r.id, status: 'failed', error: r.error })
}

/** Claims due outbox items and sends them. */
export async function processOutbox(syncers: Map<string, MailboxSync>) {
	for (;;) {
		const claimed = (await db.execute(sql`
			update outbox set status = 'sending', attempts = attempts + 1
			where id in (
				select id from outbox where status = 'queued' and send_at <= now()
				order by send_at limit 5 for update skip locked
			)
			returning id`)) as unknown as { id: string }[]
		if (!claimed.length) return
		const rows = await db
			.select()
			.from(schema.outbox)
			.where(
				inArray(
					schema.outbox.id,
					claimed.map(c => c.id),
				),
			)
		await Promise.all(rows.map(row => sendOne(row, syncers)))
	}
}

async function sendOne(item: OutboxRow, syncers: Map<string, MailboxSync>) {
	const l = log.child({ outbox: item.id })
	try {
		const [mailbox] = await db.select().from(schema.mailboxes).where(eq(schema.mailboxes.id, item.mailboxId))
		if (!mailbox) throw new PermanentError('The mailbox was removed')
		const p = item.payload
		const syncer = syncers.get(mailbox.id)

		const original = p.replyToMessageId
			? (await db.select().from(schema.messages).where(eq(schema.messages.id, p.replyToMessageId)))[0]
			: undefined
		const references = original
			? [...original.references, original.messageId].filter((v): v is string => !!v).slice(-20)
			: []

		const uploads = p.attachmentIds.length
			? await db
					.select()
					.from(schema.uploads)
					.where(and(inArray(schema.uploads.id, p.attachmentIds), eq(schema.uploads.userId, item.userId)))
			: []
		const attachments: {
			filename: string
			content: Buffer
			contentType?: string
			cid?: string
			contentDisposition?: 'inline' | 'attachment'
		}[] = uploads.map(u => {
			// An API send's inline image: in multipart/related, shown where the html says <img src="cid:...">
			const cid = p.attachmentCids?.[u.id]
			return {
				filename: u.filename,
				content: u.data,
				contentType: u.contentType,
				...(cid ? { cid, contentDisposition: 'inline' as const } : {}),
			}
		})

		if (p.forwardOfMessageId && p.forwardAttachments?.length) {
			const [fwd] = await db.select().from(schema.messages).where(eq(schema.messages.id, p.forwardOfMessageId))
			if (fwd && syncer) {
				const parts = await syncer.downloadParts(fwd.folderId, fwd.uid, p.forwardAttachments)
				for (const part of parts) {
					const meta = fwd.attachments.find(a => a.partId === part.partId)
					attachments.push({
						filename: meta?.filename ?? part.filename ?? 'attachment',
						content: part.content,
						contentType: meta?.contentType ?? part.contentType,
					})
				}
			}
		}

		const domain = mailbox.address.split('@')[1] ?? 'localhost'
		const messageId = `<${randomToken(18)}@${domain}>`
		// API sends may be plain text only; the web composer always sends HTML
		// Composer html is cleaned; an API send's html (react-email and the like) goes out as the app built it
		const cleaned = p.html.trim() ? (p.rawHtml ? p.html : sanitizeComposerHtml(p.html)) : null
		// Pasted images and signature logos travel as data: URLs; they go out as inline attachments instead
		const inlined = cleaned ? inlineDataImages(cleaned) : null
		const html = inlined?.html ?? null
		if (inlined) attachments.push(...inlined.images)
		const composer = new MailComposer({
			from: { name: p.fromName?.trim() || mailbox.displayName, address: mailbox.address },
			replyTo: p.replyTo?.length ? p.replyTo.map(a => ({ name: a.name, address: a.address })) : undefined,
			to: p.to.map(a => ({ name: a.name, address: a.address })),
			cc: p.cc.map(a => ({ name: a.name, address: a.address })),
			bcc: p.bcc.map(a => ({ name: a.name, address: a.address })),
			subject: p.subject,
			html: html ?? undefined,
			text: p.text ?? (html ? htmlToText(html) : ''),
			messageId,
			inReplyTo: original?.messageId ?? undefined,
			references: references.length ? references.join(' ') : undefined,
			date: new Date(),
			attachments,
			disableFileAccess: true,
			disableUrlAccess: true,
			xMailer: 'Mailroom',
			// From API sends: checked against an allow-list when queued (routes/app.ts)
			headers: p.headers ?? undefined,
		})
		const node = composer.compile()
		const raw = await node.build()
		node.keepBcc = true
		const rawWithBcc = await node.build()

		const recipients = [...p.to, ...p.cc, ...p.bcc].map(a => a.address)
		if (!recipients.length) throw new PermanentError('No recipients')
		const transport = smtpTransport(settingsOf(mailbox))
		try {
			await transport.sendMail({ envelope: { from: mailbox.address, to: recipients }, raw })
		} finally {
			transport.close()
		}
		l.info('sent', { mailbox: mailbox.address, recipients: recipients.length })

		await db
			.update(schema.outbox)
			.set({ status: 'sent', sentAt: new Date(), error: null, messageId })
			.where(eq(schema.outbox.id, item.id))
		await publishEvent({ type: 'outbox', mailboxId: mailbox.id, id: item.id, status: 'sent', error: null })
		await recordMailEvent({ type: 'message.sent', mailboxId: mailbox.id, outboxId: item.id })

		if (mailbox.saveSent && syncer) {
			syncer.appendSent(rawWithBcc).catch(err => l.warn('could not save to Sent', { err }))
		} else if (syncer) {
			syncer.poke('full')
		}
		if (original && !original.answered) {
			await db.update(schema.messages).set({ answered: true }).where(eq(schema.messages.id, original.id))
			await db.insert(schema.pendingOps).values({
				mailboxId: original.mailboxId,
				kind: 'flags',
				payload: { folderId: original.folderId, uids: [original.uid], add: ['\\Answered'] },
			})
			syncers.get(original.mailboxId)?.poke('ops')
		}
		if (uploads.length)
			await db.delete(schema.uploads).where(
				inArray(
					schema.uploads.id,
					uploads.map(u => u.id),
				),
			)
	} catch (err) {
		const permanent = err instanceof PermanentError || isPermanentSmtpError(err) || item.attempts >= MAX_ATTEMPTS
		const message = err instanceof PermanentError ? err.message : describeConnectionError(err)
		l.warn('send failed', { err: errorMessage(err), permanent, attempts: item.attempts })
		await db
			.update(schema.outbox)
			.set(
				permanent
					? { status: 'failed', error: message }
					: { status: 'queued', error: message, sendAt: new Date(Date.now() + 2 ** item.attempts * 60_000) },
			)
			.where(eq(schema.outbox.id, item.id))
		await publishEvent({
			type: 'outbox',
			mailboxId: item.mailboxId,
			id: item.id,
			status: permanent ? 'failed' : 'queued',
			error: message,
		})
		if (permanent)
			await recordMailEvent({
				type: 'message.failed',
				mailboxId: item.mailboxId,
				outboxId: item.id,
				error: message,
			}).catch(e => l.warn('could not record the failure event', { err: errorMessage(e) }))
	}
}

class PermanentError extends Error {}

function isPermanentSmtpError(err: unknown) {
	const e = err as { responseCode?: number; code?: string }
	if (e?.code === 'EAUTH' || e?.code === 'EENVELOPE' || e?.code === 'EMESSAGE') return true
	return typeof e?.responseCode === 'number' && e.responseCode >= 500
}
