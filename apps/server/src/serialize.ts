import type { Domain, Folder, Mailbox, MailboxSettings, Project } from '@mailroom/shared'
import { and, count, eq, inArray, sql } from 'drizzle-orm'
import { accessibleMailboxIds, isAdmin } from './access'
import type { UserRow } from './auth'
import { db, schema } from './db'

type MailboxRow = typeof schema.mailboxes.$inferSelect
type DomainRow = typeof schema.domains.$inferSelect
type FolderRow = typeof schema.folders.$inferSelect

export const toDomain = (d: DomainRow): Domain => ({
	id: d.id,
	projectId: d.projectId,
	name: d.name,
	dkimSelectors: d.dkimSelectors,
	health: d.health,
	checkedAt: d.checkedAt?.toISOString() ?? null,
})

export const toMailboxSettings = (m: MailboxRow): MailboxSettings => ({
	address: m.address,
	displayName: m.displayName,
	username: m.username,
	imapHost: m.imapHost,
	imapPort: m.imapPort,
	imapSecurity: m.imapSecurity,
	smtpHost: m.smtpHost,
	smtpPort: m.smtpPort,
	smtpSecurity: m.smtpSecurity,
	saveSent: m.saveSent,
	signature: m.signature,
	enabled: m.enabled,
})

const toFolder = (f: FolderRow, synced: number): Folder => ({
	id: f.id,
	mailboxId: f.mailboxId,
	path: f.path,
	name: f.name,
	specialUse: f.specialUse,
	total: f.total,
	unread: f.unread,
	synced,
	backfillDone: f.backfillDone,
})

/** Everything the sidebar needs: projects with their mailboxes (and domains for admins) and every folder. */
export async function bootstrap(user: UserRow) {
	const mailboxIds = await accessibleMailboxIds(user)
	const admin = isAdmin(user)
	const mailboxRows = mailboxIds.length
		? await db.select().from(schema.mailboxes).where(inArray(schema.mailboxes.id, mailboxIds))
		: []

	let projectRows: (typeof schema.projects.$inferSelect)[]
	if (admin) projectRows = await db.select().from(schema.projects)
	else {
		const grants = await db
			.select({ projectId: schema.projectMembers.projectId })
			.from(schema.projectMembers)
			.where(eq(schema.projectMembers.userId, user.id))
		const ids = [...new Set([...grants.map(g => g.projectId), ...mailboxRows.map(m => m.projectId)])]
		projectRows = ids.length ? await db.select().from(schema.projects).where(inArray(schema.projects.id, ids)) : []
	}
	projectRows.sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))

	const domainRows = admin && projectRows.length ? await db.select().from(schema.domains) : []
	const folderRows = mailboxIds.length
		? await db.select().from(schema.folders).where(inArray(schema.folders.mailboxId, mailboxIds))
		: []
	const syncedCounts = mailboxIds.length
		? await db
				.select({ folderId: schema.messages.folderId, n: count() })
				.from(schema.messages)
				.where(inArray(schema.messages.mailboxId, mailboxIds))
				.groupBy(schema.messages.folderId)
		: []
	const synced = new Map(syncedCounts.map(r => [r.folderId, r.n]))
	const own = mailboxIds.length
		? await db
				.select()
				.from(schema.signatures)
				.where(and(eq(schema.signatures.userId, user.id), inArray(schema.signatures.mailboxId, mailboxIds)))
		: []
	const ownSig = new Map(own.map(s => [s.mailboxId, s.html]))

	const folders = folderRows.map(f => toFolder(f, synced.get(f.id) ?? 0))
	const toMailbox = (m: MailboxRow): Mailbox => {
		const mine = folders.filter(f => f.mailboxId === m.id && f.specialUse !== 'all' && f.specialUse !== 'flagged')
		return {
			id: m.id,
			projectId: m.projectId,
			domainId: m.domainId,
			address: m.address,
			displayName: m.displayName,
			status: m.status,
			statusMessage: m.statusMessage,
			lastSyncAt: m.lastSyncAt?.toISOString() ?? null,
			syncedCount: mine.reduce((s, f) => s + f.synced, 0),
			totalCount: mine.reduce((s, f) => s + f.total, 0),
			unread: mine.find(f => f.specialUse === 'inbox')?.unread ?? 0,
			signature: ownSig.get(m.id) ?? m.signature,
			defaultSignature: m.signature,
			enabled: m.enabled,
		}
	}

	const projects: Project[] = projectRows.map(p => ({
		id: p.id,
		name: p.name,
		color: p.color,
		description: p.description,
		domains: domainRows.filter(d => d.projectId === p.id).map(toDomain),
		mailboxes: mailboxRows
			.filter(m => m.projectId === p.id)
			.sort((a, b) => a.address.localeCompare(b.address))
			.map(toMailbox),
		canManage: admin,
	}))

	const [counts] = await db.execute<{ drafts: number; scheduled: number; failed: number }>(sql`
		select
			(select count(*)::int from drafts where user_id = ${user.id}) as drafts,
			(select count(*)::int from outbox where user_id = ${user.id} and status = 'queued' and send_at > now() + interval '1 minute') as scheduled,
			(select count(*)::int from outbox where user_id = ${user.id} and status = 'failed' and created_at > now() - interval '7 days') as failed`)

	return { projects, folders, counts: counts ?? { drafts: 0, scheduled: 0, failed: 0 } }
}
