import { Elysia } from 'elysia'
import { type ApiTokenRow, apiTokenAuth, sessionForToken, tokenFrom, type UserRow } from './auth'
import type { TokenScope } from './db/schema'
import { env } from './env'
import { HttpError } from './lib/http'
import { redis } from './lib/redis'

// Who is calling, at three levels:
// - authed: a session that passed a second factor, or an app's API token (limited by its scope and permissions)
// - sessionAuth: a session that passed a second factor; no API tokens (admin, account, tokens)
// - enrollAuth: any session, verified or not; only for setting up a second factor

/** The user, narrowed to a token's scope when an API token is calling (see access.ts). */
export type ScopedUser = UserRow & { tokenScope?: TokenScope }

export interface Caller {
	user: ScopedUser
	sessionId: string | null
	token: ApiTokenRow | null
}

type Rule = [method: string, path: RegExp]

// What an API token may call. Everything else is refused, so a new route is closed to tokens until listed here.
const ANY_TOKEN: Rule[] = [
	['GET', /^\/token$/],
	['GET', /^\/mailboxes$/],
	// Filtered inside: new mail needs read access, a token's own sends are always visible to it
	['GET', /^\/stream$/],
	['GET', /^\/updates$/],
]
const READ: Rule[] = [
	['GET', /^\/threads$/],
	['GET', /^\/threads\/[^/]+$/],
	['POST', /^\/threads\/actions$/],
	['GET', /^\/messages$/],
	['GET', /^\/messages\/[^/]+$/],
	['PATCH', /^\/messages\/[^/]+$/],
	['GET', /^\/messages\/[^/]+\/attachments\/[^/]+$/],
	['GET', /^\/messages\/[^/]+\/raw$/],
	['GET', /^\/contacts$/],
]
const SEND: Rule[] = [
	['POST', /^\/messages$/],
	['POST', /^\/messages\/[^/]+\/reply$/],
	['POST', /^\/send$/],
	['POST', /^\/uploads$/],
	['DELETE', /^\/uploads\/[^/]+$/],
	['GET', /^\/outbox\/[^/]+$/],
	['POST', /^\/outbox\/[^/]+\/cancel$/],
]

const matches = (rules: Rule[], method: string, path: string) => rules.some(([m, re]) => m === method && re.test(path))

function checkTokenAccess(token: ApiTokenRow, method: string, path: string) {
	if (matches(ANY_TOKEN, method, path)) return
	if (matches(READ, method, path)) {
		if (!token.canRead) throw new HttpError(403, 'This token cannot read mail', 'token_permission')
		return
	}
	if (matches(SEND, method, path)) {
		if (!token.canSend) throw new HttpError(403, 'This token cannot send mail', 'token_permission')
		return
	}
	throw new HttpError(403, 'API tokens cannot use this endpoint', 'token_not_allowed')
}

/** 600 requests a minute per token, so a runaway script can't take the server down. */
async function rateLimitToken(tokenId: string) {
	const key = `rl:token:${tokenId}:${Math.floor(Date.now() / 60_000)}`
	const n = await redis.incr(key)
	if (n === 1) await redis.expire(key, 90)
	if (n > 600)
		throw new HttpError(429, 'Too many requests for this token. Slow down and retry in a minute.', 'rate_limited')
}

/** Cookie sessions: a state-changing request must come from the app's own origin (on top of SameSite cookies). */
function checkOrigin(request: Request) {
	if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return
	const origin = request.headers.get('origin')
	if (!origin || !env.publicUrl) return
	if (new URL(origin).origin !== new URL(env.publicUrl).origin) throw new HttpError(403, 'Cross-site request refused')
}

async function resolveCaller(
	request: Request,
	cookie: Record<string, { value?: unknown }>,
	level: 'authed' | 'session' | 'enroll',
) {
	const raw = tokenFrom(request.headers, cookie)
	const viaBearer = !!request.headers.get('authorization')
	if (level === 'authed') {
		const api = await apiTokenAuth(raw)
		if (api) {
			const path = new URL(request.url).pathname
			checkTokenAccess(api.token, request.method, path)
			await rateLimitToken(api.token.id)
			return { user: { ...api.user, tokenScope: api.token.scope }, sessionId: null, token: api.token } satisfies Caller
		}
	}
	const session = await sessionForToken(raw)
	if (!session) throw new HttpError(401, 'Sign in first', 'signed_out')
	if (!viaBearer) checkOrigin(request)
	if (level !== 'enroll' && !session.verified)
		throw new HttpError(403, 'Set up a passkey or an authenticator app first', 'mfa_setup_required')
	return { user: session.user as ScopedUser, sessionId: session.sessionId, token: null } satisfies Caller
}

export const authed = new Elysia({ name: 'authed' }).resolve({ as: 'scoped' }, ({ request, cookie }) =>
	resolveCaller(request, cookie, 'authed'),
)

export const sessionAuth = new Elysia({ name: 'sessionAuth' }).resolve({ as: 'scoped' }, ({ request, cookie }) =>
	resolveCaller(request, cookie, 'session'),
)

export const enrollAuth = new Elysia({ name: 'enrollAuth' }).resolve({ as: 'scoped' }, ({ request, cookie }) =>
	resolveCaller(request, cookie, 'enroll'),
)

export const clientIp = (headers: Headers) =>
	headers.get('cf-connecting-ip') ??
	headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
	headers.get('x-real-ip') ??
	'local'
