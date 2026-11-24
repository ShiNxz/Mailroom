import type { ProjectGrant, Role, UserWithAccess } from '@mailroom/shared'
import { and, count, eq, inArray, max } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import { requireAdmin } from '../access'
import { hashPassword, toUser, type UserRow, validatePassword } from '../auth'
import { sessionAuth } from '../context'
import { db, schema } from '../db'
import { checkDomain } from '../health/dns'
import { resetSignIn } from '../security/factors'
import { encryptSecret } from '../lib/crypto'
import { HttpError, notFound } from '../lib/http'
import { publishEvent, sendCommand } from '../lib/redis'
import { autoconfigure } from '../mail/autoconfig'
import { type ConnectionSettings, testImap, testSmtp } from '../mail/connect'
import { toDomain, toMailboxSettings } from '../serialize'

const Security = t.Union([t.Literal('tls'), t.Literal('starttls'), t.Literal('none')])
const RoleT = t.Union([t.Literal('admin'), t.Literal('member')])
const GrantT = t.Object({
	projectId: t.String(),
	access: t.Union([t.Literal('all'), t.Literal('selected')]),
	mailboxIds: t.Array(t.String()),
})
const ConnectionT = {
	username: t.String({ minLength: 1, maxLength: 320 }),
	imapHost: t.String({ minLength: 1, maxLength: 255 }),
	imapPort: t.Number({ minimum: 1, maximum: 65535 }),
	imapSecurity: Security,
	smtpHost: t.String({ minLength: 1, maxLength: 255 }),
	smtpPort: t.Number({ minimum: 1, maximum: 65535 }),
	smtpSecurity: Security,
}
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

const normalizeDomain = (d: string) =>
	d
		.trim()
		.toLowerCase()
		.replace(/^https?:\/\//, '')
		.replace(/\/.*$/, '')
		.replace(/^www\./, '')
		.replace(/\.$/, '')

async function grantsOf(userIds: string[]): Promise<Map<string, ProjectGrant[]>> {
	const out = new Map<string, ProjectGrant[]>()
	if (!userIds.length) return out
	const projects = await db.select().from(schema.projectMembers).where(inArray(schema.projectMembers.userId, userIds))
	const mailboxes = await db
		.select({
			userId: schema.mailboxMembers.userId,
			mailboxId: schema.mailboxMembers.mailboxId,
			projectId: schema.mailboxes.projectId,
		})
		.from(schema.mailboxMembers)
		.innerJoin(schema.mailboxes, eq(schema.mailboxes.id, schema.mailboxMembers.mailboxId))
		.where(inArray(schema.mailboxMembers.userId, userIds))
	for (const p of projects) {
		const list = out.get(p.userId) ?? []
		list.push({
			projectId: p.projectId,
			access: p.access,
			mailboxIds: mailboxes.filter(m => m.userId === p.userId && m.projectId === p.projectId).map(m => m.mailboxId),
		})
		out.set(p.userId, list)
	}
	return out
}

/** Users as the admin pages show them: their access and whether they set up a second factor. */
async function withAccess(users: UserRow[]): Promise<UserWithAccess[]> {
	const ids = users.map(u => u.id)
	const grants = await grantsOf(ids)
	const passkeys = ids.length
		? await db
				.select({ userId: schema.passkeys.userId, n: count() })
				.from(schema.passkeys)
				.where(inArray(schema.passkeys.userId, ids))
				.groupBy(schema.passkeys.userId)
		: []
	return users.map(u => ({
		...toUser(u),
		grants: grants.get(u.id) ?? [],
		signIn: { passkeys: passkeys.find(p => p.userId === u.id)?.n ?? 0, totp: !!u.totpEnabledAt },
	}))
}

async function saveGrants(userId: string, grants: ProjectGrant[]) {
	await db.transaction(async tx => {
		await tx.delete(schema.projectMembers).where(eq(schema.projectMembers.userId, userId))
		await tx.delete(schema.mailboxMembers).where(eq(schema.mailboxMembers.userId, userId))
		const unique = [...new Map(grants.map(g => [g.projectId, g])).values()]
		if (!unique.length) return
		await tx
			.insert(schema.projectMembers)
			.values(unique.map(g => ({ userId, projectId: g.projectId, access: g.access })))
		const picked = unique
			.filter(g => g.access === 'selected')
			.flatMap(g => g.mailboxIds.map(mailboxId => ({ mailboxId, projectId: g.projectId })))
		if (!picked.length) return
		// Only mailboxes that really belong to the project they were picked under
		const valid = await tx
			.select({ id: schema.mailboxes.id, projectId: schema.mailboxes.projectId })
			.from(schema.mailboxes)
			.where(
				inArray(
					schema.mailboxes.id,
					picked.map(p => p.mailboxId),
				),
			)
		const ok = picked.filter(p => valid.some(v => v.id === p.mailboxId && v.projectId === p.projectId))
		if (ok.length)
			await tx
				.insert(schema.mailboxMembers)
				.values(ok.map(p => ({ userId, mailboxId: p.mailboxId })))
				.onConflictDoNothing()
	})
	await publishEvent({ type: 'access' })
}

/** Admins manage members; only the owner manages admins; nobody but the owner touches the owner. */
function assertCanManageUser(actor: UserRow, target: UserRow, nextRole?: Role) {
	if (target.role === 'owner' && actor.id !== target.id)
		throw new HttpError(403, 'Only the owner can change the owner account')
	if (actor.role !== 'owner' && (target.role === 'admin' || nextRole === 'admin') && actor.id !== target.id)
		throw new HttpError(403, 'Only the owner can manage admins')
}

async function healthFor(domain: typeof schema.domains.$inferSelect) {
	const sending = await db
		.select({ host: schema.mailboxes.smtpHost })
		.from(schema.mailboxes)
		.where(eq(schema.mailboxes.domainId, domain.id))
	const health = await checkDomain(domain.name, {
		dkimSelectors: domain.dkimSelectors,
		sendingHosts: [...new Set(sending.map(s => s.host))],
	})
	const [updated] = await db
		.update(schema.domains)
		.set({ health, checkedAt: new Date() })
		.where(eq(schema.domains.id, domain.id))
		.returning()
	return toDomain(updated!)
}

async function domainForAddress(projectId: string, address: string) {
	const host = address.split('@')[1]?.toLowerCase()
	if (!host) return null
	const [d] = await db
		.select()
		.from(schema.domains)
		.where(and(eq(schema.domains.projectId, projectId), eq(schema.domains.name, host)))
	return d ?? null
}

export const adminRoutes = new Elysia({ prefix: '/admin' })
	.use(sessionAuth)
	.onBeforeHandle(({ user }) => requireAdmin(user))

	// --- Users -------------------------------------------------------------------------------
	.get('/users', async () => {
		const users = await db.select().from(schema.users).orderBy(schema.users.createdAt)
		return { users: await withAccess(users) }
	})

	.post(
		'/users',
		async ({ user, body }) => {
			if (body.role === 'admin' && user.role !== 'owner') throw new HttpError(403, 'Only the owner can add admins')
			const problem = validatePassword(body.password)
			if (problem) throw new HttpError(400, problem)
			const email = body.email.trim().toLowerCase()
			const [exists] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email))
			if (exists) throw new HttpError(409, 'Someone already uses that email')
			const [created] = await db
				.insert(schema.users)
				.values({ email, name: body.name.trim(), passwordHash: await hashPassword(body.password), role: body.role })
				.returning()
			await saveGrants(created!.id, body.grants)
			return { user: (await withAccess([created!]))[0]! }
		},
		{
			body: t.Object({
				email: t.String({ format: 'email', maxLength: 200 }),
				name: t.String({ minLength: 1, maxLength: 100 }),
				password: t.String({ maxLength: 200 }),
				role: RoleT,
				grants: t.Array(GrantT),
			}),
		},
	)

	.patch(
		'/users/:id',
		async ({ user, params, body }) => {
			const [target] = await db.select().from(schema.users).where(eq(schema.users.id, params.id))
			if (!target) throw notFound('No such user')
			assertCanManageUser(user, target, body.role)
			if (target.role === 'owner' && (body.role || body.disabled))
				throw new HttpError(400, 'The owner stays an enabled owner')
			if (body.password) {
				const problem = validatePassword(body.password)
				if (problem) throw new HttpError(400, problem)
			}
			const changes = {
				...(body.name ? { name: body.name.trim() } : {}),
				...(body.role ? { role: body.role } : {}),
				...(body.disabled !== undefined ? { disabled: body.disabled } : {}),
				...(body.password ? { passwordHash: await hashPassword(body.password) } : {}),
			}
			const [updated] = Object.keys(changes).length
				? await db.update(schema.users).set(changes).where(eq(schema.users.id, target.id)).returning()
				: [target]
			if (body.disabled || body.password) await db.delete(schema.sessions).where(eq(schema.sessions.userId, target.id))
			if (body.grants) await saveGrants(target.id, body.grants)
			return { user: (await withAccess([updated!]))[0]! }
		},
		{
			body: t.Object({
				name: t.Optional(t.String({ maxLength: 100 })),
				role: t.Optional(RoleT),
				disabled: t.Optional(t.Boolean()),
				password: t.Optional(t.String({ maxLength: 200 })),
				grants: t.Optional(t.Array(GrantT)),
			}),
		},
	)

	// Lost phone or passkey: removes every passkey, the authenticator app and recovery codes, and signs
	// the person out everywhere. They set up a new factor at their next sign-in.
	.post('/users/:id/reset-sign-in', async ({ user, params }) => {
		const [target] = await db.select().from(schema.users).where(eq(schema.users.id, params.id))
		if (!target) throw notFound('No such user')
		if (target.id === user.id) throw new HttpError(400, 'Manage your own sign-in methods in Settings')
		assertCanManageUser(user, target)
		await resetSignIn(target.id)
		return { user: (await withAccess([{ ...target, totpSecret: null, totpEnabledAt: null }]))[0]! }
	})

	.delete('/users/:id', async ({ user, params }) => {
		const [target] = await db.select().from(schema.users).where(eq(schema.users.id, params.id))
		if (!target) throw notFound('No such user')
		if (target.role === 'owner') throw new HttpError(400, 'The owner account cannot be deleted')
		if (target.id === user.id) throw new HttpError(400, 'You cannot delete yourself')
		assertCanManageUser(user, target)
		await db.delete(schema.users).where(eq(schema.users.id, target.id))
		await publishEvent({ type: 'access' })
		return { ok: true }
	})

	// --- Projects ----------------------------------------------------------------------------
	.post(
		'/projects',
		async ({ body }) => {
			const [last] = await db.select({ p: max(schema.projects.position) }).from(schema.projects)
			const [project] = await db
				.insert(schema.projects)
				.values({
					name: body.name.trim(),
					color: body.color ?? '#6366f1',
					description: body.description ?? '',
					position: (last?.p ?? 0) + 1,
				})
				.returning()
			let domain = null
			if (body.domain) {
				const name = normalizeDomain(body.domain)
				if (!DOMAIN_RE.test(name)) throw new HttpError(400, 'That does not look like a domain name')
				const [d] = await db
					.insert(schema.domains)
					.values({ projectId: project!.id, name })
					.onConflictDoNothing()
					.returning()
				if (!d) throw new HttpError(409, 'That domain is already in another project')
				domain = await healthFor(d)
			}
			await publishEvent({ type: 'access' })
			return { project, domain }
		},
		{
			body: t.Object({
				name: t.String({ minLength: 1, maxLength: 80 }),
				color: t.Optional(t.String({ pattern: '^#[0-9a-fA-F]{6}$' })),
				description: t.Optional(t.String({ maxLength: 500 })),
				domain: t.Optional(t.String({ maxLength: 253 })),
			}),
		},
	)

	.patch(
		'/projects/:id',
		async ({ params, body }) => {
			if (!Object.keys(body).length) throw new HttpError(400, 'Nothing to change')
			const [project] = await db.update(schema.projects).set(body).where(eq(schema.projects.id, params.id)).returning()
			if (!project) throw notFound('No such project')
			await publishEvent({ type: 'access' })
			return { project }
		},
		{
			body: t.Object({
				name: t.Optional(t.String({ minLength: 1, maxLength: 80 })),
				color: t.Optional(t.String({ pattern: '^#[0-9a-fA-F]{6}$' })),
				description: t.Optional(t.String({ maxLength: 500 })),
				position: t.Optional(t.Number()),
			}),
		},
	)

	.delete('/projects/:id', async ({ params }) => {
		const boxes = await db
			.select({ id: schema.mailboxes.id })
			.from(schema.mailboxes)
			.where(eq(schema.mailboxes.projectId, params.id))
		for (const b of boxes) await sendCommand({ type: 'mailbox-removed', mailboxId: b.id })
		const deleted = await db.delete(schema.projects).where(eq(schema.projects.id, params.id)).returning()
		if (!deleted.length) throw notFound('No such project')
		await publishEvent({ type: 'access' })
		return { ok: true }
	})

	// --- Domains -----------------------------------------------------------------------------
	.post(
		'/projects/:id/domains',
		async ({ params, body }) => {
			const name = normalizeDomain(body.name)
			if (!DOMAIN_RE.test(name)) throw new HttpError(400, 'That does not look like a domain name')
			const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, params.id))
			if (!project) throw notFound('No such project')
			const [d] = await db
				.insert(schema.domains)
				.values({ projectId: project.id, name, dkimSelectors: body.dkimSelectors ?? [] })
				.onConflictDoNothing()
				.returning()
			if (!d) throw new HttpError(409, 'That domain is already added')
			// Link mailboxes of this project that are on the domain
			const boxes = await db.select().from(schema.mailboxes).where(eq(schema.mailboxes.projectId, project.id))
			const onDomain = boxes.filter(b => b.address.endsWith(`@${name}`)).map(b => b.id)
			if (onDomain.length)
				await db.update(schema.mailboxes).set({ domainId: d.id }).where(inArray(schema.mailboxes.id, onDomain))
			const domain = await healthFor(d)
			await publishEvent({ type: 'access' })
			return { domain }
		},
		{
			body: t.Object({
				name: t.String({ maxLength: 253 }),
				dkimSelectors: t.Optional(t.Array(t.String({ maxLength: 63 }))),
			}),
		},
	)

	.patch(
		'/domains/:id',
		async ({ params, body }) => {
			const selectors = [
				...new Set(
					body.dkimSelectors
						.map(s =>
							s
								.trim()
								.toLowerCase()
								.replace(/\._domainkey.*$/, ''),
						)
						.filter(Boolean),
				),
			]
			const [d] = await db
				.update(schema.domains)
				.set({ dkimSelectors: selectors })
				.where(eq(schema.domains.id, params.id))
				.returning()
			if (!d) throw notFound('No such domain')
			return { domain: await healthFor(d) }
		},
		{ body: t.Object({ dkimSelectors: t.Array(t.String({ maxLength: 63 })) }) },
	)

	.post('/domains/:id/check', async ({ params }) => {
		const [d] = await db.select().from(schema.domains).where(eq(schema.domains.id, params.id))
		if (!d) throw notFound('No such domain')
		return { domain: await healthFor(d) }
	})

	.delete('/domains/:id', async ({ params }) => {
		const deleted = await db.delete(schema.domains).where(eq(schema.domains.id, params.id)).returning()
		if (!deleted.length) throw notFound('No such domain')
		await publishEvent({ type: 'access' })
		return { ok: true }
	})

	// --- Mailboxes ---------------------------------------------------------------------------
	.post('/autoconfig', ({ body }) => autoconfigure(body.address), {
		body: t.Object({ address: t.String({ format: 'email', maxLength: 320 }) }),
	})

	.post(
		'/mailboxes/test',
		async ({ body }) => {
			let password = body.password
			if (!password && body.mailboxId) {
				const [m] = await db.select().from(schema.mailboxes).where(eq(schema.mailboxes.id, body.mailboxId))
				if (!m) throw notFound('No such mailbox')
				password = (await import('../lib/crypto')).decryptSecret(m.secret)
			}
			if (!password) throw new HttpError(400, 'Enter the password')
			const settings: ConnectionSettings = { ...body, password }
			const [imap, smtp] = await Promise.all([testImap(settings), testSmtp(settings)])
			return { imap, smtp }
		},
		{
			body: t.Object({
				...ConnectionT,
				password: t.Optional(t.String({ maxLength: 500 })),
				mailboxId: t.Optional(t.String()),
			}),
		},
	)

	.get('/mailboxes/:id', async ({ params }) => {
		const [m] = await db.select().from(schema.mailboxes).where(eq(schema.mailboxes.id, params.id))
		if (!m) throw notFound('No such mailbox')
		return { settings: toMailboxSettings(m), projectId: m.projectId }
	})

	.post(
		'/projects/:id/mailboxes',
		async ({ params, body }) => {
			const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, params.id))
			if (!project) throw notFound('No such project')
			const address = body.address.trim().toLowerCase()
			const [taken] = await db
				.select({ id: schema.mailboxes.id })
				.from(schema.mailboxes)
				.where(eq(schema.mailboxes.address, address))
			if (taken) throw new HttpError(409, 'That address is already connected')
			if (!body.skipTest) {
				const settings: ConnectionSettings = { ...body, password: body.password }
				const [imap, smtp] = await Promise.all([testImap(settings), testSmtp(settings)])
				if (!imap.ok || !smtp.ok) return { ok: false, imap, smtp }
			}
			const domain = await domainForAddress(project.id, address)
			const [m] = await db
				.insert(schema.mailboxes)
				.values({
					projectId: project.id,
					domainId: domain?.id ?? null,
					address,
					displayName: body.displayName?.trim() ?? '',
					username: body.username.trim(),
					secret: encryptSecret(body.password),
					imapHost: body.imapHost.trim(),
					imapPort: body.imapPort,
					imapSecurity: body.imapSecurity,
					smtpHost: body.smtpHost.trim(),
					smtpPort: body.smtpPort,
					smtpSecurity: body.smtpSecurity,
					saveSent: body.saveSent ?? true,
					signature: body.signature ?? '',
				})
				.returning()
			await sendCommand({ type: 'mailbox-changed', mailboxId: m!.id })
			await publishEvent({ type: 'access' })
			return { ok: true, mailboxId: m!.id }
		},
		{
			body: t.Object({
				...ConnectionT,
				address: t.String({ format: 'email', maxLength: 320 }),
				password: t.String({ minLength: 1, maxLength: 500 }),
				displayName: t.Optional(t.String({ maxLength: 200 })),
				saveSent: t.Optional(t.Boolean()),
				signature: t.Optional(t.String({ maxLength: 50_000 })),
				skipTest: t.Optional(t.Boolean()),
			}),
		},
	)

	.patch(
		'/mailboxes/:id',
		async ({ params, body }) => {
			const [m] = await db.select().from(schema.mailboxes).where(eq(schema.mailboxes.id, params.id))
			if (!m) throw notFound('No such mailbox')
			const connectionChanged =
				!!body.password ||
				(['username', 'imapHost', 'imapPort', 'imapSecurity', 'smtpHost', 'smtpPort', 'smtpSecurity'] as const).some(
					k => body[k] !== undefined && body[k] !== m[k],
				)
			if (!Object.keys(body).length) return { settings: toMailboxSettings(m) }
			const { password, ...rest } = body
			const [updated] = await db
				.update(schema.mailboxes)
				.set({
					...rest,
					...(password ? { secret: encryptSecret(password) } : {}),
					...(connectionChanged ? { status: 'connecting' as const, statusMessage: null } : {}),
				})
				.where(eq(schema.mailboxes.id, m.id))
				.returning()
			if (connectionChanged || body.enabled !== undefined)
				await sendCommand({ type: 'mailbox-changed', mailboxId: m.id })
			await publishEvent({ type: 'access' })
			return { settings: toMailboxSettings(updated!) }
		},
		{
			body: t.Object({
				username: t.Optional(ConnectionT.username),
				imapHost: t.Optional(ConnectionT.imapHost),
				imapPort: t.Optional(ConnectionT.imapPort),
				imapSecurity: t.Optional(Security),
				smtpHost: t.Optional(ConnectionT.smtpHost),
				smtpPort: t.Optional(ConnectionT.smtpPort),
				smtpSecurity: t.Optional(Security),
				password: t.Optional(t.String({ maxLength: 500 })),
				displayName: t.Optional(t.String({ maxLength: 200 })),
				saveSent: t.Optional(t.Boolean()),
				signature: t.Optional(t.String({ maxLength: 50_000 })),
				enabled: t.Optional(t.Boolean()),
			}),
		},
	)

	.post('/mailboxes/:id/resync', async ({ params }) => {
		await sendCommand({ type: 'resync', mailboxId: params.id })
		return { ok: true }
	})

	.delete('/mailboxes/:id', async ({ params }) => {
		await sendCommand({ type: 'mailbox-removed', mailboxId: params.id })
		const deleted = await db.delete(schema.mailboxes).where(eq(schema.mailboxes.id, params.id)).returning()
		if (!deleted.length) throw notFound('No such mailbox')
		await publishEvent({ type: 'access' })
		return { ok: true }
	})
