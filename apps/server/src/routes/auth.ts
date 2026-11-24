import type { LoginResult, MfaMethod } from '@mailroom/shared'
import type { AuthenticationResponseJSON } from '@simplewebauthn/server'
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
	type UserRow,
	validatePassword,
	verifyPassword,
} from '../auth'
import { clientIp, sessionAuth } from '../context'
import { db, schema } from '../db'
import { env } from '../env'
import { HttpError } from '../lib/http'
import { randomToken, sha256 } from '../lib/ids'
import { redis } from '../lib/redis'
import {
	checkTotp,
	factorsOf,
	newMfaTicket,
	passkeyLoginOptions,
	readMfaTicket,
	useRecoveryCode,
	verifyPasskeyLogin,
} from '../security/factors'

// Signing in: a password and then a second factor (passkey or authenticator code), or a passkey alone
// (it is two factors in one: the device and the fingerprint or PIN). An account without a factor yet
// gets a session that can only set one up.

const normalizeEmail = (email: string) => email.trim().toLowerCase()

// A real hash to compare against when the email doesn't exist, so timing doesn't reveal accounts
const DUMMY_HASH = await Bun.password.hash('not-a-real-password', { algorithm: 'argon2id' })

type Cookie = Record<string, { value?: unknown; set: (v: Record<string, unknown>) => void }>

async function startSession(user: UserRow, verified: boolean, label: string | null, cookie: Cookie, headers: Headers) {
	const token = await createSession(user.id, label, verified)
	cookie[COOKIE]!.set({ value: token, ...cookieOptions(headers) })
	return token
}

// Device sign-in (the Mac app): the app shows a code, a signed-in browser approves it
const DEVICE_TTL = 600
const deviceKey = (deviceCode: string) => `device:dc:${sha256(deviceCode)}`
const userCodeKey = (userCode: string) => `device:uc:${userCode.replace(/[^A-Z0-9]/gi, '').toUpperCase()}`
interface DeviceRequest {
	userCode: string
	device: string
	status: 'pending' | 'approved' | 'denied'
	userId?: string
}

function newUserCode() {
	const alphabet = 'BCDFGHJKLMNPQRSTVWXZ23456789'
	const bytes = crypto.getRandomValues(new Uint8Array(8))
	const code = Array.from(bytes, b => alphabet[b % alphabet.length]).join('')
	return `${code.slice(0, 4)}-${code.slice(4)}`
}

export const authRoutes = new Elysia({ prefix: '/auth' })
	.get('/status', async () => {
		const [row] = await db.select({ n: count() }).from(schema.users)
		return { needsSetup: (row?.n ?? 0) === 0, setupTokenRequired: !!env.setupToken }
	})

	// First run: the first account is the owner. Refused once any user exists. It still has to set up a factor.
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
			await startSession(user, false, request.headers.get('user-agent'), cookie as Cookie, request.headers)
			return { user: toUser(user), setupRequired: true } satisfies LoginResult
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
			if (body.client === 'native')
				throw new HttpError(400, 'Update the Mac app: it now signs in through the browser.', 'use_device_login')
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
			const factors = await factorsOf(user.id)
			if (factors.any) {
				const methods: MfaMethod[] = []
				if (factors.passkeys) methods.push('passkey')
				if (factors.totp) methods.push('totp')
				if (factors.recoveryCodes) methods.push('recovery')
				const ticket = await newMfaTicket(user.id, request.headers.get('user-agent'))
				return { mfa: { ticket, methods } } satisfies LoginResult
			}
			// No factor yet: a session that can only set one up
			await startSession(user, false, request.headers.get('user-agent'), cookie as Cookie, request.headers)
			return { user: toUser(user), setupRequired: true } satisfies LoginResult
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

	// Second step after the password: an authenticator code or a recovery code
	.post(
		'/mfa/code',
		async ({ body, cookie, request }) => {
			const ticket = await readMfaTicket(body.ticket)
			const [user] = await db.select().from(schema.users).where(eq(schema.users.id, ticket.userId))
			if (!user || user.disabled) throw new HttpError(401, 'This account is disabled')
			const code = body.code.trim()
			const ok = /^\d{6}$/.test(code.replace(/\s/g, ''))
				? await checkTotp(user, code)
				: await useRecoveryCode(user.id, code)
			if (!ok) {
				await ticket.failed()
				throw new HttpError(401, 'That code is not right')
			}
			await ticket.done()
			await startSession(user, true, ticket.label, cookie as Cookie, request.headers)
			return { user: toUser(user) } satisfies LoginResult
		},
		{ body: t.Object({ ticket: t.String({ maxLength: 100 }), code: t.String({ maxLength: 40 }) }) },
	)

	// Passkey sign-in: with a ticket it is the second step, without one it is the whole sign-in
	.post(
		'/passkey/options',
		async ({ body, request }) => {
			const ticket = body.ticket ? await readMfaTicket(body.ticket) : null
			return passkeyLoginOptions(request.headers, ticket?.userId)
		},
		{ body: t.Object({ ticket: t.Optional(t.String({ maxLength: 100 })) }) },
	)

	.post(
		'/passkey/verify',
		async ({ body, cookie, request }) => {
			const ticket = body.ticket ? await readMfaTicket(body.ticket) : null
			const user = await verifyPasskeyLogin(
				request.headers,
				body.challengeId,
				body.response as unknown as AuthenticationResponseJSON,
			)
			if (ticket && ticket.userId !== user.id) throw new HttpError(401, 'This passkey belongs to another account')
			await ticket?.done()
			await startSession(
				user,
				true,
				ticket?.label ?? request.headers.get('user-agent'),
				cookie as Cookie,
				request.headers,
			)
			return { user: toUser(user) } satisfies LoginResult
		},
		{
			body: t.Object({
				challengeId: t.String({ maxLength: 100 }),
				response: t.Record(t.String(), t.Unknown()),
				ticket: t.Optional(t.String({ maxLength: 100 })),
			}),
		},
	)

	.post('/logout', async ({ cookie, request }) => {
		const token = tokenFrom(request.headers, cookie)
		if (token) await deleteSession(token)
		cookie[COOKIE]!.set({ value: '', ...cookieOptions(request.headers), maxAge: 0 })
		return { ok: true }
	})

	// --- Device sign-in for the Mac app -------------------------------------------------------
	.post(
		'/device/start',
		async ({ body, request }) => {
			const ip = clientIp(request.headers)
			const rl = `rl:device:${ip}`
			const n = await redis.incr(rl)
			if (n === 1) await redis.expire(rl, 600)
			if (n > 20) throw new HttpError(429, 'Too many sign-in requests. Wait a few minutes.')
			const deviceCode = randomToken(32)
			const userCode = newUserCode()
			const request_: DeviceRequest = { userCode, device: body.device.slice(0, 80), status: 'pending' }
			await redis.set(deviceKey(deviceCode), JSON.stringify(request_), 'EX', DEVICE_TTL)
			await redis.set(userCodeKey(userCode), sha256(deviceCode), 'EX', DEVICE_TTL)
			return { deviceCode, userCode, verifyPath: `/device?code=${userCode}`, expiresIn: DEVICE_TTL, interval: 2 }
		},
		{ body: t.Object({ device: t.String({ minLength: 1, maxLength: 200 }) }) },
	)

	.post(
		'/device/poll',
		async ({ body }) => {
			const raw = await redis.get(deviceKey(body.deviceCode))
			if (!raw) throw new HttpError(410, 'The sign-in request expired. Start again.', 'expired')
			const req = JSON.parse(raw) as DeviceRequest
			if (req.status === 'pending') return { status: 'pending' as const }
			await redis.del(deviceKey(body.deviceCode), userCodeKey(req.userCode))
			if (req.status === 'denied' || !req.userId) return { status: 'denied' as const }
			const [user] = await db.select().from(schema.users).where(eq(schema.users.id, req.userId))
			if (!user || user.disabled) return { status: 'denied' as const }
			// Approved from a browser session that passed a second factor, so this one counts as verified
			const token = await createSession(user.id, req.device, true)
			return { status: 'approved' as const, token, user: toUser(user) }
		},
		{ body: t.Object({ deviceCode: t.String({ maxLength: 100 }) }) },
	)

	.use(sessionAuth)
	.get('/device/:code', async ({ params }) => {
		const hash = await redis.get(userCodeKey(params.code))
		const raw = hash ? await redis.get(`device:dc:${hash}`) : null
		if (!raw) throw new HttpError(404, 'This code expired or does not exist')
		const req = JSON.parse(raw) as DeviceRequest
		return { device: req.device, status: req.status }
	})

	.post(
		'/device/:code',
		async ({ params, body, user }) => {
			const hash = await redis.get(userCodeKey(params.code))
			const key = hash ? `device:dc:${hash}` : null
			const raw = key ? await redis.get(key) : null
			if (!key || !raw) throw new HttpError(404, 'This code expired or does not exist')
			const req = JSON.parse(raw) as DeviceRequest
			if (req.status !== 'pending') throw new HttpError(409, 'This sign-in was already answered')
			const next: DeviceRequest = { ...req, status: body.approve ? 'approved' : 'denied', userId: user.id }
			await redis.set(key, JSON.stringify(next), 'KEEPTTL')
			return { status: next.status }
		},
		{ body: t.Object({ approve: t.Boolean() }) },
	)
