import type { Address, Message, SpecialUse, ThreadRow, View } from '@mailroom/shared'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import { accessibleMailboxIds, assertMailboxAccess } from '../access'
import { authed } from '../context'
import { db, schema } from '../db'
import { badRequest, HttpError, notFound } from '../lib/http'
import { publishEvent, sendCommand } from '../lib/redis'
import { describeConnectionError, imapClient, settingsOf } from '../mail/connect'
import { textToHtml } from '../mail/parse'
import { sanitizeEmailHtml } from '../mail/sanitize'
import { bootstrap } from '../serialize'

type MessageRow = typeof schema.messages.$inferSelect

const VIEWS: View[] = ['inbox', 'unread', 'starred', 'snoozed', 'sent', 'drafts', 'archive', 'trash', 'junk', 'all']

/** SQL condition on `m` (messages) and `f` (folders) for a view. */
function viewCondition(view: View | 'folder', folderId?: string) {
	const notSnoozed = sql`(m.snoozed_until is null or m.snoozed_until <= now())`
	switch (view) {
		case 'folder':
			return sql`m.folder_id = ${folderId ?? ''}`
		case 'inbox':
			return sql`f.special_use = 'inbox' and ${notSnoozed}`
		case 'unread':
			return sql`f.special_use = 'inbox' and not m.seen and ${notSnoozed}`
		case 'starred':
			return sql`m.flagged and coalesce(f.special_use, '') not in ('trash', 'junk', 'flagged')`
		case 'snoozed':
			return sql`m.snoozed_until > now()`
		case 'sent':
		case 'drafts':
		case 'trash':
		case 'junk':
			return sql`f.special_use = ${view}`
		case 'archive':
			return sql`f.special_use in ('archive', 'all')`
		default:
			return sql`coalesce(f.special_use, '') not in ('trash', 'junk', 'flagged', 'all')`
	}
}

const encodeCursor = (sortAt: Date | string, threadId: string) =>
	Buffer.from(`${new Date(sortAt).toISOString()}|${threadId}`).toString('base64url')

function decodeCursor(cursor: string | undefined) {
	if (!cursor) return null
	const [at, threadId] = Buffer.from(cursor, 'base64url').toString('utf8').split('|')
	if (!at || !threadId || Number.isNaN(Date.parse(at))) return null
	return { at, threadId }
}

interface ThreadQueryRow {
	thread_id: string
	mailbox_id: string
	id: string
	subject: string
	snippet: string
	from_name: string
	from_address: string
	date: string
	sort_at: string
	snoozed_until: string | null
	count: number
	unread: boolean
	starred: boolean
	has_attachments: boolean
	participants: Address[]
	folder_ids: string[]
}

async function listThreads(opts: {
	mailboxIds: string[]
	view: View | 'folder'
	folderId?: string
	q?: string
	cursor?: string
	limit: number
}): Promise<{ threads: ThreadRow[]; next: string | null }> {
	if (!opts.mailboxIds.length) return { threads: [], next: null }
	const cursor = decodeCursor(opts.cursor)
	const q = opts.q?.trim()
	const search = q ? sql`and m.search @@ websearch_to_tsquery('simple', ${q})` : sql``
	const after = cursor ? sql`where (r.sort_at, r.thread_id) < (${cursor.at}::timestamptz, ${cursor.threadId})` : sql``
	const hideTrash =
		opts.view === 'trash' || opts.view === 'junk'
			? sql``
			: sql`and coalesce(sf.special_use, '') not in ('trash', 'junk')`
	const rows = (await db.execute(sql`
		with scoped as (
			select m.* from messages m join folders f on f.id = m.folder_id
			where m.mailbox_id in ${sql`(${sql.join(
				opts.mailboxIds.map(id => sql`${id}`),
				sql`, `,
			)})`}
				and ${viewCondition(opts.view, opts.folderId)} ${search}
		),
		ranked as (
			select distinct on (thread_id) thread_id, mailbox_id, id, subject, snippet, from_name, from_address, date, sort_at, snoozed_until
			from scoped order by thread_id, sort_at desc
		)
		select r.*, agg.count, agg.unread, agg.starred, agg.has_attachments, agg.participants, agg.folder_ids
		from ranked r
		join lateral (
			select
				count(distinct coalesce(s.message_id, s.id))::int as count,
				coalesce(bool_or(not s.seen), false) as unread,
				coalesce(bool_or(s.flagged), false) as starred,
				coalesce(bool_or(s.has_attachments), false) as has_attachments,
				(select jsonb_agg(p) from (
					select distinct on (x.from_address) jsonb_build_object('name', x.from_name, 'address', x.from_address) as p, x.date
					from messages x where x.mailbox_id = r.mailbox_id and x.thread_id = r.thread_id
					order by x.from_address, x.date
				) ps) as participants,
				array_agg(distinct s.folder_id) as folder_ids
			from messages s join folders sf on sf.id = s.folder_id
			where s.mailbox_id = r.mailbox_id and s.thread_id = r.thread_id ${hideTrash}
		) agg on true
		${after}
		order by r.sort_at desc, r.thread_id desc
		limit ${opts.limit + 1}`)) as unknown as ThreadQueryRow[]

	const page = rows.slice(0, opts.limit)
	const last = page[page.length - 1]
	return {
		threads: page.map(r => ({
			threadId: r.thread_id,
			mailboxId: r.mailbox_id,
			messageId: r.id,
			subject: r.subject,
			snippet: r.snippet,
			from: { name: r.from_name, address: r.from_address },
			participants: r.participants ?? [],
			date: new Date(r.date).toISOString(),
			count: Math.max(1, r.count ?? 1),
			unread: r.unread,
			starred: r.starred,
			hasAttachments: r.has_attachments,
			snoozedUntil: r.snoozed_until ? new Date(r.snoozed_until).toISOString() : null,
			folderIds: r.folder_ids ?? [],
		})),
		next: rows.length > opts.limit && last ? encodeCursor(last.sort_at, last.thread_id) : null,
	}
}

function toMessage(m: MessageRow): Message {
	const cidUrl = (cid: string) => {
		const att = m.attachments.find(a => a.cid === cid)
		return att ? `/api/messages/${m.id}/attachments/${encodeURIComponent(att.partId)}?inline=1` : null
	}
	const source = m.htmlBody ?? (m.textBody ? `<div style="white-space:pre-wrap">${textToHtml(m.textBody)}</div>` : null)
	const clean = source ? sanitizeEmailHtml(source, cidUrl) : { html: null, hasRemoteImages: false }
	return {
		id: m.id,
		mailboxId: m.mailboxId,
		folderId: m.folderId,
		threadId: m.threadId,
		messageId: m.messageId,
		subject: m.subject,
		from: { name: m.fromName, address: m.fromAddress },
		to: m.to,
		cc: m.cc,
		bcc: m.bcc,
		replyTo: m.replyTo,
		date: m.date.toISOString(),
		snippet: m.snippet,
		html: clean.html,
		text: m.textBody,
		attachments: m.attachments,
		seen: m.seen,
		flagged: m.flagged,
		answered: m.answered,
		snoozedUntil: m.snoozedUntil?.toISOString() ?? null,
		references: m.references,
		listUnsubscribe: m.listUnsubscribe,
		hasRemoteImages: clean.hasRemoteImages,
	}
}

type Action =
	| 'read'
	| 'unread'
	| 'star'
	| 'unstar'
	| 'archive'
	| 'trash'
	| 'spam'
	| 'notspam'
	| 'inbox'
	| 'move'
	| 'snooze'
	| 'unsnooze'
	| 'delete'

const placeholderUid = () => -Math.floor(Math.random() * 2 ** 46) - 1

/** Applies an action to whole threads: our copy changes right away, the IMAP side through pending_ops. */
async function applyThreadAction(
	mailboxIds: string[],
	threadIds: string[],
	action: Action,
	opts: { folderId?: string; until?: string },
) {
	if (!threadIds.length) return
	const rows = await db
		.select({ m: schema.messages, special: schema.folders.specialUse })
		.from(schema.messages)
		.innerJoin(schema.folders, eq(schema.folders.id, schema.messages.folderId))
		.where(and(inArray(schema.messages.threadId, threadIds), inArray(schema.messages.mailboxId, mailboxIds)))
	if (!rows.length) throw notFound('Nothing to change')
	const folders = await db
		.select()
		.from(schema.folders)
		.where(inArray(schema.folders.mailboxId, [...new Set(rows.map(r => r.m.mailboxId))]))
	const special = (mailboxId: string, use: SpecialUse) =>
		folders.find(f => f.mailboxId === mailboxId && f.specialUse === use) ??
		(use === 'archive' ? folders.find(f => f.mailboxId === mailboxId && f.specialUse === 'all') : undefined)

	const ops: (typeof schema.pendingOps.$inferInsert)[] = []
	const touched = new Set<string>()
	const live = rows.filter(r => r.m.uid > 0)
	const byFolder = (list: typeof rows) => {
		const groups = new Map<string, MessageRow[]>()
		for (const r of list) groups.set(r.m.folderId, [...(groups.get(r.m.folderId) ?? []), r.m])
		return groups
	}

	const flagOp = async (list: typeof rows, column: 'seen' | 'flagged', value: boolean, flag: string) => {
		const changing = list.filter(r => r.m[column] !== value)
		if (!changing.length) return
		await db
			.update(schema.messages)
			.set({ [column]: value })
			.where(
				inArray(
					schema.messages.id,
					changing.map(r => r.m.id),
				),
			)
		for (const [folderId, msgs] of byFolder(changing.filter(r => r.m.uid > 0))) {
			ops.push({
				mailboxId: msgs[0]!.mailboxId,
				kind: 'flags',
				payload: { folderId, uids: msgs.map(m => m.uid), ...(value ? { add: [flag] } : { remove: [flag] }) },
			})
		}
		for (const r of changing) touched.add(r.m.mailboxId)
	}

	const moveOp = async (
		list: typeof rows,
		target: (mailboxId: string) => { id?: string; special?: 'archive' | 'trash' | 'junk' },
	) => {
		for (const [folderId, msgs] of byFolder(list.filter(r => r.m.uid > 0))) {
			const mailboxId = msgs[0]!.mailboxId
			const dest = target(mailboxId)
			if (dest.id === folderId) continue
			const uids = msgs.map(m => m.uid)
			if (dest.id) {
				// Optimistic: shows in the target right away under a placeholder uid until the server answers
				for (const m of msgs)
					await db
						.update(schema.messages)
						.set({ folderId: dest.id, uid: placeholderUid(), snoozedUntil: null })
						.where(eq(schema.messages.id, m.id))
			}
			ops.push({
				mailboxId,
				kind: 'move',
				payload: {
					folderId,
					uids,
					messageIds: msgs.map(m => m.id),
					targetFolderId: dest.id,
					targetSpecial: dest.id ? undefined : dest.special,
				},
			})
			touched.add(mailboxId)
		}
	}

	switch (action) {
		case 'read':
			await flagOp(live, 'seen', true, '\\Seen')
			break
		case 'unread':
			await flagOp(live, 'seen', false, '\\Seen')
			break
		case 'star': {
			// Star the newest message of each thread, like Gmail
			const newest = new Map<string, (typeof rows)[number]>()
			for (const r of live) {
				const cur = newest.get(r.m.threadId)
				if (!cur || r.m.date > cur.m.date) newest.set(r.m.threadId, r)
			}
			await flagOp([...newest.values()], 'flagged', true, '\\Flagged')
			break
		}
		case 'unstar':
			await flagOp(live, 'flagged', false, '\\Flagged')
			break
		case 'archive':
			await moveOp(
				live.filter(r => r.special === 'inbox'),
				mb => ({ id: special(mb, 'archive')?.id, special: 'archive' }),
			)
			break
		case 'trash':
			await moveOp(
				live.filter(r => r.special !== 'trash' && r.special !== 'all' && r.special !== 'flagged'),
				mb => ({
					id: special(mb, 'trash')?.id,
					special: 'trash',
				}),
			)
			break
		case 'spam':
			await moveOp(
				live.filter(r => r.special === 'inbox'),
				mb => ({ id: special(mb, 'junk')?.id, special: 'junk' }),
			)
			break
		case 'notspam':
		case 'inbox': {
			const from = action === 'notspam' ? ['junk'] : ['trash', 'junk', 'archive', 'all']
			const list = live.filter(r => r.special && from.includes(r.special))
			await moveOp(list, mb => ({ id: special(mb, 'inbox')?.id }))
			break
		}
		case 'move': {
			const target = folders.find(f => f.id === opts.folderId)
			if (!target) throw badRequest('Pick a folder')
			await moveOp(
				live.filter(r => r.m.mailboxId === target.mailboxId && r.special !== 'sent' && r.special !== 'all'),
				() => ({ id: target.id }),
			)
			break
		}
		case 'delete': {
			const list = live.filter(r => r.special === 'trash' || r.special === 'junk')
			for (const [folderId, msgs] of byFolder(list)) {
				ops.push({
					mailboxId: msgs[0]!.mailboxId,
					kind: 'delete',
					payload: { folderId, uids: msgs.map(m => m.uid), messageIds: msgs.map(m => m.id) },
				})
				touched.add(msgs[0]!.mailboxId)
			}
			// Gone from our copy right away; the op carries the uids the server needs
			if (list.length)
				await db.delete(schema.messages).where(
					inArray(
						schema.messages.id,
						list.map(r => r.m.id),
					),
				)
			break
		}
		case 'snooze': {
			const until = opts.until ? new Date(opts.until) : null
			if (!until || Number.isNaN(until.getTime()) || until.getTime() < Date.now() + 60_000)
				throw badRequest('Pick a time in the future')
			const inbox = rows.filter(r => r.special === 'inbox')
			if (inbox.length)
				await db
					.update(schema.messages)
					.set({ snoozedUntil: until, sortAt: until })
					.where(
						inArray(
							schema.messages.id,
							inbox.map(r => r.m.id),
						),
					)
			for (const r of inbox) touched.add(r.m.mailboxId)
			break
		}
		case 'unsnooze': {
			const snoozed = rows.filter(r => r.m.snoozedUntil)
			if (snoozed.length)
				await db
					.update(schema.messages)
					.set({ snoozedUntil: null, sortAt: sql`${schema.messages.date}` })
					.where(
						inArray(
							schema.messages.id,
							snoozed.map(r => r.m.id),
						),
					)
			for (const r of snoozed) touched.add(r.m.mailboxId)
			break
		}
	}

	if (ops.length) await db.insert(schema.pendingOps).values(ops)
	for (const mailboxId of touched) {
		if (ops.some(o => o.mailboxId === mailboxId)) await sendCommand({ type: 'ops', mailboxId })
		await publishEvent({ type: 'messages', mailboxId, folderId: '' })
	}
}

async function openForDownload(user: Parameters<typeof accessibleMailboxIds>[0], messageId: string) {
	const [m] = await db.select().from(schema.messages).where(eq(schema.messages.id, messageId))
	if (!m) throw notFound('Message not found')
	await assertMailboxAccess(user, m.mailboxId)
	if (m.uid < 0) throw new HttpError(409, 'This message is being moved. Try again in a moment.')
	const [folder] = await db.select().from(schema.folders).where(eq(schema.folders.id, m.folderId))
	const [mailbox] = await db.select().from(schema.mailboxes).where(eq(schema.mailboxes.id, m.mailboxId))
	if (!folder || !mailbox) throw notFound('Message not found')
	const client = imapClient(settingsOf(mailbox), `${mailbox.address}:download`)
	try {
		await client.connect()
		await client.mailboxOpen(folder.path, { readOnly: true })
	} catch (err) {
		client.close()
		throw new HttpError(503, describeConnectionError(err))
	}
	return { m, client }
}

const contentDisposition = (kind: 'inline' | 'attachment', filename: string) =>
	`${kind}; filename="${filename.replace(/[^\x20-\x7e]|"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename)}`

export const mailRoutes = new Elysia()
	.use(authed)
	.get('/bootstrap', async ({ user }) => bootstrap(user))

	.get(
		'/threads',
		async ({ user, query }) => {
			const all = await accessibleMailboxIds(user)
			let mailboxIds = all
			if (query.mailboxId) mailboxIds = all.filter(id => id === query.mailboxId)
			else if (query.projectId) {
				const inProject = await db
					.select({ id: schema.mailboxes.id })
					.from(schema.mailboxes)
					.where(eq(schema.mailboxes.projectId, query.projectId))
				const set = new Set(inProject.map(r => r.id))
				mailboxIds = all.filter(id => set.has(id))
			}
			let view: View | 'folder' = (query.view as View) ?? 'inbox'
			if (query.folderId) {
				const [folder] = await db.select().from(schema.folders).where(eq(schema.folders.id, query.folderId))
				if (!folder || !all.includes(folder.mailboxId)) throw notFound('Folder not found')
				mailboxIds = [folder.mailboxId]
				view = 'folder'
			} else if (!VIEWS.includes(view as View)) throw badRequest('Unknown view')
			return listThreads({
				mailboxIds,
				view,
				folderId: query.folderId,
				q: query.q,
				cursor: query.cursor,
				limit: Math.min(Number(query.limit ?? 50), 100),
			})
		},
		{
			query: t.Object({
				view: t.Optional(t.String()),
				mailboxId: t.Optional(t.String()),
				projectId: t.Optional(t.String()),
				folderId: t.Optional(t.String()),
				q: t.Optional(t.String({ maxLength: 300 })),
				cursor: t.Optional(t.String()),
				limit: t.Optional(t.String()),
			}),
		},
	)

	.get('/threads/:threadId', async ({ user, params }) => {
		const ids = await accessibleMailboxIds(user)
		if (!ids.length) throw notFound('Conversation not found')
		const rows = await db
			.select({ m: schema.messages, special: schema.folders.specialUse })
			.from(schema.messages)
			.innerJoin(schema.folders, eq(schema.folders.id, schema.messages.folderId))
			.where(and(eq(schema.messages.threadId, params.threadId), inArray(schema.messages.mailboxId, ids)))
		if (!rows.length) throw notFound('Conversation not found')
		// The same message can sit in several folders (Gmail labels, All Mail): show it once
		const rank = (s: string | null) => (s === 'all' || s === 'flagged' ? 2 : s === 'trash' ? 1 : 0)
		const unique = new Map<string, (typeof rows)[number]>()
		for (const r of rows.sort((a, b) => rank(a.special) - rank(b.special))) {
			const key = r.m.messageId ?? r.m.id
			const kept = unique.get(key)
			if (!kept) unique.set(key, { ...r, m: { ...r.m } })
			// Flags count across every copy, like the list does: one unread copy (say in the inbox, while the
			// shown copy is the read one in Sent) keeps the message unread, so opening it marks it read
			else {
				kept.m.seen &&= r.m.seen
				kept.m.flagged ||= r.m.flagged
				kept.m.answered ||= r.m.answered
			}
		}
		const messages = [...unique.values()].map(r => r.m).sort((a, b) => a.date.getTime() - b.date.getTime())
		return {
			threadId: params.threadId,
			mailboxId: messages[0]!.mailboxId,
			subject: messages[0]!.subject,
			messages: messages.map(toMessage),
		}
	})

	.post(
		'/threads/actions',
		async ({ user, body }) => {
			const ids = await accessibleMailboxIds(user)
			await applyThreadAction(ids, body.threadIds, body.action as Action, {
				folderId: body.folderId,
				until: body.until,
			})
			return { ok: true }
		},
		{
			body: t.Object({
				threadIds: t.Array(t.String(), { minItems: 1, maxItems: 500 }),
				action: t.Union(
					[
						'read',
						'unread',
						'star',
						'unstar',
						'archive',
						'trash',
						'spam',
						'notspam',
						'inbox',
						'move',
						'snooze',
						'unsnooze',
						'delete',
					].map(a => t.Literal(a)),
				),
				folderId: t.Optional(t.String()),
				until: t.Optional(t.String()),
			}),
		},
	)

	.get(
		'/messages/:id/attachments/:partId',
		async ({ user, params, query }) => {
			const { m, client } = await openForDownload(user, params.id)
			const att = m.attachments.find(a => a.partId === params.partId)
			if (!att) {
				client.close()
				throw notFound('Attachment not found')
			}
			const dl = await client.download(String(m.uid), att.partId, { uid: true })
			if (!dl.content) {
				client.close()
				throw notFound('Attachment not found on the server')
			}
			// Only images (not SVG, which can carry script) are shown inline; everything else downloads
			const inline = query.inline === '1' && att.contentType.startsWith('image/') && att.contentType !== 'image/svg+xml'
			const stream = dl.content
			stream.on('end', () => void client.logout().catch(() => client.close()))
			stream.on('error', () => client.close())
			return new Response(stream as unknown as ReadableStream, {
				headers: {
					'content-type': inline ? att.contentType : 'application/octet-stream',
					'content-disposition': contentDisposition(inline ? 'inline' : 'attachment', att.filename),
					'x-content-type-options': 'nosniff',
					'content-security-policy': "default-src 'none'; sandbox",
					'cache-control': 'private, max-age=86400',
				},
			})
		},
		{ query: t.Object({ inline: t.Optional(t.String()) }) },
	)

	.get('/messages/:id/raw', async ({ user, params }) => {
		const { m, client } = await openForDownload(user, params.id)
		const dl = await client.download(String(m.uid), undefined, { uid: true })
		if (!dl.content) {
			client.close()
			throw notFound('Message not found on the server')
		}
		dl.content.on('end', () => void client.logout().catch(() => client.close()))
		const name = `${(m.subject || 'message').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80)}.eml`
		return new Response(dl.content as unknown as ReadableStream, {
			headers: {
				'content-type': 'message/rfc822',
				'content-disposition': contentDisposition('attachment', name),
				'x-content-type-options': 'nosniff',
			},
		})
	})

	.get(
		'/contacts',
		async ({ user, query }) => {
			const ids = await accessibleMailboxIds(user)
			const q = (query.q ?? '').trim().toLowerCase()
			if (!ids.length || q.length < 1) return { contacts: [] }
			const like = `%${q.replace(/[%_\\]/g, m => `\\${m}`)}%`
			const list = sql.join(
				ids.map(id => sql`${id}`),
				sql`, `,
			)
			const rows = (await db.execute(sql`
				select address, (array_agg(name order by length(name) desc))[1] as name, count(*)::int as count from (
					select from_name as name, from_address as address from messages
					where mailbox_id in (${list}) and (from_address ilike ${like} or from_name ilike ${like})
					union all
					select coalesce(e->>'name', ''), lower(e->>'address') from messages m
					join folders f on f.id = m.folder_id, jsonb_array_elements(m.to || m.cc) e
					where f.special_use = 'sent' and m.mailbox_id in (${list})
						and ((e->>'address') ilike ${like} or (e->>'name') ilike ${like})
				) x where address <> '' and address not like '%noreply%' and address not like '%no-reply%'
				group by address order by count(*) desc limit 8`)) as unknown as {
				address: string
				name: string
				count: number
			}[]
			return { contacts: rows }
		},
		{ query: t.Object({ q: t.Optional(t.String({ maxLength: 200 })) }) },
	)

	.put(
		'/mailboxes/:id/signature',
		async ({ user, params, body }) => {
			await assertMailboxAccess(user, params.id)
			if (body.html === null) {
				await db
					.delete(schema.signatures)
					.where(and(eq(schema.signatures.userId, user.id), eq(schema.signatures.mailboxId, params.id)))
			} else {
				await db
					.insert(schema.signatures)
					.values({ userId: user.id, mailboxId: params.id, html: body.html })
					.onConflictDoUpdate({
						target: [schema.signatures.userId, schema.signatures.mailboxId],
						set: { html: body.html },
					})
			}
			return { ok: true }
		},
		{ body: t.Object({ html: t.Union([t.String({ maxLength: 50_000 }), t.Null()]) }) },
	)
