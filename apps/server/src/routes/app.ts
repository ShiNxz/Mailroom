// The app API: what scripts and the SDK use with an API token (a signed-in session works too).
// Send from any mailbox the token covers, read and mark mail, and listen for new mail over a stream,
// long-polling or webhooks. Which endpoints a token may call is decided in context.ts.

import type { Address, ApiEvent, ComposePayload } from '@mailroom/shared'
import { and, desc, eq, inArray, lt, or, sql } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import { accessibleMailboxIds, assertMailboxAccess } from '../access'
import { apiMailboxes, folderLabel, toApiEvents, toApiMessage, toApiSend } from '../api-format'
import { type ApiTokenRow, apiTokenAuth, sessionForToken, tokenFrom } from '../auth'
import { authed, type ScopedUser } from '../context'
import { db, schema } from '../db'
import { env } from '../env'
import { eventsFor, latestEventId, MAIL_EVENTS_CHANNEL } from '../events/mail-events'
import { badRequest, HttpError, notFound } from '../lib/http'
import { log } from '../lib/log'
import { publishEvent, redis, sendCommand, subscribe } from '../lib/redis'

// --- Addresses -----------------------------------------------------------------------------------

const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/

function parseOne(raw: string): Address {
	const s = raw.trim()
	const angle = s.match(/^(.*?)<([^<>]+)>$/)
	const name = angle ? angle[1]!.trim().replace(/^"(.*)"$/, '$1') : ''
	const address = (angle ? angle[2]! : s).trim().toLowerCase()
	if (!EMAIL.test(address)) throw badRequest(`"${raw.slice(0, 100)}" is not an email address`)
	return { name: name.replace(/[\r\n]/g, ' ').slice(0, 200), address }
}

/** Splits "a@x.com, Bob <b@y.com>" on commas outside quotes and angle brackets. */
function splitList(s: string) {
	const out: string[] = []
	let cur = ''
	let quoted = false
	let angle = false
	for (const ch of s) {
		if (ch === '"') quoted = !quoted
		else if (ch === '<' && !quoted) angle = true
		else if (ch === '>' && !quoted) angle = false
		if ((ch === ',' || ch === ';') && !quoted && !angle) {
			out.push(cur)
			cur = ''
		} else cur += ch
	}
	out.push(cur)
	return out.map(x => x.trim()).filter(Boolean)
}

type AddressInput = string | (string | { name?: string; address: string })[] | undefined

function addresses(input: AddressInput): Address[] {
	if (!input) return []
	const list = typeof input === 'string' ? splitList(input) : input
	const out = list.flatMap(item =>
		typeof item === 'string'
			? splitList(item).map(parseOne)
			: [{ ...parseOne(item.address), name: (item.name ?? '').replace(/[\r\n]/g, ' ').slice(0, 200) }],
	)
	return [...new Map(out.map(a => [a.address, a])).values()]
}

const AddressListT = t.Optional(
	t.Union([
		t.String({ maxLength: 20_000 }),
		t.Array(
			t.Union([
				t.String({ maxLength: 400 }),
				t.Object({ name: t.Optional(t.String({ maxLength: 200 })), address: t.String({ maxLength: 320 }) }),
			]),
			{ maxItems: 100 },
		),
	]),
)

const AttachmentT = t.Object({
	filename: t.String({ minLength: 1, maxLength: 255 }),
	/** base64 */
	content: t.String(),
	contentType: t.Optional(t.String({ maxLength: 200 })),
	/** Content-ID: the file goes inline, shown by <img src="cid:..."> in the html */
	cid: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
})

// --- Sending -------------------------------------------------------------------------------------

const SENDS_PER_HOUR = 500

async function limitSends(token: ApiTokenRow | null) {
	if (!token) return
	const key = `rl:send:${token.id}:${Math.floor(Date.now() / 3_600_000)}`
	const n = await redis.incr(key)
	if (n === 1) await redis.expire(key, 3700)
	if (n > SENDS_PER_HOUR)
		throw new HttpError(
			429,
			`This token sent ${SENDS_PER_HOUR} messages this hour. Wait for the next hour.`,
			'rate_limited',
		)
}

async function resolveMailbox(user: ScopedUser, ref: string) {
	const ids = await accessibleMailboxIds(user)
	if (!ids.length) throw notFound('This token has no mailboxes')
	const needle = ref.trim().toLowerCase()
	const [mailbox] = await db
		.select()
		.from(schema.mailboxes)
		.where(
			and(
				inArray(schema.mailboxes.id, ids),
				or(eq(schema.mailboxes.id, ref.trim()), eq(sql`lower(${schema.mailboxes.address})`, needle)),
			),
		)
	if (!mailbox) throw notFound(`No mailbox ${ref} for this token`)
	return mailbox
}

interface SendInput {
	mailboxId: string
	fromName?: string
	to: Address[]
	cc: Address[]
	bcc: Address[]
	replyTo: Address[]
	subject: string
	text?: string
	html?: string
	attachments?: { filename: string; content: string; contentType?: string; cid?: string }[]
	sendAt?: string
	idempotencyKey?: string
	replyToMessageId?: string
	headers?: Record<string, string>
}

async function queueSend(user: ScopedUser, token: ApiTokenRow | null, input: SendInput) {
	if (!input.to.length && !input.cc.length && !input.bcc.length) throw badRequest('Add at least one recipient')
	if (input.to.length + input.cc.length + input.bcc.length > 100) throw badRequest('Up to 100 recipients per message')
	if (!input.text?.trim() && !input.html?.trim()) throw badRequest('Add a text or html body')
	const headers = cleanHeaders(input.headers)
	const key = input.idempotencyKey?.trim()
	if (key) {
		const [existing] = await db
			.select()
			.from(schema.outbox)
			.where(and(eq(schema.outbox.userId, user.id), eq(schema.outbox.idempotencyKey, key)))
		if (existing) return { item: existing, duplicate: true }
	}
	let sendAt = new Date()
	if (input.sendAt) {
		sendAt = new Date(input.sendAt)
		if (Number.isNaN(sendAt.getTime())) throw badRequest('sendAt is not a date')
		if (sendAt.getTime() > Date.now() + 366 * 86400_000) throw badRequest('sendAt must be within a year')
		if (sendAt.getTime() < Date.now()) sendAt = new Date()
	}
	await limitSends(token)

	const cids = new Set<string>()
	const files = (input.attachments ?? []).map(a => {
		const data = Buffer.from(a.content, 'base64')
		if (!data.length && a.content.length) throw badRequest(`${a.filename}: content must be base64`)
		// "logo", "<logo>" and "cid:logo" all mean the same Content-ID
		const cid = a.cid
			?.trim()
			.replace(/^cid:/i, '')
			.replace(/^<(.*)>$/, '$1')
		if (cid !== undefined) {
			if (!/^[A-Za-z0-9._@+$-]{1,120}$/.test(cid))
				throw badRequest(`${a.filename}: cid can use letters, digits and . _ @ + $ - (up to 120)`)
			if (cids.has(cid.toLowerCase())) throw badRequest(`Two attachments have the cid "${cid}"`)
			cids.add(cid.toLowerCase())
		}
		return { ...a, cid, data }
	})
	const total = files.reduce((n, f) => n + f.data.length, 0)
	if (total > env.maxUploadBytes)
		throw badRequest(`Attachments can be up to ${Math.round(env.maxUploadBytes / 1024 / 1024)} MB in all`)

	try {
		const item = await db.transaction(async tx => {
			// One insert per file, so each upload id is known to belong to its file (and its cid)
			const uploads: { id: string; cid?: string }[] = []
			for (const f of files) {
				const [row] = await tx
					.insert(schema.uploads)
					.values({
						userId: user.id,
						filename: f.filename.replace(/[\r\n/\\]/g, '_'),
						contentType: f.contentType || 'application/octet-stream',
						size: f.data.length,
						data: f.data,
					})
					.returning({ id: schema.uploads.id })
				uploads.push({ id: row!.id, cid: f.cid })
			}
			const inline = uploads.filter(u => u.cid)
			const payload: ComposePayload = {
				mailboxId: input.mailboxId,
				to: input.to,
				cc: input.cc,
				bcc: input.bcc,
				subject: input.subject.replace(/[\r\n]+/g, ' ').slice(0, 1000),
				html: input.html ?? '',
				text: input.text ?? null,
				fromName: input.fromName?.replace(/[\r\n]/g, ' ').slice(0, 200) || null,
				replyTo: input.replyTo,
				replyToMessageId: input.replyToMessageId ?? null,
				headers,
				attachmentIds: uploads.map(u => u.id),
				attachmentCids: inline.length ? Object.fromEntries(inline.map(u => [u.id, u.cid!])) : null,
				rawHtml: true,
			}
			const [row] = await tx
				.insert(schema.outbox)
				.values({
					userId: user.id,
					mailboxId: input.mailboxId,
					payload,
					sendAt,
					tokenId: token?.id ?? null,
					idempotencyKey: key || null,
				})
				.returning()
			return row!
		})
		if (sendAt.getTime() <= Date.now() + 1000) await sendCommand({ type: 'outbox' })
		await publishEvent({ type: 'outbox', mailboxId: input.mailboxId, id: item.id, status: 'queued', error: null })
		return { item, duplicate: false }
	} catch (err) {
		// Two requests with the same key at once: the second one gets the first one's send
		if (key && (err as { code?: string }).code === '23505') {
			const [existing] = await db
				.select()
				.from(schema.outbox)
				.where(and(eq(schema.outbox.userId, user.id), eq(schema.outbox.idempotencyKey, key)))
			if (existing) return { item: existing, duplicate: true }
		}
		throw err
	}
}

// Extra headers an app may set: mailing-list and automation headers, and its own X- headers. Everything
// Mailroom writes itself (From, To, Subject, Message-ID, Date, MIME, threading) stays Mailroom's.
const ALLOWED_HEADERS = new Set([
	'list-unsubscribe',
	'list-unsubscribe-post',
	'list-id',
	'list-help',
	'list-subscribe',
	'list-owner',
	'list-archive',
	'list-post',
	'auto-submitted',
	'precedence',
	'feedback-id',
])

function cleanHeaders(input: Record<string, string> | undefined) {
	if (!input) return null
	const entries = Object.entries(input)
	if (entries.length > 20) throw badRequest('Up to 20 extra headers')
	const out: Record<string, string> = {}
	for (const [name, value] of entries) {
		const lower = name.trim().toLowerCase()
		const custom = /^x-[a-z0-9-]{1,60}$/.test(lower) && lower !== 'x-mailer'
		if (!ALLOWED_HEADERS.has(lower) && !custom)
			throw badRequest(
				`The ${name} header can't be set. Allowed: List-*, Auto-Submitted, Precedence, Feedback-ID and X- headers.`,
			)
		if (/[\r\n]/.test(value) || value.length > 998) throw badRequest(`${name}: one line, up to 998 characters`)
		if (value.trim()) out[name.trim()] = value.trim()
	}
	return Object.keys(out).length ? out : null
}

const SendBodyT = {
	fromName: t.Optional(t.String({ maxLength: 200 })),
	headers: t.Optional(t.Record(t.String({ maxLength: 80 }), t.String({ maxLength: 1000 }))),
	text: t.Optional(t.String({ maxLength: 5_000_000 })),
	html: t.Optional(t.String({ maxLength: 5_000_000 })),
	attachments: t.Optional(t.Array(AttachmentT, { maxItems: 20 })),
	sendAt: t.Optional(t.String({ maxLength: 40 })),
	idempotencyKey: t.Optional(t.String({ maxLength: 200 })),
}

// --- Reading -------------------------------------------------------------------------------------

async function messageFor(user: ScopedUser, id: string) {
	const [row] = await db
		.select({ m: schema.messages, folder: schema.folders, address: schema.mailboxes.address })
		.from(schema.messages)
		.innerJoin(schema.folders, eq(schema.folders.id, schema.messages.folderId))
		.innerJoin(schema.mailboxes, eq(schema.mailboxes.id, schema.messages.mailboxId))
		.where(eq(schema.messages.id, id))
	if (!row) throw notFound('Message not found')
	await assertMailboxAccess(user, row.m.mailboxId)
	return row
}

/**
 * A folder by special use (inbox, sent, archive, trash, junk, drafts) or path. "all" is every folder
 * but trash and spam; where the server has an All Mail folder (Gmail), only that one, so copies of a
 * message in two labels don't show twice.
 */
async function foldersFor(mailboxIds: string[], name: string) {
	if (name.toLowerCase() !== 'all')
		return db
			.select()
			.from(schema.folders)
			.where(
				and(
					inArray(schema.folders.mailboxId, mailboxIds),
					or(eq(sql`${schema.folders.specialUse}`, name), eq(sql`lower(${schema.folders.path})`, name.toLowerCase())),
				),
			)
	const all = await db.select().from(schema.folders).where(inArray(schema.folders.mailboxId, mailboxIds))
	return mailboxIds.flatMap(id => {
		const own = all.filter(f => f.mailboxId === id)
		const allMail = own.find(f => f.specialUse === 'all')
		return allMail ? [allMail] : own.filter(f => f.specialUse !== 'trash' && f.specialUse !== 'junk')
	})
}

const encodeCursor = (date: Date, id: string) =>
	Buffer.from(JSON.stringify([date.toISOString(), id])).toString('base64url')
function decodeCursor(cursor: string) {
	try {
		const [date, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as [string, string]
		const d = new Date(date)
		if (Number.isNaN(d.getTime()) || typeof id !== 'string') throw new Error()
		return { date: d, id }
	} catch {
		throw badRequest('Bad cursor')
	}
}

// --- Listening -----------------------------------------------------------------------------------

type Wake = (mailboxId: string) => void
const wakers = new Set<Wake>()
let subscribed = false
function onMailEvent(wake: Wake) {
	if (!subscribed) {
		subscribed = true
		subscribe<{ id: number; mailboxId: string }>(MAIL_EVENTS_CHANNEL, e => {
			for (const w of wakers) w(e.mailboxId)
		})
	}
	wakers.add(wake)
	return () => wakers.delete(wake)
}

function startCursor(after: string | undefined | null) {
	if (after === undefined || after === null || after === '') return null
	const n = Number(after)
	if (!Number.isSafeInteger(n) || n < 0) throw badRequest('after must be an event id')
	return n
}

/** Open streams per token, so one token can't hold every connection */
const openStreams = new Map<string, number>()
const MAX_STREAMS_PER_TOKEN = 10

export const appRoutes = new Elysia()
	.use(authed)

	.get('/token', ({ user, token }) => ({
		token: token
			? {
					id: token.id,
					name: token.name,
					prefix: token.prefix,
					canRead: token.canRead,
					canSend: token.canSend,
					scope: token.scope,
					expiresAt: token.expiresAt?.toISOString() ?? null,
				}
			: null,
		user: { id: user.id, email: user.email, name: user.name },
	}))

	.get('/mailboxes', async ({ user }) => ({ mailboxes: await apiMailboxes(await accessibleMailboxIds(user)) }))

	// --- Messages ---------------------------------------------------------------------------------
	.get(
		'/messages',
		async ({ user, query }) => {
			const mailboxIds = query.mailbox
				? [(await resolveMailbox(user, query.mailbox)).id]
				: await accessibleMailboxIds(user)
			if (!mailboxIds.length) return { messages: [], nextCursor: null }
			const folderName = (query.folder ?? 'inbox').trim()
			const folders = await foldersFor(mailboxIds, folderName)
			if (!folders.length) return { messages: [], nextCursor: null }
			const limit = Math.max(1, Math.min(100, Number(query.limit ?? 25) || 25))
			const cursor = query.cursor ? decodeCursor(query.cursor) : null
			const unread = query.unread === 'true' || query.unread === '1'
			const rows = await db
				.select({ m: schema.messages, address: schema.mailboxes.address })
				.from(schema.messages)
				.innerJoin(schema.mailboxes, eq(schema.mailboxes.id, schema.messages.mailboxId))
				.where(
					and(
						inArray(
							schema.messages.folderId,
							folders.map(f => f.id),
						),
						unread ? eq(schema.messages.seen, false) : undefined,
						query.q ? sql`${schema.messages.search} @@ websearch_to_tsquery('simple', ${query.q})` : undefined,
						cursor
							? or(
									lt(schema.messages.date, cursor.date),
									and(eq(schema.messages.date, cursor.date), lt(schema.messages.id, cursor.id)),
								)
							: undefined,
					),
				)
				.orderBy(desc(schema.messages.date), desc(schema.messages.id))
				.limit(limit + 1)
			const page = rows.slice(0, limit)
			const last = page.at(-1)
			return {
				messages: page.map(r =>
					toApiMessage(r.m, folderLabel(folders.find(f => f.id === r.m.folderId)!), r.address, false),
				),
				nextCursor: rows.length > limit && last ? encodeCursor(last.m.date, last.m.id) : null,
			}
		},
		{
			query: t.Object({
				mailbox: t.Optional(t.String({ maxLength: 320 })),
				folder: t.Optional(t.String({ maxLength: 500 })),
				unread: t.Optional(t.String()),
				q: t.Optional(t.String({ maxLength: 500 })),
				limit: t.Optional(t.String()),
				cursor: t.Optional(t.String({ maxLength: 500 })),
			}),
		},
	)

	.get('/messages/:id', async ({ user, params }) => {
		const row = await messageFor(user, params.id)
		return { message: toApiMessage(row.m, folderLabel(row.folder), row.address, true) }
	})

	.patch(
		'/messages/:id',
		async ({ user, params, body }) => {
			const row = await messageFor(user, params.id)
			const m = row.m
			const changes: { seen?: boolean; flagged?: boolean } = {}
			const ops: (typeof schema.pendingOps.$inferInsert)[] = []
			for (const [column, flag] of [
				['seen', '\\Seen'],
				['flagged', '\\Flagged'],
			] as const) {
				const value = body[column]
				if (value === undefined || value === m[column]) continue
				changes[column] = value
				if (m.uid > 0)
					ops.push({
						mailboxId: m.mailboxId,
						kind: 'flags',
						payload: { folderId: m.folderId, uids: [m.uid], ...(value ? { add: [flag] } : { remove: [flag] }) },
					})
			}
			if (Object.keys(changes).length) {
				await db.update(schema.messages).set(changes).where(eq(schema.messages.id, m.id))
				if (ops.length) {
					await db.insert(schema.pendingOps).values(ops)
					await sendCommand({ type: 'ops', mailboxId: m.mailboxId })
				}
				await publishEvent({ type: 'messages', mailboxId: m.mailboxId, folderId: m.folderId })
			}
			return { message: toApiMessage({ ...m, ...changes }, folderLabel(row.folder), row.address, false) }
		},
		{ body: t.Object({ seen: t.Optional(t.Boolean()), flagged: t.Optional(t.Boolean()) }) },
	)

	// --- Sending ----------------------------------------------------------------------------------
	.post(
		'/messages',
		async ({ user, token, body, set }) => {
			const mailbox = await resolveMailbox(user, body.from)
			const { item, duplicate } = await queueSend(user, token, {
				...body,
				mailboxId: mailbox.id,
				to: addresses(body.to),
				cc: addresses(body.cc),
				bcc: addresses(body.bcc),
				replyTo: addresses(body.replyTo),
				replyToMessageId: body.inReplyTo ? (await messageFor(user, body.inReplyTo)).m.id : undefined,
			})
			set.status = duplicate ? 200 : 202
			return { send: toApiSend(item), duplicate }
		},
		{
			body: t.Object({
				/** The mailbox to send from: its address or id */
				from: t.String({ maxLength: 320 }),
				to: AddressListT,
				cc: AddressListT,
				bcc: AddressListT,
				replyTo: AddressListT,
				subject: t.String({ maxLength: 1000 }),
				/** Our id of a message this answers, for threading */
				inReplyTo: t.Optional(t.String({ maxLength: 100 })),
				...SendBodyT,
			}),
		},
	)

	.post(
		'/messages/:id/reply',
		async ({ user, token, params, body, set }) => {
			const { m } = await messageFor(user, params.id)
			const [mailbox] = await db.select().from(schema.mailboxes).where(eq(schema.mailboxes.id, m.mailboxId))
			if (!mailbox) throw notFound('Mailbox not found')
			const own = mailbox.address.toLowerCase()
			// Answering our own sent message goes to its recipients again
			const fromUs = m.fromAddress.toLowerCase() === own
			const to = fromUs ? m.to : m.replyTo.length ? m.replyTo : [{ name: m.fromName, address: m.fromAddress }]
			const cc = body.replyAll
				? [...m.to, ...m.cc].filter(
						a => a.address.toLowerCase() !== own && !to.some(x => x.address.toLowerCase() === a.address.toLowerCase()),
					)
				: []
			const { item, duplicate } = await queueSend(user, token, {
				...body,
				mailboxId: mailbox.id,
				to: to.filter(a => a.address.toLowerCase() !== own || fromUs),
				cc,
				bcc: [],
				replyTo: [],
				subject: /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`,
				replyToMessageId: m.id,
			})
			set.status = duplicate ? 200 : 202
			return { send: toApiSend(item), duplicate }
		},
		{ body: t.Object({ replyAll: t.Optional(t.Boolean()), ...SendBodyT }) },
	)

	.get('/outbox/:id', async ({ user, token, params }) => {
		const [row] = await db.select().from(schema.outbox).where(eq(schema.outbox.id, params.id))
		if (!row || row.userId !== user.id || (token && row.tokenId !== token.id)) throw notFound('No such send')
		return { send: toApiSend(row) }
	})

	// --- Listening --------------------------------------------------------------------------------

	// Long-polling, for environments without streaming: waits up to `wait` seconds for events
	.get(
		'/updates',
		async ({ user, token, query, request }) => {
			const caller = { user, token }
			const after = startCursor(query.after)
			if (after === null) return { events: [] as ApiEvent[], cursor: String(await latestEventId()) }
			const wait = Math.max(0, Math.min(30, Number(query.wait ?? 0) || 0))
			const deadline = Date.now() + wait * 1000
			let cursor = after
			for (;;) {
				const { rows, scannedTo } = await eventsFor(caller, cursor, 100)
				cursor = scannedTo
				const events = await toApiEvents(rows)
				if (events.length || Date.now() >= deadline || request.signal.aborted) return { events, cursor: String(cursor) }
				await new Promise<void>(resolve => {
					const timer = setTimeout(done, Math.max(0, deadline - Date.now()))
					const stop = onMailEvent(() => done())
					function done() {
						clearTimeout(timer)
						stop()
						resolve()
					}
				})
			}
		},
		{ query: t.Object({ after: t.Optional(t.String()), wait: t.Optional(t.String()) }) },
	)

	// Server-sent events. Each event's id is the cursor: reconnect with Last-Event-ID (or ?after=) and
	// nothing is missed while it is within the 7 days events are kept.
	.get(
		'/stream',
		async ({ user, token, query, request, cookie }) => {
			const key = token?.id ?? `user:${user.id}`
			const open = openStreams.get(key) ?? 0
			if (open >= MAX_STREAMS_PER_TOKEN)
				throw new HttpError(429, `Up to ${MAX_STREAMS_PER_TOKEN} open streams per token`, 'rate_limited')
			const caller = { user, token }
			let cursor = startCursor(request.headers.get('last-event-id') ?? query.after) ?? (await latestEventId())
			let allowed = new Set(await accessibleMailboxIds(user))
			const raw = tokenFrom(request.headers, cookie)
			const encoder = new TextEncoder()
			let cleanup = () => {}
			openStreams.set(key, open + 1)

			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					let closed = false
					const send = (data: string) => {
						if (closed) return
						try {
							controller.enqueue(encoder.encode(data))
						} catch {
							cleanup()
						}
					}
					// One pump at a time; a wake-up during a pump runs it again after
					let pumping = false
					let again = false
					const pump = async () => {
						if (pumping) {
							again = true
							return
						}
						pumping = true
						try {
							do {
								again = false
								for (;;) {
									const { rows, scannedTo } = await eventsFor(caller, cursor, 100)
									for (const e of await toApiEvents(rows))
										send(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
									if (scannedTo === cursor) break
									cursor = scannedTo
								}
							} while (again && !closed)
						} catch (err) {
							log.warn('app stream failed', { err: err instanceof Error ? err.message : String(err) })
						} finally {
							pumping = false
						}
					}
					const stop = onMailEvent(mailboxId => {
						if (allowed.has(mailboxId)) void pump()
					})
					// Revoked token, disabled user or removed access ends or narrows the stream within a minute
					const recheck = setInterval(async () => {
						const still = token ? !!(await apiTokenAuth(raw)) : !!(await sessionForToken(raw))
						if (!still) {
							send('event: error\ndata: {"error":"The token was revoked or expired"}\n\n')
							cleanup()
							return
						}
						allowed = new Set(await accessibleMailboxIds(user))
					}, 60_000)
					const heartbeat = setInterval(() => send(': ping\n\n'), 25_000)
					send(`retry: 3000\nid: ${cursor}\nevent: ready\ndata: ${JSON.stringify({ cursor: String(cursor) })}\n\n`)
					void pump()
					cleanup = () => {
						if (closed) return
						closed = true
						clearInterval(heartbeat)
						clearInterval(recheck)
						stop()
						openStreams.set(key, Math.max(0, (openStreams.get(key) ?? 1) - 1))
						try {
							controller.close()
						} catch {}
					}
					request.signal.addEventListener('abort', () => cleanup())
				},
				cancel() {
					cleanup()
				},
			})

			return new Response(stream, {
				headers: {
					'content-type': 'text/event-stream; charset=utf-8',
					'cache-control': 'no-store, no-transform',
					connection: 'keep-alive',
					'x-accel-buffering': 'no',
				},
			})
		},
		{ query: t.Object({ after: t.Optional(t.String()) }) },
	)
