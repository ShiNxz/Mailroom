import { randomBytes } from 'node:crypto'
import type { Branding } from '@mailroom/shared'
import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
} from '@simplewebauthn/server'
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server'
import { and, count, eq, isNull } from 'drizzle-orm'
import type { UserRow } from '../auth'
import { db, schema } from '../db'
import { env } from '../env'
import { decryptSecret } from '../lib/crypto'
import { HttpError } from '../lib/http'
import { randomToken, sha256 } from '../lib/ids'
import { log } from '../lib/log'
import { redis } from '../lib/redis'
import { verifyTotp } from './totp'

// Second factors: passkeys (WebAuthn: Touch ID, Windows Hello, security keys, phone passkeys),
// an authenticator app (TOTP) and one-time recovery codes. Every account needs a passkey or an app.

/** The web app's address. WebAuthn binds passkeys to its host name, so it must be stable. */
export function relyingParty(headers: Headers) {
	let origin = env.publicUrl
	if (!origin) {
		// Dev without PUBLIC_URL: the browser's own Origin. Safe for WebAuthn, since the browser signs the
		// real origin into clientData and passkeys only work on the host they were made for.
		origin = headers.get('origin') ?? ''
		if (!origin) throw new HttpError(500, 'PUBLIC_URL is not set on the server')
	}
	const url = new URL(origin)
	return { rpID: url.hostname, origin: url.origin }
}

export async function factorsOf(userId: string) {
	const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId))
	const [{ passkeys } = { passkeys: 0 }] = await db
		.select({ passkeys: count() })
		.from(schema.passkeys)
		.where(eq(schema.passkeys.userId, userId))
	const [{ codes } = { codes: 0 }] = await db
		.select({ codes: count() })
		.from(schema.recoveryCodes)
		.where(and(eq(schema.recoveryCodes.userId, userId), isNull(schema.recoveryCodes.usedAt)))
	const totp = !!user?.totpEnabledAt
	return { passkeys, totp, recoveryCodes: codes, any: passkeys > 0 || totp }
}

// --- Recovery codes -------------------------------------------------------------------------

const normalizeCode = (code: string) => code.replace(/[^a-z0-9]/gi, '').toLowerCase()

/** Ten new codes (the old ones stop working). Returned once, stored hashed. */
export async function newRecoveryCodes(userId: string) {
	const codes = Array.from({ length: 10 }, () => {
		const raw = randomBytes(5).toString('hex')
		return `${raw.slice(0, 5)}-${raw.slice(5)}`
	})
	await db.transaction(async tx => {
		await tx.delete(schema.recoveryCodes).where(eq(schema.recoveryCodes.userId, userId))
		await tx.insert(schema.recoveryCodes).values(codes.map(c => ({ userId, codeHash: sha256(normalizeCode(c)) })))
	})
	return codes
}

export async function useRecoveryCode(userId: string, code: string) {
	const [row] = await db
		.update(schema.recoveryCodes)
		.set({ usedAt: new Date() })
		.where(
			and(
				eq(schema.recoveryCodes.userId, userId),
				eq(schema.recoveryCodes.codeHash, sha256(normalizeCode(code))),
				isNull(schema.recoveryCodes.usedAt),
			),
		)
		.returning()
	return !!row
}

// --- Authenticator app ----------------------------------------------------------------------

export async function checkTotp(user: UserRow, code: string) {
	if (!user.totpEnabledAt || !user.totpSecret) return false
	return verifyTotp(user.id, decryptSecret(user.totpSecret), code)
}

// --- Passkeys --------------------------------------------------------------------------------

const CHALLENGE_TTL = 300

export async function passkeyRegistrationOptions(user: UserRow, headers: Headers, branding: Branding) {
	const { rpID } = relyingParty(headers)
	const existing = await db.select().from(schema.passkeys).where(eq(schema.passkeys.userId, user.id))
	const options = await generateRegistrationOptions({
		rpName: branding.name,
		rpID,
		userName: user.email,
		userDisplayName: user.name,
		userID: new TextEncoder().encode(user.id),
		attestationType: 'none',
		excludeCredentials: existing.map(p => ({ id: p.id, transports: p.transports })),
		authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
	})
	await redis.set(`webauthn:reg:${user.id}`, options.challenge, 'EX', CHALLENGE_TTL)
	return options
}

export async function savePasskey(user: UserRow, headers: Headers, response: RegistrationResponseJSON, name: string) {
	const { rpID, origin } = relyingParty(headers)
	const challenge = await redis.getdel(`webauthn:reg:${user.id}`)
	if (!challenge) throw new HttpError(400, 'That took too long. Try again.')
	let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>
	try {
		verification = await verifyRegistrationResponse({
			response,
			expectedChallenge: challenge,
			expectedOrigin: origin,
			expectedRPID: rpID,
			requireUserVerification: true,
		})
	} catch (err) {
		log.warn('passkey registration failed', { err })
		throw new HttpError(400, 'The passkey could not be verified')
	}
	if (!verification.verified) throw new HttpError(400, 'The passkey could not be verified')
	const { credential } = verification.registrationInfo
	await db.insert(schema.passkeys).values({
		id: credential.id,
		userId: user.id,
		name: name.trim().slice(0, 60) || 'Passkey',
		publicKey: Buffer.from(credential.publicKey).toString('base64url'),
		counter: credential.counter,
		transports: credential.transports ?? [],
	})
}

/** Options for signing in with a passkey. A challenge id ties the answer to this request. */
export async function passkeyLoginOptions(headers: Headers, userId?: string) {
	const { rpID } = relyingParty(headers)
	const allow = userId
		? (await db.select().from(schema.passkeys).where(eq(schema.passkeys.userId, userId))).map(p => ({
				id: p.id,
				transports: p.transports,
			}))
		: undefined
	const options = await generateAuthenticationOptions({ rpID, allowCredentials: allow, userVerification: 'required' })
	const challengeId = randomToken(16)
	await redis.set(
		`webauthn:auth:${challengeId}`,
		JSON.stringify({ challenge: options.challenge, userId }),
		'EX',
		CHALLENGE_TTL,
	)
	return { challengeId, options }
}

/** Verifies a passkey sign-in and returns the user it belongs to. */
export async function verifyPasskeyLogin(headers: Headers, challengeId: string, response: AuthenticationResponseJSON) {
	const { rpID, origin } = relyingParty(headers)
	const stored = await redis.getdel(`webauthn:auth:${challengeId}`)
	if (!stored) throw new HttpError(400, 'That took too long. Try again.')
	const { challenge, userId } = JSON.parse(stored) as { challenge: string; userId?: string }
	const [passkey] = await db.select().from(schema.passkeys).where(eq(schema.passkeys.id, response.id))
	if (!passkey || (userId && passkey.userId !== userId)) throw new HttpError(401, 'This passkey is not registered here')
	let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>
	try {
		verification = await verifyAuthenticationResponse({
			response,
			expectedChallenge: challenge,
			expectedOrigin: origin,
			expectedRPID: rpID,
			requireUserVerification: true,
			credential: {
				id: passkey.id,
				publicKey: Buffer.from(passkey.publicKey, 'base64url'),
				counter: passkey.counter,
				transports: passkey.transports,
			},
		})
	} catch (err) {
		log.warn('passkey sign-in failed', { err })
		throw new HttpError(401, 'The passkey could not be verified')
	}
	if (!verification.verified) throw new HttpError(401, 'The passkey could not be verified')
	await db
		.update(schema.passkeys)
		.set({ counter: verification.authenticationInfo.newCounter, lastUsedAt: new Date() })
		.where(eq(schema.passkeys.id, passkey.id))
	const [user] = await db.select().from(schema.users).where(eq(schema.users.id, passkey.userId))
	if (!user || user.disabled) throw new HttpError(401, 'This account is disabled')
	return user
}

// --- Sign-in tickets: a correct password, waiting for the second factor ------------------------

export async function newMfaTicket(userId: string, label: string | null) {
	const ticket = randomToken(24)
	await redis.set(`mfa:ticket:${sha256(ticket)}`, JSON.stringify({ userId, label, tries: 0 }), 'EX', CHALLENGE_TTL)
	return ticket
}

export async function readMfaTicket(ticket: string) {
	const key = `mfa:ticket:${sha256(ticket)}`
	const raw = await redis.get(key)
	if (!raw) throw new HttpError(401, 'Sign in again: that took too long')
	const data = JSON.parse(raw) as { userId: string; label: string | null; tries: number }
	return {
		...data,
		key,
		/** Five wrong codes and the password has to be entered again */
		async failed() {
			data.tries++
			if (data.tries >= 5) await redis.del(key)
			else await redis.set(key, JSON.stringify(data), 'KEEPTTL')
		},
		done: () => redis.del(key),
	}
}

/** Removes every second factor and signs the person out everywhere (admin reset, or the CLI for the owner). */
export async function resetSignIn(userId: string) {
	await db.transaction(async tx => {
		await tx.delete(schema.passkeys).where(eq(schema.passkeys.userId, userId))
		await tx.delete(schema.recoveryCodes).where(eq(schema.recoveryCodes.userId, userId))
		await tx.update(schema.users).set({ totpSecret: null, totpEnabledAt: null }).where(eq(schema.users.id, userId))
		await tx.delete(schema.sessions).where(eq(schema.sessions.userId, userId))
	})
}
