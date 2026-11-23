import { and, eq, inArray, ne } from 'drizzle-orm'
import type { FetchMessageObject } from 'imapflow'
import { simpleParser } from 'mailparser'
import { db, schema } from '../db'
import { shortHash } from '../lib/ids'
import { addresses, htmlToText, messageIdsIn, parseHeaders, snippetOf, walkStructure } from './parse'

export type MessageInsert = typeof schema.messages.$inferInsert

const MAX_HTML = 2 * 1024 * 1024
const MAX_TEXT = 512 * 1024

export interface Bodies {
	text: string
	html: string | null
}

/** Text and HTML from a full message source (used for messages small enough to fetch whole). */
export async function bodiesFromSource(source: Buffer): Promise<Bodies> {
	const parsed = await simpleParser(source, {
		skipHtmlToText: true,
		skipTextToHtml: true,
		skipImageLinks: true,
		keepCidLinks: true,
		maxHtmlLengthToParse: MAX_HTML,
	})
	const html = typeof parsed.html === 'string' ? parsed.html.slice(0, MAX_HTML) : null
	const text = (parsed.text ?? '').slice(0, MAX_TEXT)
	return { html, text }
}

/** The row for one fetched message. Thread ids are filled in by insertMessages. */
export function messageRow(
	mailboxId: string,
	folderId: string,
	msg: FetchMessageObject,
	bodies: Bodies,
): Omit<MessageInsert, 'threadId'> & { threadId?: string } {
	const env = msg.envelope ?? {}
	const headers = parseHeaders(msg.headers)
	const structure = walkStructure(msg.bodyStructure)
	const from = addresses(env.from)[0] ?? addresses(env.sender)[0] ?? { name: '', address: '' }
	const text = bodies.text || (bodies.html ? htmlToText(bodies.html).slice(0, MAX_TEXT) : '')
	const flags = msg.flags ?? new Set<string>()
	let date = env.date ? new Date(env.date) : msg.internalDate ? new Date(msg.internalDate) : new Date()
	if (Number.isNaN(date.getTime()) || date.getTime() > Date.now() + 2 * 86400_000) {
		date = msg.internalDate ? new Date(msg.internalDate) : new Date()
	}
	const references = messageIdsIn(headers.references).slice(-50)
	const inReplyTo = messageIdsIn(env.inReplyTo ?? headers['in-reply-to'])[0] ?? null
	const visibleAttachments = structure.attachments.filter(
		a => !(a.inline && a.cid && bodies.html?.includes(`cid:${a.cid}`)),
	)
	return {
		mailboxId,
		folderId,
		uid: msg.uid,
		messageId: env.messageId?.trim() || null,
		inReplyTo,
		references,
		subject: (env.subject ?? '').slice(0, 1000),
		fromName: from.name,
		fromAddress: from.address,
		to: addresses(env.to),
		cc: addresses(env.cc),
		bcc: addresses(env.bcc),
		replyTo: addresses(env.replyTo),
		date,
		sortAt: date,
		snippet: snippetOf(text),
		textBody: text.replaceAll('\u0000', ''),
		htmlBody: bodies.html?.replaceAll('\u0000', '') ?? null,
		attachments: structure.attachments,
		hasAttachments: visibleAttachments.length > 0,
		listUnsubscribe: headers['list-unsubscribe']?.slice(0, 2000) ?? null,
		seen: flags.has('\\Seen'),
		flagged: flags.has('\\Flagged'),
		answered: flags.has('\\Answered'),
		draft: flags.has('\\Draft'),
		size: msg.size ?? 0,
	}
}

/** Thread key: the first Message-ID in References (the thread root), else In-Reply-To, else its own. */
const rootKey = (
	mailboxId: string,
	m: Pick<MessageInsert, 'references' | 'inReplyTo' | 'messageId' | 'folderId' | 'uid'>,
) => shortHash(`${mailboxId}|${m.references?.[0] ?? m.inReplyTo ?? m.messageId ?? `${m.folderId}:${m.uid}`}`)

/**
 * Inserts messages with thread ids. A message joins the thread of any message it references that we
 * already have; otherwise it is keyed by its thread root, which gives the same id whatever order the
 * messages of a thread arrive in (the history backfill goes newest first).
 */
export async function insertMessages(mailboxId: string, rows: Omit<MessageInsert, 'threadId'>[]) {
	if (!rows.length) return []
	const candidates = [
		...new Set(rows.flatMap(r => [...(r.references ?? []), r.inReplyTo].filter((v): v is string => !!v))),
	]
	const known = new Map<string, string>()
	if (candidates.length) {
		const existing = await db
			.select({ messageId: schema.messages.messageId, threadId: schema.messages.threadId })
			.from(schema.messages)
			.where(and(eq(schema.messages.mailboxId, mailboxId), inArray(schema.messages.messageId, candidates)))
		for (const e of existing) if (e.messageId) known.set(e.messageId, e.threadId)
	}
	const sorted = [...rows].sort((a, b) => (a.date as Date).getTime() - (b.date as Date).getTime())
	const values: MessageInsert[] = []
	for (const r of sorted) {
		const refs = [...(r.references ?? []), r.inReplyTo].filter((v): v is string => !!v)
		const joined = refs.map(id => known.get(id)).find(Boolean)
		const threadId = joined ?? rootKey(mailboxId, r)
		if (r.messageId && !known.has(r.messageId)) known.set(r.messageId, threadId)
		values.push({ ...r, threadId })
	}
	const inserted: { id: string; threadId: string; messageId: string | null }[] = []
	for (let i = 0; i < values.length; i += 200) {
		const chunk = values.slice(i, i + 200)
		const res = await db
			.insert(schema.messages)
			.values(chunk)
			.onConflictDoNothing({ target: [schema.messages.folderId, schema.messages.uid] })
			.returning({ id: schema.messages.id, threadId: schema.messages.threadId, messageId: schema.messages.messageId })
		inserted.push(...res)
	}
	// Replies that arrived before this message and only had its id in In-Reply-To were keyed by it:
	// move them into this message's thread.
	for (const m of inserted) {
		if (!m.messageId) continue
		const keyedByThis = shortHash(`${mailboxId}|${m.messageId}`)
		if (keyedByThis === m.threadId) continue
		await db
			.update(schema.messages)
			.set({ threadId: m.threadId })
			.where(
				and(
					eq(schema.messages.mailboxId, mailboxId),
					eq(schema.messages.threadId, keyedByThis),
					ne(schema.messages.threadId, m.threadId),
				),
			)
	}
	return inserted
}
