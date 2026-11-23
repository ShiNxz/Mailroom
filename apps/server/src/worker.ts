// The worker: keeps every mailbox in sync over IMAP (IDLE push + history backfill), applies changes
// made in the app, sends the outbox (scheduled and undo-able sends) and re-checks domain health.
// Exactly one runs: a Postgres advisory lock makes a second copy (e.g. during a deploy) wait.

import { and, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm'
import { db, runMigrations, schema, sqlClient } from './db'
import { env } from './env'
import { checkDomain } from './health/dns'
import { errorMessage, log } from './lib/log'
import { COMMANDS_CHANNEL, publishEvent, subscribe, type WorkerCommand } from './lib/redis'
import { failInterrupted, processOutbox } from './mail/send'
import { MailboxSync } from './mail/sync'

const syncers = new Map<string, MailboxSync>()
let shuttingDown = false

// Health endpoint for the container health check, up before the lock so a waiting worker is healthy
const server = Bun.serve({
	port: env.port,
	fetch: req => {
		const url = new URL(req.url)
		if (url.pathname === '/health') return Response.json({ ok: true, leader, mailboxes: syncers.size })
		return new Response('Not found', { status: 404 })
	},
})
let leader = false

await runMigrations()

const lockConnection = await sqlClient.reserve()
for (;;) {
	const [row] = await lockConnection`select pg_try_advisory_lock(727002) as locked`
	if (row?.locked) break
	log.info('another worker holds the lock, waiting')
	await Bun.sleep(5000)
}
leader = true
log.info('worker started', { port: server.port })

await failInterrupted()

async function startMailbox(id: string) {
	await stopMailbox(id)
	const [mailbox] = await db.select().from(schema.mailboxes).where(eq(schema.mailboxes.id, id))
	if (!mailbox) return
	if (!mailbox.enabled) {
		await db.update(schema.mailboxes).set({ status: 'paused', statusMessage: null }).where(eq(schema.mailboxes.id, id))
		await publishEvent({ type: 'mailbox', mailboxId: id, status: 'paused', statusMessage: null })
		return
	}
	const sync = new MailboxSync(mailbox)
	syncers.set(id, sync)
	sync.start()
}

async function stopMailbox(id: string) {
	const sync = syncers.get(id)
	if (!sync) return
	syncers.delete(id)
	await sync.stop()
}

for (const m of await db.select({ id: schema.mailboxes.id }).from(schema.mailboxes)) await startMailbox(m.id)

// --- Commands from the API -----------------------------------------------------------------------

let outboxRunning = false
let outboxAgain = false
async function runOutbox() {
	if (outboxRunning) {
		outboxAgain = true
		return
	}
	outboxRunning = true
	try {
		do {
			outboxAgain = false
			await processOutbox(syncers)
		} while (outboxAgain)
	} catch (err) {
		log.error('outbox failed', { err: errorMessage(err) })
	} finally {
		outboxRunning = false
	}
}

subscribe<WorkerCommand>(COMMANDS_CHANNEL, command => {
	switch (command.type) {
		case 'ops':
			syncers.get(command.mailboxId)?.poke('ops')
			break
		case 'resync':
			syncers.get(command.mailboxId)?.poke('full')
			break
		case 'outbox':
			void runOutbox()
			break
		case 'mailbox-changed':
			void startMailbox(command.mailboxId)
			break
		case 'mailbox-removed':
			void stopMailbox(command.mailboxId)
			break
	}
})

// The outbox is also polled, so scheduled sends go out on time without any poke
setInterval(() => void runOutbox(), 3000)

// --- Domain health and cleanup ---------------------------------------------------------------------

async function recheckDomains() {
	const stale = await db
		.select()
		.from(schema.domains)
		.where(sql`${schema.domains.checkedAt} is null or ${schema.domains.checkedAt} < now() - interval '12 hours'`)
	for (const d of stale) {
		try {
			const sending = await db
				.select({ host: schema.mailboxes.smtpHost })
				.from(schema.mailboxes)
				.where(eq(schema.mailboxes.domainId, d.id))
			const health = await checkDomain(d.name, {
				dkimSelectors: d.dkimSelectors,
				sendingHosts: [...new Set(sending.map(s => s.host))],
			})
			await db.update(schema.domains).set({ health, checkedAt: new Date() }).where(eq(schema.domains.id, d.id))
		} catch (err) {
			log.warn('domain check failed', { domain: d.name, err: errorMessage(err) })
		}
	}
}

async function cleanup() {
	const day = 86400_000
	await db.delete(schema.sessions).where(lt(schema.sessions.expiresAt, new Date()))
	// Uploads not attached to anything waiting to send
	await db.execute(sql`
		delete from uploads u where u.created_at < now() - interval '2 days'
		and not exists (select 1 from outbox o where o.status in ('queued', 'sending') and o.payload->'attachmentIds' ? u.id)
		and not exists (select 1 from drafts d where d.payload->'attachmentIds' ? u.id)`)
	await db
		.delete(schema.outbox)
		.where(
			and(
				inArray(schema.outbox.status, ['sent', 'cancelled']),
				lt(schema.outbox.createdAt, new Date(Date.now() - 30 * day)),
			),
		)
	// Snoozes that ended: clear them so the thread is a normal one again (sort_at keeps it on top)
	await db
		.update(schema.messages)
		.set({ snoozedUntil: null })
		.where(and(isNotNull(schema.messages.snoozedUntil), lt(schema.messages.snoozedUntil, new Date())))
}

setInterval(() => void recheckDomains(), 30 * 60_000)
setInterval(() => void cleanup().catch(err => log.warn('cleanup failed', { err: errorMessage(err) })), 15 * 60_000)
void recheckDomains()
void runOutbox()

// --- Shutdown --------------------------------------------------------------------------------------

async function shutdown(signal: string) {
	if (shuttingDown) return
	shuttingDown = true
	log.info('stopping', { signal })
	await Promise.race([Promise.all([...syncers.keys()].map(stopMailbox)), Bun.sleep(8000)])
	lockConnection.release()
	server.stop()
	process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
