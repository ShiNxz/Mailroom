import type { UserSettings } from '@mailroom/shared'
import { count, eq } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import {
	COOKIE,
	clearFailedLogins,
	cookieOptions,
	createSession,
	deleteSession,
	hashPassword,
	loginLocked,
	recordFailedLogin,
	tokenFrom,
	toUser,
	validatePassword,
	verifyPassword,
} from '../auth'
import { authed, clientIp } from '../context'
import { db, schema } from '../db'
import { env } from '../env'
import { HttpError } from '../lib/http'

const normalizeEmail = (email: string) => email.trim().toLowerCase()

// A real hash to compare against when the email doesn't exist, so timing doesn't reveal accounts
const DUMMY_HASH = await Bun.password.hash('not-a-real-password', { algorithm: 'argon2id' })

export const authRoutes = new Elysia({ prefix: '/auth' })
	.get('/status', async () => {
		const [row] = await db.select({ n: count() }).from(schema.users)
		return { needsSetup: (row?.n ?? 0) === 0, setupTokenRequired: !!env.setupToken }
	})

	// First run: the first account is the owner. Refused once any user exists.
	.post(
		'/setup',
		async ({ body, cookie, request }) => {
			if (env.setupToken && body.token !== env.setupToken) throw new HttpError(403, 'Wrong setup token')
			const problem = validatePassword(body.password)
			if (problem) throw new HttpError(400, problem)
			const user = await db.transaction(async tx => {
				await tx.execute('lock table users in exclusive mode')
				const [row] = await tx.select({ n: count() }).from(schema.users)
				if ((row?.n ?? 0) > 0) throw new HttpError(409, 'Setup is already done')
				const [created] = await tx
					.insert(schema.users)
					.values({
						email: normalizeEmail(body.email),
						name: body.name.trim(),
						passwordHash: await hashPassword(body.password),
						role: 'owner',
					})
					.returning()
				return created!
			})
			const token = await createSession(user.id, request.headers.get('user-agent'))
			cookie[COOKIE]!.set({ value: token, ...cookieOptions(request.headers) })
			return { user: toUser(user) }
		},
		{
			body: t.Object({
				name: t.String({ minLength: 1, maxLength: 100 }),
				email: t.String({ format: 'email', maxLength: 200 }),
				password: t.String({ maxLength: 200 }),
				token: t.Optional(t.String({ maxLength: 200 })),
			}),
		},
	)

	.post(
		'/login',
		async ({ body, cookie, request }) => {
			const email = normalizeEmail(body.email)
			const ip = clientIp(request.headers)
			if (await loginLocked(email, ip))
				throw new HttpError(429, 'Too many failed attempts. Wait 15 minutes and try again.')
			const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email))
			const ok = await verifyPassword(body.password, user?.passwordHash ?? DUMMY_HASH)
			if (!user || !ok || user.disabled) {
				await recordFailedLogin(email, ip)
				throw new HttpError(401, user?.disabled ? 'This account is disabled' : 'Wrong email or password')
			}
			await clearFailedLogins(email)
			const token = await createSession(user.id, body.device ?? request.headers.get('user-agent'))
			// Native apps (the Mac app) keep the token and send it as a bearer token
			if (body.client === 'native') return { user: toUser(user), token }
			cookie[COOKIE]!.set({ value: token, ...cookieOptions(request.headers) })
			return { user: toUser(user) }
		},
		{
			body: t.Object({
				email: t.String({ maxLength: 200 }),
				password: t.String({ maxLength: 200 }),
				client: t.Optional(t.Union([t.Literal('web'), t.Literal('native')])),
				device: t.Optional(t.String({ maxLength: 200 })),
			}),
		},
	)

	.post('/logout', async ({ cookie, request }) => {
		const token = tokenFrom(request.headers, cookie)
		if (token) await deleteSession(token)
		cookie[COOKIE]!.set({ value: '', ...cookieOptions(request.headers), maxAge: 0 })
		return { ok: true }
	})

	.use(authed)
	.get('/me', ({ user }) => ({ user: toUser(user) }))

	.patch(
		'/me',
		async ({ user, body }) => {
			const settings: UserSettings = { ...user.settings, ...(body.settings ?? {}) }
			if (settings.undoSeconds !== undefined)
				settings.undoSeconds = Math.max(0, Math.min(30, Math.round(settings.undoSeconds)))
			const [updated] = await db
				.update(schema.users)
				.set({ name: body.name?.trim() || user.name, settings })
				.where(eq(schema.users.id, user.id))
				.returning()
			return { user: toUser(updated!) }
		},
		{
			body: t.Object({
				name: t.Optional(t.String({ maxLength: 100 })),
				settings: t.Optional(
					t.Object({
						undoSeconds: t.Optional(t.Number()),
						showImages: t.Optional(t.Boolean()),
						notifications: t.Optional(t.Boolean()),
					}),
				),
			}),
		},
	)

	.post(
		'/password',
		async ({ user, body, cookie, request }) => {
			if (!(await verifyPassword(body.current, user.passwordHash)))
				throw new HttpError(400, 'The current password is wrong')
			const problem = validatePassword(body.next)
			if (problem) throw new HttpError(400, problem)
			await db
				.update(schema.users)
				.set({ passwordHash: await hashPassword(body.next) })
				.where(eq(schema.users.id, user.id))
			// Signs out every other device
			await db.delete(schema.sessions).where(eq(schema.sessions.userId, user.id))
			const token = await createSession(user.id, request.headers.get('user-agent'))
			cookie[COOKIE]!.set({ value: token, ...cookieOptions(request.headers) })
			return { ok: true }
		},
		{ body: t.Object({ current: t.String({ maxLength: 200 }), next: t.String({ maxLength: 200 }) }) },
	)
