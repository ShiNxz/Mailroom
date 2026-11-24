// What the app API, the stream and webhooks return. Kept apart from the web app's shapes so the
// public format only changes on purpose.

import type { ApiEvent, ApiMailbox, ApiMessage, ApiSend } from '@mailroom/shared'
import { eq, inArray } from 'drizzle-orm'
import { db, schema } from './db'

type MessageRow = typeof schema.messages.$inferSelect
type OutboxRow = typeof schema.outbox.$inferSelect
type MailEventRow = typeof schema.mailEvents.$inferSelect

export function toApiMessage(m: MessageRow, folder: string, mailbox: string, withBody: boolean): ApiMessage {
	return {
		id: m.id,
		mailboxId: m.mailboxId,
		mailbox,
		folder,
		threadId: m.threadId,
		messageId: m.messageId,
		inReplyTo: m.inReplyTo,
		from: { name: m.fromName, address: m.fromAddress },
		to: m.to,
		cc: m.cc,
		replyTo: m.replyTo,
		subject: m.subject,
		date: m.date.toISOString(),
		snippet: m.snippet,
		seen: m.seen,
		flagged: m.flagged,
		answered: m.answered,
		attachments: m.attachments
			.filter(a => !a.inline)
			.map(a => ({ partId: a.partId, filename: a.filename, contentType: a.contentType, size: a.size })),
		...(withBody ? { text: m.textBody, html: m.htmlBody } : {}),
	}
}

export const toApiSend = (r: OutboxRow): ApiSend => ({
	id: r.id,
	mailboxId: r.mailboxId,
	status: r.status,
	subject: r.payload.subject,
	to: r.payload.to,
	sendAt: r.sendAt.toISOString(),
	sentAt: r.sentAt?.toISOString() ?? null,
	error: r.error,
	messageId: r.messageId,
})

export const folderLabel = (f: { specialUse: string | null; path: string }) => f.specialUse ?? f.path

export async function apiMailboxes(ids: string[]): Promise<ApiMailbox[]> {
	if (!ids.length) return []
	const rows = await db
		.select({ m: schema.mailboxes, project: schema.projects.name })
		.from(schema.mailboxes)
		.innerJoin(schema.projects, eq(schema.projects.id, schema.mailboxes.projectId))
		.where(inArray(schema.mailboxes.id, ids))
		.orderBy(schema.mailboxes.address)
	return rows.map(r => ({
		id: r.m.id,
		address: r.m.address,
		name: r.m.displayName,
		projectId: r.m.projectId,
		project: r.project,
	}))
}

/** Events as apps see them. Events whose message is gone since are left out. */
export async function toApiEvents(rows: MailEventRow[]): Promise<ApiEvent[]> {
	if (!rows.length) return []
	const messageIds = rows.map(r => r.messageId).filter((v): v is string => !!v)
	const outboxIds = rows.map(r => r.outboxId).filter((v): v is string => !!v)
	const mailboxIds = [...new Set(rows.map(r => r.mailboxId))]
	const [messages, sends, mailboxes] = await Promise.all([
		messageIds.length
			? db
					.select({ m: schema.messages, folder: schema.folders })
					.from(schema.messages)
					.innerJoin(schema.folders, eq(schema.folders.id, schema.messages.folderId))
					.where(inArray(schema.messages.id, messageIds))
			: [],
		outboxIds.length ? db.select().from(schema.outbox).where(inArray(schema.outbox.id, outboxIds)) : [],
		db
			.select({ id: schema.mailboxes.id, address: schema.mailboxes.address })
			.from(schema.mailboxes)
			.where(inArray(schema.mailboxes.id, mailboxIds)),
	])
	const out: ApiEvent[] = []
	for (const r of rows) {
		const mailbox = mailboxes.find(m => m.id === r.mailboxId)
		if (!mailbox) continue
		const base = { id: String(r.id), createdAt: r.createdAt.toISOString(), mailbox }
		if (r.type === 'message.received') {
			const found = messages.find(m => m.m.id === r.messageId)
			if (!found) continue
			out.push({
				...base,
				type: r.type,
				message: toApiMessage(found.m, folderLabel(found.folder), mailbox.address, true),
			})
		} else {
			const send = sends.find(s => s.id === r.outboxId)
			if (!send) continue
			out.push({ ...base, type: r.type, send: { ...toApiSend(send), error: r.error ?? send.error } })
		}
	}
	return out
}
