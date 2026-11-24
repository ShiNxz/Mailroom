import type { ComposePayload, Draft, OutboxItem, Template } from '@mailroom/shared'
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import { accessibleMailboxIds, accessibleProjectIds, assertMailboxAccess, isAdmin } from '../access'
import { authed } from '../context'
import { db, schema } from '../db'
import { env } from '../env'
import { badRequest, HttpError, notFound } from '../lib/http'
import { publishEvent, sendCommand } from '../lib/redis'

const AddressT = t.Object({
	name: t.String({ maxLength: 200 }),
	address: t.String({ format: 'email', maxLength: 320 }),
})
const PayloadT = t.Object({
	mailboxId: t.String(),
	to: t.Array(AddressT, { maxItems: 200 }),
	cc: t.Array(AddressT, { maxItems: 200 }),
	bcc: t.Array(AddressT, { maxItems: 200 }),
	subject: t.String({ maxLength: 1000 }),
	html: t.String({ maxLength: 5_000_000 }),
	replyToMessageId: t.Optional(t.Union([t.String(), t.Null()])),
	forwardOfMessageId: t.Optional(t.Union([t.String(), t.Null()])),
	attachmentIds: t.Array(t.String(), { maxItems: 50 }),
	forwardAttachments: t.Optional(t.Array(t.String(), { maxItems: 50 })),
})

const toOutbox = (r: typeof schema.outbox.$inferSelect): OutboxItem => ({
	id: r.id,
	mailboxId: r.mailboxId,
	status: r.status,
	sendAt: r.sendAt.toISOString(),
	sentAt: r.sentAt?.toISOString() ?? null,
	error: r.error,
	attempts: r.attempts,
	payload: r.payload,
	messageId: r.messageId,
	createdAt: r.createdAt.toISOString(),
})

const toDraft = (d: typeof schema.drafts.$inferSelect): Draft => ({
	id: d.id,
	mailboxId: d.mailboxId,
	payload: d.payload,
	updatedAt: d.updatedAt.toISOString(),
})

const toTemplate = (r: typeof schema.templates.$inferSelect): Template => ({
	id: r.id,
	projectId: r.projectId,
	name: r.name,
	subject: r.subject,
	html: r.html,
	createdBy: r.createdBy,
})

async function ownOutboxItem(userId: string, id: string, admin: boolean) {
	const [row] = await db.select().from(schema.outbox).where(eq(schema.outbox.id, id))
	if (!row || (row.userId !== userId && !admin)) throw notFound('Not in the outbox')
	return row
}

export const composeRoutes = new Elysia()
	.use(authed)

	// --- Sending -----------------------------------------------------------------------------
	.post(
		'/send',
		async ({ user, body }) => {
			const p = body.payload as ComposePayload
			await assertMailboxAccess(user, p.mailboxId)
			if (!p.to.length && !p.cc.length && !p.bcc.length) throw badRequest('Add at least one recipient')
			if (p.replyToMessageId || p.forwardOfMessageId) {
				const ids = await accessibleMailboxIds(user)
				const refs = [p.replyToMessageId, p.forwardOfMessageId].filter((v): v is string => !!v)
				const found = await db
					.select({ id: schema.messages.id })
					.from(schema.messages)
					.where(and(inArray(schema.messages.id, refs), inArray(schema.messages.mailboxId, ids)))
				if (found.length !== new Set(refs).size) throw badRequest('The original message is gone')
			}
			if (p.attachmentIds.length) {
				const own = await db
					.select({ id: schema.uploads.id })
					.from(schema.uploads)
					.where(and(inArray(schema.uploads.id, p.attachmentIds), eq(schema.uploads.userId, user.id)))
				if (own.length !== new Set(p.attachmentIds).size) throw badRequest('An attachment is missing, attach it again')
			}
			let sendAt: Date
			if (body.sendAt) {
				sendAt = new Date(body.sendAt)
				if (Number.isNaN(sendAt.getTime())) throw badRequest('Bad send time')
				if (sendAt.getTime() < Date.now() + 30_000) throw badRequest('Pick a time at least a minute from now')
				if (sendAt.getTime() > Date.now() + 366 * 86400_000) throw badRequest('Pick a time within a year')
			} else {
				const undo = body.undoSeconds ?? user.settings.undoSeconds ?? 10
				sendAt = new Date(Date.now() + Math.max(0, Math.min(30, undo)) * 1000)
			}
			const [row] = await db
				.insert(schema.outbox)
				.values({ userId: user.id, mailboxId: p.mailboxId, payload: p, sendAt })
				.returning()
			if (body.draftId)
				await db.delete(schema.drafts).where(and(eq(schema.drafts.id, body.draftId), eq(schema.drafts.userId, user.id)))
			if (sendAt.getTime() <= Date.now() + 1000) await sendCommand({ type: 'outbox' })
			await publishEvent({ type: 'outbox', mailboxId: p.mailboxId, id: row!.id, status: 'queued', error: null })
			return { item: toOutbox(row!) }
		},
		{
			body: t.Object({
				payload: PayloadT,
				sendAt: t.Optional(t.String()),
				undoSeconds: t.Optional(t.Number()),
				draftId: t.Optional(t.String()),
			}),
		},
	)

	.get(
		'/outbox',
		async ({ user, query }) => {
			// A thread's replies that are not in it yet: waiting, sending, failed, or sent in the last day
			// but not synced back from Sent. The thread shows them right away with their state.
			if (query.thread) {
				const ids = await accessibleMailboxIds(user)
				const inThread = ids.length
					? await db
							.select({ id: schema.messages.id })
							.from(schema.messages)
							.where(and(eq(schema.messages.threadId, query.thread), inArray(schema.messages.mailboxId, ids)))
					: []
				if (!inThread.length) return { items: [] }
				const rows = await db
					.select()
					.from(schema.outbox)
					.where(
						and(
							eq(schema.outbox.userId, user.id),
							inArray(schema.outbox.status, ['queued', 'sending', 'failed', 'sent']),
							sql`${schema.outbox.createdAt} > now() - interval '1 day'`,
							inArray(
								sql`${schema.outbox.payload}->>'replyToMessageId'`,
								inThread.map(m => m.id),
							),
						),
					)
					.orderBy(schema.outbox.createdAt)
					.limit(50)
				return { items: rows.map(toOutbox) }
			}
			const statuses = (query.status ?? 'queued,failed').split(',') as OutboxItem['status'][]
			const rows = await db
				.select()
				.from(schema.outbox)
				.where(and(eq(schema.outbox.userId, user.id), inArray(schema.outbox.status, statuses)))
				.orderBy(schema.outbox.sendAt)
				.limit(200)
			return { items: rows.map(toOutbox) }
		},
		{ query: t.Object({ status: t.Optional(t.String()), thread: t.Optional(t.String({ maxLength: 64 })) }) },
	)

	.post('/outbox/:id/cancel', async ({ user, params }) => {
		const row = await ownOutboxItem(user.id, params.id, isAdmin(user))
		// Only while it is still waiting: the row lock makes this race-free against the sender
		const [cancelled] = await db
			.update(schema.outbox)
			.set({ status: 'cancelled' })
			.where(and(eq(schema.outbox.id, row.id), inArray(schema.outbox.status, ['queued', 'failed'])))
			.returning()
		if (!cancelled) throw new HttpError(409, 'Too late, it was already sent')
		await publishEvent({ type: 'outbox', mailboxId: row.mailboxId, id: row.id, status: 'cancelled', error: null })
		return { item: toOutbox(cancelled) }
	})

	.patch(
		'/outbox/:id',
		async ({ user, params, body }) => {
			const row = await ownOutboxItem(user.id, params.id, isAdmin(user))
			const sendAt = body.sendAt === 'now' ? new Date() : new Date(body.sendAt)
			if (Number.isNaN(sendAt.getTime())) throw badRequest('Bad send time')
			const [updated] = await db
				.update(schema.outbox)
				.set({ sendAt, status: 'queued', error: null, attempts: 0 })
				.where(and(eq(schema.outbox.id, row.id), inArray(schema.outbox.status, ['queued', 'failed'])))
				.returning()
			if (!updated) throw new HttpError(409, 'It was already sent')
			if (body.sendAt === 'now') await sendCommand({ type: 'outbox' })
			await publishEvent({ type: 'outbox', mailboxId: row.mailboxId, id: row.id, status: 'queued', error: null })
			return { item: toOutbox(updated) }
		},
		{ body: t.Object({ sendAt: t.String() }) },
	)

	// --- Attachments -------------------------------------------------------------------------
	.post(
		'/uploads',
		async ({ user, body }) => {
			const file = body.file
			if (file.size > env.maxUploadBytes)
				throw badRequest(`Attachments can be up to ${Math.round(env.maxUploadBytes / 1024 / 1024)} MB`)
			const data = Buffer.from(await file.arrayBuffer())
			const [row] = await db
				.insert(schema.uploads)
				.values({
					userId: user.id,
					filename: (file.name || 'attachment').slice(0, 255),
					contentType: file.type || 'application/octet-stream',
					size: data.length,
					data,
				})
				.returning({
					id: schema.uploads.id,
					filename: schema.uploads.filename,
					contentType: schema.uploads.contentType,
					size: schema.uploads.size,
				})
			return { upload: row }
		},
		{ body: t.Object({ file: t.File() }) },
	)

	.delete('/uploads/:id', async ({ user, params }) => {
		await db.delete(schema.uploads).where(and(eq(schema.uploads.id, params.id), eq(schema.uploads.userId, user.id)))
		return { ok: true }
	})

	// --- Drafts ------------------------------------------------------------------------------
	.get('/drafts', async ({ user }) => {
		const rows = await db
			.select()
			.from(schema.drafts)
			.where(eq(schema.drafts.userId, user.id))
			.orderBy(desc(schema.drafts.updatedAt))
		return { drafts: rows.map(toDraft) }
	})

	.put(
		'/drafts/:id',
		async ({ user, params, body }) => {
			const mailboxId = body.payload.mailboxId ?? null
			if (mailboxId) await assertMailboxAccess(user, mailboxId)
			const [existing] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, params.id))
			if (existing && existing.userId !== user.id) throw notFound('No such draft')
			const values = { mailboxId, payload: body.payload as Partial<ComposePayload>, updatedAt: new Date() }
			const [row] = existing
				? await db.update(schema.drafts).set(values).where(eq(schema.drafts.id, params.id)).returning()
				: await db
						.insert(schema.drafts)
						.values({ id: params.id, userId: user.id, ...values })
						.returning()
			return { draft: toDraft(row!) }
		},
		{
			params: t.Object({ id: t.String({ pattern: '^[a-z0-9]{16}$' }) }),
			body: t.Object({ payload: t.Partial(PayloadT) }),
		},
	)

	.delete('/drafts/:id', async ({ user, params }) => {
		await db.delete(schema.drafts).where(and(eq(schema.drafts.id, params.id), eq(schema.drafts.userId, user.id)))
		return { ok: true }
	})

	// --- Templates ---------------------------------------------------------------------------
	.get('/templates', async ({ user }) => {
		const projects = await accessibleProjectIds(user)
		const rows = await db
			.select()
			.from(schema.templates)
			.where(
				or(
					and(isNull(schema.templates.projectId), eq(schema.templates.createdBy, user.id)),
					projects === 'all' ? undefined : projects.length ? inArray(schema.templates.projectId, projects) : undefined,
					projects === 'all' ? sql`${schema.templates.projectId} is not null` : undefined,
				),
			)
		const visible = rows.filter(
			r =>
				(r.projectId === null && r.createdBy === user.id) ||
				(r.projectId !== null && (projects === 'all' || projects.includes(r.projectId))),
		)
		return { templates: visible.sort((a, b) => a.name.localeCompare(b.name)).map(toTemplate) }
	})

	.post(
		'/templates',
		async ({ user, body }) => {
			if (body.projectId) {
				const projects = await accessibleProjectIds(user)
				if (projects !== 'all' && !projects.includes(body.projectId)) throw notFound('No such project')
			}
			const [row] = await db
				.insert(schema.templates)
				.values({
					projectId: body.projectId ?? null,
					createdBy: user.id,
					name: body.name.trim(),
					subject: body.subject ?? '',
					html: body.html,
				})
				.returning()
			return { template: toTemplate(row!) }
		},
		{
			body: t.Object({
				projectId: t.Optional(t.Union([t.String(), t.Null()])),
				name: t.String({ minLength: 1, maxLength: 120 }),
				subject: t.Optional(t.String({ maxLength: 1000 })),
				html: t.String({ maxLength: 500_000 }),
			}),
		},
	)

	.put(
		'/templates/:id',
		async ({ user, params, body }) => {
			const [row] = await db.select().from(schema.templates).where(eq(schema.templates.id, params.id))
			if (!row || (row.createdBy !== user.id && !isAdmin(user))) throw notFound('No such template')
			const [updated] = await db
				.update(schema.templates)
				.set({ name: body.name.trim(), subject: body.subject ?? '', html: body.html })
				.where(eq(schema.templates.id, row.id))
				.returning()
			return { template: toTemplate(updated!) }
		},
		{
			body: t.Object({
				name: t.String({ minLength: 1, maxLength: 120 }),
				subject: t.Optional(t.String({ maxLength: 1000 })),
				html: t.String({ maxLength: 500_000 }),
			}),
		},
	)

	.delete('/templates/:id', async ({ user, params }) => {
		const [row] = await db.select().from(schema.templates).where(eq(schema.templates.id, params.id))
		if (!row || (row.createdBy !== user.id && !isAdmin(user))) throw notFound('No such template')
		await db.delete(schema.templates).where(eq(schema.templates.id, row.id))
		return { ok: true }
	})
