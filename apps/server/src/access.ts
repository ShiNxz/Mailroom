import { isAdminRole } from '@mailroom/shared'
import { and, eq, inArray } from 'drizzle-orm'
import type { UserRow } from './auth'
import type { ScopedUser } from './context'
import { db, schema } from './db'
import { HttpError } from './lib/http'

// Who sees what:
// - owner and admin: every project and mailbox, and they manage projects, domains, mailboxes and users.
// - member: the projects they were added to. Per project either every mailbox in it (access 'all',
//   including mailboxes added later) or only the mailboxes picked for them (access 'selected').

export const isAdmin = (user: UserRow) => isAdminRole(user.role)

export function requireAdmin(user: UserRow) {
	if (!isAdmin(user)) throw new HttpError(403, 'Only admins can do that')
}

/**
 * Ids of every mailbox the user can read and send from. When an API token is calling, its scope narrows
 * that further: a token never reaches a mailbox its owner can't, so taking access away from a person
 * takes it from their tokens too.
 */
export async function accessibleMailboxIds(user: ScopedUser): Promise<string[]> {
	const ids = await ownerMailboxIds(user)
	const scope = user.tokenScope
	if (!scope || scope.type === 'all') return ids
	const inProjects = scope.projectIds.length
		? (
				await db
					.select({ id: schema.mailboxes.id })
					.from(schema.mailboxes)
					.where(inArray(schema.mailboxes.projectId, scope.projectIds))
			).map(r => r.id)
		: []
	const allowed = new Set([...inProjects, ...scope.mailboxIds])
	return ids.filter(id => allowed.has(id))
}

async function ownerMailboxIds(user: UserRow): Promise<string[]> {
	if (isAdmin(user)) {
		const rows = await db.select({ id: schema.mailboxes.id }).from(schema.mailboxes)
		return rows.map(r => r.id)
	}
	const grants = await db.select().from(schema.projectMembers).where(eq(schema.projectMembers.userId, user.id))
	if (!grants.length) return []
	const all = grants.filter(g => g.access === 'all').map(g => g.projectId)
	const selected = grants.filter(g => g.access === 'selected').map(g => g.projectId)
	const ids = new Set<string>()
	if (all.length) {
		const rows = await db
			.select({ id: schema.mailboxes.id })
			.from(schema.mailboxes)
			.where(inArray(schema.mailboxes.projectId, all))
		for (const r of rows) ids.add(r.id)
	}
	if (selected.length) {
		const rows = await db
			.select({ id: schema.mailboxes.id })
			.from(schema.mailboxMembers)
			.innerJoin(schema.mailboxes, eq(schema.mailboxes.id, schema.mailboxMembers.mailboxId))
			.where(and(eq(schema.mailboxMembers.userId, user.id), inArray(schema.mailboxes.projectId, selected)))
		for (const r of rows) ids.add(r.id)
	}
	return [...ids]
}

export async function assertMailboxAccess(user: ScopedUser, mailboxId: string) {
	const ids = await accessibleMailboxIds(user)
	if (!ids.includes(mailboxId)) throw new HttpError(404, 'Mailbox not found')
}

/** Project ids the user can see (has at least one mailbox in, or was added to). */
export async function accessibleProjectIds(user: ScopedUser): Promise<string[] | 'all'> {
	if (isAdmin(user) && !user.tokenScope) return 'all'
	if (user.tokenScope) {
		const ids = await accessibleMailboxIds(user)
		if (!ids.length) return []
		const rows = await db
			.select({ p: schema.mailboxes.projectId })
			.from(schema.mailboxes)
			.where(inArray(schema.mailboxes.id, ids))
		return [...new Set(rows.map(r => r.p))]
	}
	const grants = await db
		.select({ projectId: schema.projectMembers.projectId })
		.from(schema.projectMembers)
		.where(eq(schema.projectMembers.userId, user.id))
	return grants.map(g => g.projectId)
}
