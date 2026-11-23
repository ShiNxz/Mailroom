import type { User } from '@mailroom/shared'
import { and, eq, gt } from 'drizzle-orm'
import { db, schema } from './db'
import { env } from './env'
import { randomToken, sha256 } from './lib/ids'
import { redis } from './lib/redis'

export const COOKIE = 'mr_session'

export type UserRow = typeof schema.users.$inferSelect

export const toUser = (u: UserRow): User => ({
	id: u.id,
	email: u.email,
	name: u.name,
	role: u.role,
	disabled: u.disabled,
	settings: u.settings,
	createdAt: u.createdAt.toISOString(),
})

export const hashPassword = (password: string) => Bun.password.hash(password, { algorithm: 'argon2id' })
export const verifyPassword = (password: string, hash: string) => Bun.password.verify(password, hash)

export function validatePassword(password: string) {
	if (password.length < 10) return 'Use at least 10 characters'
	if (password.length > 200) return 'That password is too long'
	return null
}

const sessionMs = () => env.sessionDays * 24 * 60 * 60 * 1000

export async function createSession(userId: string, label: string | null) {
	const token = randomToken()
	await db.insert(schema.sessions).values({
		id: sha256(token),
		userId,
		label: label?.slice(0, 200) ?? null,
		expiresAt: new Date(Date.now() + sessionMs()),
	})
	return token
}

export async function deleteSession(token: string) {
	await db.delete(schema.sessions).where(eq(schema.sessions.id, sha256(token)))
}

/** The signed-in user for a token, or null. Slides the expiry forward at most every 10 minutes. */
export async function userForToken(token: string | undefined | null): Promise<UserRow | null> {
	if (!token) return null
	const id = sha256(token)
	const [row] = await db
		.select({ user: schema.users, session: schema.sessions })
		.from(schema.sessions)
		.innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
		.where(and(eq(schema.sessions.id, id), gt(schema.sessions.expiresAt, new Date())))
		.limit(1)
	if (!row || row.user.disabled) return null
	if (Date.now() - row.session.lastSeenAt.getTime() > 10 * 60 * 1000) {
		await db
			.update(schema.sessions)
			.set({ lastSeenAt: new Date(), expiresAt: new Date(Date.now() + sessionMs()) })
			.where(eq(schema.sessions.id, id))
	}
	return row.user
}

export function tokenFrom(headers: Headers, cookie: Record<string, { value?: unknown }>) {
	const auth = headers.get('authorization')
	if (auth?.startsWith('Bearer ')) return auth.slice(7).trim()
	const value = cookie[COOKIE]?.value
	return typeof value === 'string' ? value : null
}

// Login throttling: 8 failures per email or 30 per IP in 15 minutes locks that key for the rest of the window.
const WINDOW = 15 * 60

export async function loginLocked(email: string, ip: string) {
	const [byEmail, byIp] = await redis.mget(`login:e:${email}`, `login:i:${ip}`)
	return Number(byEmail ?? 0) >= 8 || Number(byIp ?? 0) >= 30
}

export async function recordFailedLogin(email: string, ip: string) {
	await redis
		.multi()
		.incr(`login:e:${email}`)
		.expire(`login:e:${email}`, WINDOW, 'NX')
		.incr(`login:i:${ip}`)
		.expire(`login:i:${ip}`, WINDOW, 'NX')
		.exec()
}

export const clearFailedLogins = (email: string) => redis.del(`login:e:${email}`)

export const isHttps = (headers: Headers) => (headers.get('x-forwarded-proto') ?? '').split(',')[0]?.trim() === 'https'

export const cookieOptions = (headers: Headers) => ({
	httpOnly: true,
	sameSite: 'lax' as const,
	secure: isHttps(headers),
	path: '/',
	maxAge: env.sessionDays * 24 * 60 * 60,
})
