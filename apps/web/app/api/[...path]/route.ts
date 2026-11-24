import type { NextRequest } from 'next/server'

// The browser only talks to this app. Every /api/* request is passed to the API service, so the
// session cookie is first-party on whatever domain this app runs on and the API needs no public
// domain or CORS. API_URL is read at runtime: changing it needs a restart, not a rebuild.
const API_URL = (process.env.API_URL ?? 'http://localhost:3001').replace(/\/$/, '')

// origin: the API refuses cross-site writes, and passkeys are checked against it
const FORWARDED_REQUEST_HEADERS = ['cookie', 'content-type', 'authorization', 'accept', 'user-agent', 'last-event-id', 'origin']
// fetch() already decoded the body, and Node sets its own framing headers
const DROPPED_RESPONSE_HEADERS = new Set([
	'connection',
	'keep-alive',
	'transfer-encoding',
	'content-encoding',
	'content-length',
])

export const dynamic = 'force-dynamic'

async function proxy(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
	const { path } = await params
	const url = new URL(request.url)
	const target = `${API_URL}/${path.map(encodeURIComponent).join('/')}${url.search}`
	const isStream = path[0] === 'events'
	const isUpload = path[0] === 'uploads'

	const headers = new Headers()
	for (const name of FORWARDED_REQUEST_HEADERS) {
		const value = request.headers.get(name)
		if (value) headers.set(name, value)
	}
	// Tells the API whether to mark the session cookie Secure, and who the client is for login throttling
	headers.set('x-forwarded-proto', request.headers.get('x-forwarded-proto') ?? url.protocol.replace(':', ''))
	const ip =
		request.headers.get('cf-connecting-ip') ??
		request.headers.get('x-forwarded-for') ??
		request.headers.get('x-real-ip')
	if (ip) headers.set('x-forwarded-for', ip)

	let upstream: Response
	try {
		upstream = await fetch(target, {
			method: request.method,
			headers,
			body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer(),
			cache: 'no-store',
			redirect: 'manual',
			// The event stream stays open; everything else gets a deadline
			signal: isStream ? request.signal : AbortSignal.timeout(isUpload ? 120_000 : 60_000),
		})
	} catch {
		// 503, not 502: Seylo swaps 502/504 answers for its own status page and the message would be lost
		return Response.json({ error: 'The mail server is not reachable right now' }, { status: 503 })
	}

	const out = new Headers()
	upstream.headers.forEach((value, name) => {
		if (!DROPPED_RESPONSE_HEADERS.has(name) && name !== 'set-cookie') out.set(name, value)
	})
	for (const cookie of upstream.headers.getSetCookie()) out.append('set-cookie', cookie)
	if (!out.has('cache-control')) out.set('cache-control', 'no-store')

	return new Response(upstream.body, { status: upstream.status, headers: out })
}

export { proxy as GET, proxy as POST, proxy as PUT, proxy as PATCH, proxy as DELETE }
