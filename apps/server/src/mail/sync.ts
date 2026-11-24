import type { Address, MailboxStatus, SpecialUse } from '@mailroom/shared'
import { and, asc, count, eq, gte, inArray, notInArray, sql } from 'drizzle-orm'
import type { FetchMessageObject, FetchQueryObject, ImapFlow, MailboxObject } from 'imapflow'
import { db, schema } from '../db'
import { errorMessage, log } from '../lib/log'
import { publishEvent } from '../lib/redis'
import { describeConnectionError, imapClient, type MailboxRow, settingsOf } from './connect'
import { walkStructure } from './parse'
import { bodiesFromSource, insertMessages, messageRow } from './store'

type FolderRow = typeof schema.folders.$inferSelect

const SPECIAL: Record<string, SpecialUse> = {
	'\\Inbox': 'inbox',
	'\\Sent': 'sent',
	'\\Drafts': 'drafts',
	'\\Trash': 'trash',
	'\\Junk': 'junk',
	'\\Archive': 'archive',
	'\\All': 'all',
	'\\Flagged': 'flagged',
}

// Backfill order: what people look for first. Gmail's All Mail and Starred hold copies of everything else.
const PRIORITY: Record<string, number> = { inbox: 0, sent: 1, archive: 2, drafts: 3, all: 6, junk: 7, trash: 8 }
const priorityOf = (f: FolderRow) => (f.specialUse ? (PRIORITY[f.specialUse] ?? 4) : 4)

const FIRST_PAGE = 60 // newest messages fetched when a folder is first seen, so it is usable right away
const BACKFILL_BATCH = 100
const SMALL_MESSAGE = 300 * 1024 // fetched whole and parsed; larger ones get their text parts downloaded
const FULL_SYNC_MS = 5 * 60_000
const INBOX_CHECK_MS = 60_000
const FOLDER_LIST_MS = 30 * 60_000
const FETCH_QUERY: FetchQueryObject = {
	uid: true,
	flags: true,
	envelope: true,
	bodyStructure: true,
	size: true,
	internalDate: true,
	headers: ['references', 'in-reply-to', 'list-unsubscribe'],
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

type Task = { run: (client: ImapFlow) => Promise<unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void }

/**
 * Keeps one mailbox in sync. Two IMAP connections: `ops` runs everything in one loop (folder sync,
 * history backfill, app changes, appends), `watch` sits in IDLE on INBOX and wakes the loop the
 * moment new mail or flag changes arrive.
 */
export class MailboxSync {
	private ops: ImapFlow | null = null
	private watch: ImapFlow | null = null
	private stopped = false
	private wakeUp: (() => void) | null = null
	private dirty = new Set<string>()
	private opsPending = true
	private fullSyncRequested = true
	private lastFull = 0
	private lastInboxCheck = 0
	private lastFolderList = 0
	private tasks: Task[] = []
	private backfillQueues = new Map<string, number[]>()
	private status: MailboxStatus | null = null
	private readonly log
	private running: Promise<void> | null = null
	private watchRetry = 0

	constructor(public mailbox: MailboxRow) {
		this.log = log.child({ mailbox: mailbox.address })
	}

	start() {
		this.running ??= this.run()
	}

	async stop() {
		this.stopped = true
		this.wake()
		const close = async (c: ImapFlow | null) => {
			if (!c) return
			await Promise.race([c.logout().catch(() => {}), sleep(3000)])
			c.close()
		}
		await Promise.all([close(this.watch), close(this.ops)])
		for (const t of this.tasks.splice(0)) t.reject(new Error('Mailbox sync stopped'))
		await Promise.race([this.running, sleep(5000)])
	}

	/** Something changed in the app (pending_ops rows) or a resync was asked for. */
	poke(kind: 'ops' | 'full') {
		if (kind === 'ops') this.opsPending = true
		else this.fullSyncRequested = true
		this.wake()
	}

	/** Runs a job on the ops connection inside the sync loop (appending sent mail, downloads for forwards). */
	enqueue<T>(run: (client: ImapFlow) => Promise<T>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			this.tasks.push({ run, resolve: resolve as (v: unknown) => void, reject })
			this.wake()
		})
	}

	/** Saves a sent message to the Sent folder (creating one if the account has none). */
	appendSent(raw: Buffer) {
		return this.enqueue(async client => {
			const sent = await this.ensureSpecialFolder(client, 'sent')
			await client.append(sent.path, raw, ['\\Seen'], new Date())
			this.dirty.add(sent.id)
		})
	}

	/** Downloads attachments of a message, for forwarding them. */
	downloadParts(folderId: string, uid: number, partIds: string[]) {
		return this.enqueue(async client => {
			const [folder] = await db.select().from(schema.folders).where(eq(schema.folders.id, folderId))
			if (!folder || !partIds.length) return []
			const lock = await client.getMailboxLock(folder.path)
			try {
				const out: { partId: string; content: Buffer; filename?: string; contentType?: string }[] = []
				for (const partId of partIds) {
					const dl = await client.download(String(uid), partId, { uid: true, maxBytes: 50 * 1024 * 1024 })
					if (!dl.content) continue
					const chunks: Buffer[] = []
					for await (const chunk of dl.content) chunks.push(chunk as Buffer)
					out.push({
						partId,
						content: Buffer.concat(chunks),
						filename: dl.meta.filename,
						contentType: dl.meta.contentType,
					})
				}
				return out
			} finally {
				lock.release()
			}
		})
	}

	private wake() {
		const w = this.wakeUp
		this.wakeUp = null
		w?.()
	}

	private waitForWake(ms: number) {
		return new Promise<void>(resolve => {
			const timer = setTimeout(() => {
				this.wakeUp = null
				resolve()
			}, ms)
			this.wakeUp = () => {
				clearTimeout(timer)
				resolve()
			}
		})
	}

	private async setStatus(status: MailboxStatus, message: string | null = null) {
		if (this.status === status && status !== 'error') return
		this.status = status
		await db
			.update(schema.mailboxes)
			.set({ status, statusMessage: message, ...(status === 'idle' ? { lastSyncAt: new Date() } : {}) })
			.where(eq(schema.mailboxes.id, this.mailbox.id))
		await publishEvent({ type: 'mailbox', mailboxId: this.mailbox.id, status, statusMessage: message })
	}

	private async run() {
		let backoff = 5_000
		while (!this.stopped) {
			try {
				await this.setStatus('connecting')
				const client = imapClient(settingsOf(this.mailbox), `${this.mailbox.address}:ops`)
				client.on('error', err => this.log.warn('ops connection error', { err }))
				client.on('close', () => this.wake())
				await client.connect()
				this.ops = client
				backoff = 5_000
				this.log.info('connected')
				await this.setStatus('syncing')
				await this.refreshFolders(client)
				this.startWatcher()
				await this.loop(client)
			} catch (err) {
				if (this.stopped) break
				const message = describeConnectionError(err)
				this.log.warn('sync failed', { err, message })
				await this.setStatus('error', message).catch(() => {})
			}
			this.ops?.close()
			this.ops = null
			if (this.stopped) break
			await this.waitForWake(backoff)
			backoff = Math.min(backoff * 2, 10 * 60_000)
		}
	}

	private async loop(client: ImapFlow) {
		while (!this.stopped && client.usable) {
			const task = this.tasks.shift()
			if (task) {
				try {
					task.resolve(await task.run(client))
				} catch (err) {
					task.reject(err)
				}
				continue
			}
			if (this.opsPending) {
				this.opsPending = false
				await this.applyPendingOps(client)
				continue
			}
			const now = Date.now()
			if (now - this.lastFolderList > FOLDER_LIST_MS) {
				await this.refreshFolders(client)
				continue
			}
			if (this.fullSyncRequested || now - this.lastFull > FULL_SYNC_MS) {
				this.fullSyncRequested = false
				this.lastFull = now
				this.lastInboxCheck = now
				for (const folder of await this.syncableFolders()) await this.syncFolder(client, folder)
				continue
			}
			if (now - this.lastInboxCheck > INBOX_CHECK_MS) {
				this.lastInboxCheck = now
				const inbox = (await this.syncableFolders()).find(f => f.specialUse === 'inbox')
				if (inbox) this.dirty.add(inbox.id)
			}
			if (this.dirty.size) {
				const ids = [...this.dirty]
				this.dirty.clear()
				const folders = await db.select().from(schema.folders).where(inArray(schema.folders.id, ids))
				for (const folder of folders) await this.syncFolder(client, folder)
				continue
			}
			if (await this.backfillStep(client)) continue
			await this.setStatus('idle')
			await this.waitForWake(INBOX_CHECK_MS)
		}
	}

	// --- Watcher -------------------------------------------------------------------------------

	private startWatcher() {
		if (this.watch || this.stopped) return
		const client = imapClient(settingsOf(this.mailbox), `${this.mailbox.address}:watch`)
		this.watch = client
		const markInbox = async () => {
			const [inbox] = await db
				.select({ id: schema.folders.id })
				.from(schema.folders)
				.where(and(eq(schema.folders.mailboxId, this.mailbox.id), eq(schema.folders.specialUse, 'inbox')))
			if (inbox) {
				this.dirty.add(inbox.id)
				this.wake()
			}
		}
		client.on('exists', () => void markInbox())
		client.on('expunge', () => void markInbox())
		client.on('flags', () => void markInbox())
		client.on('error', err => this.log.warn('watch connection error', { err }))
		client.on('close', () => {
			if (this.watch === client) this.watch = null
			if (this.stopped) return
			// Reconnect with backoff; the 60 second inbox check covers the gap
			this.watchRetry = Math.min(this.watchRetry + 1, 8)
			setTimeout(() => this.startWatcher(), 2 ** this.watchRetry * 1000)
		})
		client
			.connect()
			.then(() => client.mailboxOpen('INBOX', { readOnly: true }))
			.then(() => {
				this.watchRetry = 0
				this.log.debug('watching INBOX')
			})
			.catch(err => {
				this.log.warn('watch failed', { err })
				client.close()
			})
	}

	// --- Folders -------------------------------------------------------------------------------

	private async syncableFolders() {
		const folders = await db.select().from(schema.folders).where(eq(schema.folders.mailboxId, this.mailbox.id))
		return folders.filter(f => f.specialUse !== 'flagged').sort((a, b) => priorityOf(a) - priorityOf(b))
	}

	private async refreshFolders(client: ImapFlow) {
		this.lastFolderList = Date.now()
		const list = await client.list()
		const existing = await db.select().from(schema.folders).where(eq(schema.folders.mailboxId, this.mailbox.id))
		const seen = new Set<string>()
		for (const entry of list) {
			if (entry.flags.has('\\Noselect') || entry.flags.has('\\NonExistent')) continue
			seen.add(entry.path)
			const specialUse = entry.specialUse
				? (SPECIAL[entry.specialUse] ?? null)
				: entry.path.toUpperCase() === 'INBOX'
					? 'inbox'
					: null
			const current = existing.find(f => f.path === entry.path)
			if (!current) {
				await db
					.insert(schema.folders)
					.values({
						mailboxId: this.mailbox.id,
						path: entry.path,
						name: entry.name,
						delimiter: entry.delimiter,
						specialUse,
					})
					.onConflictDoNothing()
			} else if (current.specialUse !== specialUse || current.name !== entry.name) {
				await db.update(schema.folders).set({ specialUse, name: entry.name }).where(eq(schema.folders.id, current.id))
			}
		}
		const gone = existing.filter(f => !seen.has(f.path)).map(f => f.id)
		if (gone.length) await db.delete(schema.folders).where(inArray(schema.folders.id, gone))
		await publishEvent({ type: 'folders', mailboxId: this.mailbox.id })
	}

	private async folderByPath(path: string) {
		const [f] = await db
			.select()
			.from(schema.folders)
			.where(and(eq(schema.folders.mailboxId, this.mailbox.id), eq(schema.folders.path, path)))
		return f
	}

	/** A folder with this special use, created on the server if the account has none (Archive, Trash, Junk). */
	private async ensureSpecialFolder(client: ImapFlow, use: 'archive' | 'trash' | 'junk' | 'sent'): Promise<FolderRow> {
		const folders = await this.syncableFolders()
		const found =
			folders.find(f => f.specialUse === use) ??
			(use === 'archive' ? folders.find(f => f.specialUse === 'all') : undefined)
		if (found) return found
		const name = { archive: 'Archive', trash: 'Trash', junk: 'Junk', sent: 'Sent' }[use]
		const delimiter = folders.find(f => f.specialUse === 'inbox')?.delimiter ?? '/'
		let path = name
		try {
			await client.mailboxCreate(path)
		} catch {
			// Some servers only allow folders under INBOX
			path = `INBOX${delimiter}${name}`
			await client.mailboxCreate(path).catch(() => {})
		}
		await client.mailboxSubscribe(path).catch(() => {})
		await this.refreshFolders(client)
		const created = await this.folderByPath(path)
		if (!created) throw new Error(`Could not create the ${name} folder`)
		if (created.specialUse !== use) {
			await db.update(schema.folders).set({ specialUse: use }).where(eq(schema.folders.id, created.id))
			created.specialUse = use
		}
		return created
	}

	// --- Folder sync ---------------------------------------------------------------------------

	private async syncFolder(client: ImapFlow, folder: FolderRow) {
		// Already selected: no new SELECT, so UIDNEXT is whatever it was when it was opened. EXISTS
		// updates arrive on their own, UIDNEXT doesn't, so look above the last UID instead of trusting it.
		const wasOpen = client.mailbox && (client.mailbox as MailboxObject).path === folder.path
		let lock: Awaited<ReturnType<ImapFlow['getMailboxLock']>>
		try {
			lock = await client.getMailboxLock(folder.path)
		} catch (err) {
			this.log.warn('cannot open folder', { folder: folder.path, err })
			return
		}
		try {
			if (wasOpen) await client.noop()
			const box = client.mailbox as MailboxObject
			const uidValidity = Number(box.uidValidity)
			let f = folder
			if (f.uidValidity !== null && f.uidValidity !== uidValidity) {
				this.log.info('uidvalidity changed, refetching folder', { folder: f.path })
				await db.delete(schema.messages).where(eq(schema.messages.folderId, f.id))
				this.backfillQueues.delete(f.id)
				const [reset] = await db
					.update(schema.folders)
					.set({ uidValidity, maxUid: 0, minUid: null, backfillDone: false, highestModseq: null })
					.where(eq(schema.folders.id, f.id))
					.returning()
				f = reset!
			} else if (f.uidValidity === null) {
				await db.update(schema.folders).set({ uidValidity }).where(eq(schema.folders.id, f.id))
			}

			let newMessages: { id: string }[] = []
			if (box.exists === 0) {
				await db.delete(schema.messages).where(eq(schema.messages.folderId, f.id))
				await db
					.update(schema.folders)
					.set({ total: 0, unread: 0, backfillDone: true, syncedAt: new Date() })
					.where(eq(schema.folders.id, f.id))
				return
			}

			if (f.maxUid === 0) {
				// First look at this folder: the newest page now, the rest through the backfill
				const from = Math.max(1, box.exists - FIRST_PAGE + 1)
				const fetched = await this.fetchMessages(client, f, `${from}:*`, false)
				newMessages = fetched.inserted
				const uids = fetched.uids
				await db
					.update(schema.folders)
					.set({
						maxUid: uids.length ? Math.max(...uids) : Math.max(0, box.uidNext - 1),
						minUid: uids.length ? Math.min(...uids) : null,
						backfillDone: from === 1,
					})
					.where(eq(schema.folders.id, f.id))
			} else if (box.uidNext > f.maxUid + 1 || wasOpen) {
				const fetched = await this.fetchMessages(client, f, `${f.maxUid + 1}:*`, true)
				newMessages = fetched.inserted
				const top = Math.max(f.maxUid, ...fetched.uids, box.uidNext - 1)
				await db.update(schema.folders).set({ maxUid: top }).where(eq(schema.folders.id, f.id))
			}

			await this.syncFlags(client, f, box)
			await this.removeExpunged(client, f)

			const unseen = await client.search({ seen: false }, { uid: true })
			await db
				.update(schema.folders)
				.set({ total: box.exists, unread: Array.isArray(unseen) ? unseen.length : 0, syncedAt: new Date() })
				.where(eq(schema.folders.id, f.id))

			if (newMessages.length || f.specialUse === 'inbox') {
				const newInbox =
					f.specialUse === 'inbox' && newMessages.length && f.maxUid > 0
						? await this.describeNew(newMessages.map(m => m.id))
						: undefined
				await publishEvent({ type: 'messages', mailboxId: this.mailbox.id, folderId: f.id, newInbox })
			}
		} finally {
			lock.release()
		}
	}

	private async describeNew(ids: string[]) {
		const rows = await db
			.select({
				id: schema.messages.id,
				fromName: schema.messages.fromName,
				fromAddress: schema.messages.fromAddress,
				subject: schema.messages.subject,
				seen: schema.messages.seen,
			})
			.from(schema.messages)
			.where(inArray(schema.messages.id, ids))
		return rows
			.filter(r => !r.seen)
			.slice(0, 5)
			.map(r => ({
				messageId: r.id,
				from: { name: r.fromName, address: r.fromAddress } as Address,
				subject: r.subject,
			}))
	}

	private async syncFlags(client: ImapFlow, f: FolderRow, box: MailboxObject) {
		const condstore = box.highestModseq !== undefined && !box.noModseq
		const updates: { uid: number; flags: Set<string> }[] = []
		if (condstore && f.highestModseq) {
			if (BigInt(f.highestModseq) >= (box.highestModseq as bigint)) return
			for await (const m of client.fetch(
				'1:*',
				{ uid: true, flags: true },
				{ uid: true, changedSince: BigInt(f.highestModseq) },
			))
				if (m.flags) updates.push({ uid: m.uid, flags: m.flags })
		} else {
			// Without CONDSTORE: the newest 500 messages, where flag changes almost always are
			const from = Math.max(1, box.exists - 499)
			for await (const m of client.fetch(`${from}:*`, { uid: true, flags: true }))
				if (m.flags) updates.push({ uid: m.uid, flags: m.flags })
		}
		if (condstore)
			await db
				.update(schema.folders)
				.set({ highestModseq: String(box.highestModseq) })
				.where(eq(schema.folders.id, f.id))
		if (!updates.length) return
		// One statement for the whole batch
		const values = updates.map(
			u =>
				sql`(${u.uid}::bigint, ${u.flags.has('\\Seen')}::boolean, ${u.flags.has('\\Flagged')}::boolean, ${u.flags.has('\\Answered')}::boolean)`,
		)
		for (let i = 0; i < values.length; i += 500) {
			await db.execute(sql`
				update messages m set seen = v.seen, flagged = v.flagged, answered = v.answered
				from (values ${sql.join(values.slice(i, i + 500), sql`, `)}) as v(uid, seen, flagged, answered)
				where m.folder_id = ${f.id} and m.uid = v.uid
					and (m.seen, m.flagged, m.answered) is distinct from (v.seen, v.flagged, v.answered)`)
		}
	}

	private async removeExpunged(client: ImapFlow, f: FolderRow) {
		const [{ local } = { local: 0 }] = await db
			.select({ local: count() })
			.from(schema.messages)
			.where(and(eq(schema.messages.folderId, f.id), gte(schema.messages.uid, 1)))
		if (!local) return
		const box = client.mailbox as MailboxObject
		// Every message we have is at or above minUid; the server count above it tells whether anything went
		const serverUids = await client.search({ uid: `${f.minUid ?? 1}:*` }, { uid: true })
		if (!Array.isArray(serverUids)) return
		if (serverUids.length >= local && box.exists >= local) return
		const keep = serverUids.length ? serverUids : [0]
		const removed = await db
			.delete(schema.messages)
			.where(
				and(eq(schema.messages.folderId, f.id), gte(schema.messages.uid, 1), notInArray(schema.messages.uid, keep)),
			)
			.returning({ id: schema.messages.id })
		if (removed.length) this.log.debug('expunged', { folder: f.path, count: removed.length })
	}

	/**
	 * Fetches messages in a range and stores them. Messages up to SMALL_MESSAGE are fetched whole in a
	 * second FETCH and parsed; larger ones get only their text and HTML parts downloaded.
	 */
	private async fetchMessages(client: ImapFlow, f: FolderRow, range: string, byUid: boolean) {
		const metas: FetchMessageObject[] = []
		for await (const m of client.fetch(range, FETCH_QUERY, { uid: byUid })) {
			// "n:*" returns the newest message even when n is above it
			if (byUid && f.maxUid && m.uid <= f.maxUid) continue
			metas.push(m)
		}
		return this.storeFetched(client, f, metas)
	}

	private async storeFetched(client: ImapFlow, f: FolderRow, metas: FetchMessageObject[]) {
		if (!metas.length) return { inserted: [] as { id: string }[], uids: [] as number[] }
		const small = metas.filter(m => (m.size ?? 0) <= SMALL_MESSAGE)
		const large = metas.filter(m => (m.size ?? 0) > SMALL_MESSAGE)
		const sources = new Map<number, Buffer>()
		for (let i = 0; i < small.length; i += 25) {
			const uids = small.slice(i, i + 25).map(m => m.uid)
			for await (const m of client.fetch(uids.join(','), { uid: true, source: true }, { uid: true }))
				if (m.source) sources.set(m.uid, m.source)
		}
		const rows = []
		for (const m of metas) {
			let bodies = { text: '', html: null as string | null }
			try {
				const source = sources.get(m.uid)
				if (source) bodies = await bodiesFromSource(source)
				else if (large.includes(m)) bodies = await this.downloadBodies(client, m)
			} catch (err) {
				this.log.warn('could not parse message', { folder: f.path, uid: m.uid, err: errorMessage(err) })
			}
			rows.push(messageRow(this.mailbox.id, f.id, m, bodies))
		}
		const inserted = await insertMessages(this.mailbox.id, rows)
		return { inserted, uids: metas.map(m => m.uid) }
	}

	private async downloadBodies(client: ImapFlow, m: FetchMessageObject) {
		const parts = walkStructure(m.bodyStructure)
		const read = async (part: string | undefined, max: number) => {
			if (!part) return null
			const dl = await client.download(String(m.uid), part, { uid: true, maxBytes: max })
			if (!dl.content) return null
			const chunks: Buffer[] = []
			for await (const chunk of dl.content) chunks.push(chunk as Buffer)
			return Buffer.concat(chunks).toString('utf8')
		}
		const html = await read(parts.html?.part, 2 * 1024 * 1024)
		const text = (await read(parts.text?.part, 512 * 1024)) ?? ''
		return { html, text }
	}

	// --- History backfill ----------------------------------------------------------------------

	/** One batch of older messages from the first folder that isn't done. False when everything is. */
	private async backfillStep(client: ImapFlow): Promise<boolean> {
		const folders = (await this.syncableFolders()).filter(f => !f.backfillDone && f.maxUid > 0)
		const f = folders[0]
		if (!f) return false
		await this.setStatus('syncing')
		let lock: Awaited<ReturnType<ImapFlow['getMailboxLock']>>
		try {
			lock = await client.getMailboxLock(f.path)
		} catch (err) {
			this.log.warn('cannot open folder for backfill', { folder: f.path, err })
			await db.update(schema.folders).set({ backfillDone: true }).where(eq(schema.folders.id, f.id))
			return true
		}
		try {
			let queue = this.backfillQueues.get(f.id)
			if (!queue) {
				const below = (f.minUid ?? 1) - 1
				const found = below >= 1 ? await client.search({ uid: `1:${below}` }, { uid: true }) : []
				queue = (Array.isArray(found) ? found : []).sort((a, b) => b - a)
				this.backfillQueues.set(f.id, queue)
			}
			const batch = queue.splice(0, BACKFILL_BATCH)
			if (batch.length) {
				const metas: FetchMessageObject[] = []
				for await (const m of client.fetch(batch.join(','), FETCH_QUERY, { uid: true })) metas.push(m)
				await this.storeFetched(client, f, metas)
			}
			const done = queue.length === 0
			await db
				.update(schema.folders)
				.set({ minUid: batch.length ? Math.min(...batch) : f.minUid, backfillDone: done })
				.where(eq(schema.folders.id, f.id))
			if (done) this.backfillQueues.delete(f.id)
			await publishEvent({ type: 'folders', mailboxId: this.mailbox.id })
			if (batch.length) await publishEvent({ type: 'messages', mailboxId: this.mailbox.id, folderId: f.id })
		} finally {
			lock.release()
		}
		return true
	}

	// --- Changes made in the app ----------------------------------------------------------------

	private async applyPendingOps(client: ImapFlow) {
		for (;;) {
			const ops = await db
				.select()
				.from(schema.pendingOps)
				.where(eq(schema.pendingOps.mailboxId, this.mailbox.id))
				.orderBy(asc(schema.pendingOps.id))
				.limit(50)
			if (!ops.length) return
			for (const op of ops) {
				try {
					await this.applyOp(client, op)
					await db.delete(schema.pendingOps).where(eq(schema.pendingOps.id, op.id))
				} catch (err) {
					const attempts = op.attempts + 1
					this.log.warn('change failed', { op: op.kind, attempts, err })
					if (attempts >= 5) {
						await this.revertOp(op)
						await db.delete(schema.pendingOps).where(eq(schema.pendingOps.id, op.id))
					} else {
						await db
							.update(schema.pendingOps)
							.set({ attempts, error: errorMessage(err) })
							.where(eq(schema.pendingOps.id, op.id))
						if (!client.usable) throw err
						this.opsPending = true
						return
					}
				}
			}
		}
	}

	private async applyOp(client: ImapFlow, op: typeof schema.pendingOps.$inferSelect) {
		const p = op.payload
		const [source] = await db.select().from(schema.folders).where(eq(schema.folders.id, p.folderId))
		if (!source || !p.uids.length) return
		let target: FolderRow | undefined
		if (op.kind === 'move') {
			if (p.targetFolderId)
				[target] = await db.select().from(schema.folders).where(eq(schema.folders.id, p.targetFolderId))
			if (!target && p.targetSpecial) target = await this.ensureSpecialFolder(client, p.targetSpecial)
			if (!target || target.id === source.id) return
		}
		const lock = await client.getMailboxLock(source.path)
		try {
			const range = p.uids.join(',')
			if (op.kind === 'flags') {
				if (p.add?.length) await client.messageFlagsAdd(range, p.add, { uid: true })
				if (p.remove?.length) await client.messageFlagsRemove(range, p.remove, { uid: true })
				return
			}
			if (op.kind === 'delete') {
				await client.messageDelete(range, { uid: true })
				if (p.messageIds?.length) await db.delete(schema.messages).where(inArray(schema.messages.id, p.messageIds))
				return
			}
			const result = await client.messageMove(range, target!.path, { uid: true })
			const uidMap = result ? result.uidMap : undefined
			// messageIds[i] is the message that had uids[i] in the source folder
			for (const [i, id] of (p.messageIds ?? []).entries()) {
				const oldUid = p.uids[i]
				const newUid = oldUid !== undefined ? uidMap?.get(oldUid) : undefined
				if (newUid) {
					await db
						.update(schema.messages)
						.set({ folderId: target!.id, uid: newUid })
						.where(eq(schema.messages.id, id))
						.catch(() => db.delete(schema.messages).where(eq(schema.messages.id, id)))
				} else {
					// No UIDPLUS: drop our copy, the target folder sync fetches it under its new uid
					await db.delete(schema.messages).where(eq(schema.messages.id, id))
				}
			}
			this.dirty.add(target!.id)
			this.dirty.add(source.id)
		} finally {
			lock.release()
		}
	}

	/** A change that kept failing: put our copy back the way the server has it. */
	private async revertOp(op: typeof schema.pendingOps.$inferSelect) {
		const p = op.payload
		if (op.kind === 'move' && p.messageIds?.length) {
			for (const [i, id] of p.messageIds.entries()) {
				const uid = p.uids[i]
				if (uid === undefined) continue
				await db
					.update(schema.messages)
					.set({ folderId: p.folderId, uid })
					.where(eq(schema.messages.id, id))
					.catch(() => {})
			}
		}
		this.fullSyncRequested = true
	}
}
