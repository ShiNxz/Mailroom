// Mail events for apps: new mail in an inbox, a send that went out, a send that failed for good.
// Stored in order (the id is the stream cursor), announced on Redis for open streams, and queued for
// every token with a webhook that may see them. Kept for 7 days.

import { and, eq, gt, inArray, isNotNull, isNull, lt, max, or } from 'drizzle-orm'
import { accessibleMailboxIds } from '../access'
import type { ApiTokenRow, UserRow } from '../auth'
import { db, schema } from '../db'
import type { MailEventType } from '../db/schema'
import { errorMessage, log } from '../lib/log'
import { redis } from '../lib/redis'

export const MAIL_EVENTS_CHANNEL = 'mailroom:mail-events'
export const EVENT_RETENTION_DAYS = 7

type MailEventRow = typeof schema.mailEvents.$inferSelect
type OutboxRef = { userId: string; tokenId: string | null } | undefined

/**
 * Who sees an event: new mail goes to anyone who may read that mailbox (tokens need read access);
 * sent and failed go to the person who sent it, and for a token only to the token that sent it.
 * The mailbox itself is checked by the caller against accessibleMailboxIds.
 */
export function eventVisible(
	event: Pick<MailEventRow, 'type'>,
	caller: { user: UserRow; token: ApiTokenRow | null },
	outbox: OutboxRef,
) {
	if (event.type === 'message.received') return !caller.token || caller.token.canRead
	if (!outbox || outbox.userId !== caller.user.id) return false
	return !caller.token || outbox.tokenId === caller.token.id
}

export async function recordMailEvent(e: {
	type: MailEventType
	mailboxId: string
	messageId?: string
	outboxId?: string
	error?: string
}) {
	try {
		const [row] = await db
			.insert(schema.mailEvents)
			.values({
				type: e.type,
				mailboxId: e.mailboxId,
				messageId: e.messageId ?? null,
				outboxId: e.outboxId ?? null,
				error: e.error ?? null,
			})
			.returning()
		if (!row) return
		await queueWebhooks(row)
		await redis.publish(MAIL_EVENTS_CHANNEL, JSON.stringify({ id: row.id, mailboxId: row.mailboxId }))
	} catch (err) {
		// Never let an app-facing event break syncing or sending
		log.warn('could not record a mail event', { type: e.type, err: errorMessage(err) })
	}
}

async function queueWebhooks(event: MailEventRow) {
	const now = new Date()
	const tokens = await db
		.select({ token: schema.apiTokens, user: schema.users })
		.from(schema.apiTokens)
		.innerJoin(schema.users, eq(schema.users.id, schema.apiTokens.userId))
		.where(
			and(
				isNotNull(schema.apiTokens.webhookUrl),
				isNull(schema.apiTokens.revokedAt),
				or(isNull(schema.apiTokens.expiresAt), gt(schema.apiTokens.expiresAt, now)),
				eq(schema.users.disabled, false),
			),
		)
	if (!tokens.length) return
	const [outbox] = event.outboxId
		? await db
				.select({ userId: schema.outbox.userId, tokenId: schema.outbox.tokenId })
				.from(schema.outbox)
				.where(eq(schema.outbox.id, event.outboxId))
		: []
	const due: (typeof schema.webhookDeliveries.$inferInsert)[] = []
	for (const { token, user } of tokens) {
		if (!eventVisible(event, { user, token }, outbox)) continue
		const ids = await accessibleMailboxIds({ ...user, tokenScope: token.scope })
		if (ids.includes(event.mailboxId)) due.push({ tokenId: token.id, eventId: event.id })
	}
	if (due.length) await db.insert(schema.webhookDeliveries).values(due).onConflictDoNothing()
}

/** Events after a cursor that this caller may see, oldest first. */
export async function eventsFor(
	caller: { user: UserRow & { tokenScope?: ApiTokenRow['scope'] }; token: ApiTokenRow | null },
	after: number,
	limit: number,
) {
	const ids = await accessibleMailboxIds(caller.user)
	if (!ids.length) return { rows: [] as MailEventRow[], scannedTo: after }
	const rows = await db
		.select({ e: schema.mailEvents, userId: schema.outbox.userId, tokenId: schema.outbox.tokenId })
		.from(schema.mailEvents)
		.leftJoin(schema.outbox, eq(schema.outbox.id, schema.mailEvents.outboxId))
		.where(and(gt(schema.mailEvents.id, after), inArray(schema.mailEvents.mailboxId, ids)))
		.orderBy(schema.mailEvents.id)
		.limit(limit)
	const visible = rows.filter(r =>
		eventVisible(r.e, caller, r.userId ? { userId: r.userId, tokenId: r.tokenId } : undefined),
	)
	// The cursor moves past events this caller may not see, so they are not scanned again
	return { rows: visible.map(r => r.e), scannedTo: rows.at(-1)?.e.id ?? after }
}

export async function latestEventId() {
	const [row] = await db.select({ id: max(schema.mailEvents.id) }).from(schema.mailEvents)
	return Number(row?.id ?? 0)
}

export async function pruneMailEvents() {
	const cutoff = new Date(Date.now() - EVENT_RETENTION_DAYS * 86400_000)
	await db.delete(schema.mailEvents).where(lt(schema.mailEvents.createdAt, cutoff))
}
