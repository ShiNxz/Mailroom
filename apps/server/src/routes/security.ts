import type { SecurityStatus, SessionInfo, UserSettings } from '@mailroom/shared'
import type { RegistrationResponseJSON } from '@simplewebauthn/server'
import { and, desc, eq, gt } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import {
	COOKIE,
	cookieOptions,
	createSession,
	hashPassword,
	markSessionVerified,
	toUser,
	type UserRow,
	validatePassword,
	verifyPassword,
} from '../auth'
import { type Caller, enrollAuth, sessionAuth } from '../context'
import { db, schema } from '../db'
import { decryptSecret, encryptSecret } from '../lib/crypto'
import { HttpError } from '../lib/http'
import { factorsOf, newRecoveryCodes, passkeyRegistrationOptions, savePasskey } from '../security/factors'
import { newTotpSecret, totpEnrollment, verifyTotp } from '../security/totp'
import { getBranding } from './branding'

async function securityStatus(user: UserRow, verified: boolean): Promise<SecurityStatus> {
	const factors = await factorsOf(user.id)
	const passkeys = await db.select().from(schema.passkeys).where(eq(schema.passkeys.userId, user.id))
	return {
		verified,
		passkeys: passkeys.map(p => ({
			id: p.id,
			name: p.name,
			createdAt: p.createdAt.toISOString(),
			lastUsedAt: p.lastUsedAt?.toISOString() ?? null,
		})),
		totp: factors.totp,
		recoveryCodes: factors.recoveryCodes,
		hasFactor: factors.any,
	}
}

/**
 * Adding a factor from a session that has not passed one is only allowed while the account has none:
 * that is the first setup. Otherwise someone with only the password could add their own passkey.
 */
async function assertCanEnroll(caller: Caller, verified: boolean) {
	if (verified) return
	if ((await factorsOf(caller.user.id)).any)
		throw new HttpError(403, 'Sign in with your passkey or authenticator first', 'mfa_required')
}

const sessionVerified = async (sessionId: string | null) => {
	if (!sessionId) return false
	const [s] = await db
		.select({ mfaAt: schema.sessions.mfaAt })
		.from(schema.sessions)
		.where(eq(schema.sessions.id, sessionId))
	return !!s?.mfaAt
}

/** After the first factor: recovery codes (shown once) and this session counts as verified. */
async function firstFactorDone(caller: Caller, wasFirst: boolean) {
	if (caller.sessionId) await markSessionVerified(caller.sessionId)
	return wasFirst ? await newRecoveryCodes(caller.user.id) : null
}

async function assertNotLastFactor(userId: string, removing: 'passkey' | 'totp') {
	const f = await factorsOf(userId)
	const left = removing === 'passkey' ? f.passkeys - 1 + (f.totp ? 1 : 0) : f.passkeys
	if (left < 1) throw new HttpError(400, 'Add another passkey or an authenticator app before removing this one')
}

export const securityRoutes = new Elysia({ prefix: '/auth' })
	// --- Readable by any session, so the app can show the setup screen ---------------------
	.use(enrollAuth)
	.get('/me', async ({ user, sessionId }) => {
		const verified = await sessionVerified(sessionId)
		return { user: toUser(user), security: await securityStatus(user, verified) }
	})

	.get('/security', async ({ user, sessionId }) => securityStatus(user, await sessionVerified(sessionId)))

	.post('/passkeys/options', async caller => {
		const verified = await sessionVerified(caller.sessionId)
		await assertCanEnroll(caller, verified)
		return passkeyRegistrationOptions(caller.user, caller.request.headers, await getBranding())
	})

	.post(
		'/passkeys',
		async caller => {
			const verified = await sessionVerified(caller.sessionId)
			await assertCanEnroll(caller, verified)
			const wasFirst = !(await factorsOf(caller.user.id)).any
			await savePasskey(
				caller.user,
				caller.request.headers,
				caller.body.response as unknown as RegistrationResponseJSON,
				caller.body.name,
			)
			return { recoveryCodes: await firstFactorDone(caller, wasFirst) }
		},
		{ body: t.Object({ response: t.Record(t.String(), t.Unknown()), name: t.String({ maxLength: 60 }) }) },
	)

	.post('/totp/setup', async caller => {
		const verified = await sessionVerified(caller.sessionId)
		await assertCanEnroll(caller, verified)
		if (caller.user.totpEnabledAt) throw new HttpError(409, 'An authenticator app is already set up')
		const secret = newTotpSecret()
		await db
			.update(schema.users)
			.set({ totpSecret: encryptSecret(secret) })
			.where(eq(schema.users.id, caller.user.id))
		return totpEnrollment(secret, caller.user.email, (await getBranding()).name)
	})

	.post(
		'/totp/enable',
		async caller => {
			const verified = await sessionVerified(caller.sessionId)
			await assertCanEnroll(caller, verified)
			const user = caller.user
			if (user.totpEnabledAt) throw new HttpError(409, 'An authenticator app is already set up')
			if (!user.totpSecret) throw new HttpError(400, 'Start the authenticator setup first')
			if (!(await verifyTotp(user.id, decryptSecret(user.totpSecret), caller.body.code)))
				throw new HttpError(400, 'That code is not right. Check the time on your phone and try the newest code.')
			const wasFirst = !(await factorsOf(user.id)).any
			await db.update(schema.users).set({ totpEnabledAt: new Date() }).where(eq(schema.users.id, user.id))
			return { recoveryCodes: await firstFactorDone(caller, wasFirst) }
		},
		{ body: t.Object({ code: t.String({ maxLength: 12 }) }) },
	)

	// --- Everything else needs a session that passed a second factor -------------------------
	.use(sessionAuth)
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
			// Signs out every other device; this one stays signed in and verified
			await db.delete(schema.sessions).where(eq(schema.sessions.userId, user.id))
			const token = await createSession(user.id, request.headers.get('user-agent'), true)
			cookie[COOKIE]!.set({ value: token, ...cookieOptions(request.headers) })
			return { ok: true }
		},
		{ body: t.Object({ current: t.String({ maxLength: 200 }), next: t.String({ maxLength: 200 }) }) },
	)

	.patch(
		'/passkeys/:id',
		async ({ user, params, body }) => {
			await db
				.update(schema.passkeys)
				.set({ name: body.name.trim().slice(0, 60) || 'Passkey' })
				.where(and(eq(schema.passkeys.id, params.id), eq(schema.passkeys.userId, user.id)))
			return { ok: true }
		},
		{ body: t.Object({ name: t.String({ maxLength: 60 }) }) },
	)

	.delete('/passkeys/:id', async ({ user, params }) => {
		await assertNotLastFactor(user.id, 'passkey')
		await db.delete(schema.passkeys).where(and(eq(schema.passkeys.id, params.id), eq(schema.passkeys.userId, user.id)))
		return { ok: true }
	})

	.delete('/totp', async ({ user }) => {
		await assertNotLastFactor(user.id, 'totp')
		await db.update(schema.users).set({ totpSecret: null, totpEnabledAt: null }).where(eq(schema.users.id, user.id))
		return { ok: true }
	})

	.post('/recovery-codes', async ({ user }) => ({ recoveryCodes: await newRecoveryCodes(user.id) }))

	.get('/sessions', async ({ user, sessionId }) => {
		const rows = await db
			.select()
			.from(schema.sessions)
			.where(and(eq(schema.sessions.userId, user.id), gt(schema.sessions.expiresAt, new Date())))
			.orderBy(desc(schema.sessions.lastSeenAt))
		return {
			sessions: rows.map<SessionInfo>(s => ({
				id: s.id,
				label: s.label,
				createdAt: s.createdAt.toISOString(),
				lastSeenAt: s.lastSeenAt.toISOString(),
				current: s.id === sessionId,
				verified: !!s.mfaAt,
			})),
		}
	})

	.delete('/sessions/:id', async ({ user, params, sessionId }) => {
		if (params.id === sessionId) throw new HttpError(400, 'Use Sign out for this device')
		await db.delete(schema.sessions).where(and(eq(schema.sessions.id, params.id), eq(schema.sessions.userId, user.id)))
		return { ok: true }
	})
