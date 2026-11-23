import { Elysia } from 'elysia'
import { tokenFrom, userForToken } from './auth'
import { HttpError } from './lib/http'

/** Adds `user` to every route of the plugin that uses it; answers 401 without a valid session. */
export const authed = new Elysia({ name: 'authed' }).resolve({ as: 'scoped' }, async ({ request, cookie }) => {
	const user = await userForToken(tokenFrom(request.headers, cookie))
	if (!user) throw new HttpError(401, 'Sign in first')
	return { user }
})

export const clientIp = (headers: Headers) =>
	headers.get('cf-connecting-ip') ??
	headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
	headers.get('x-real-ip') ??
	'local'
