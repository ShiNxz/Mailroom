import type { ServerEvent } from '@mailroom/shared'
import { Elysia } from 'elysia'
import { accessibleMailboxIds } from '../access'
import { authed } from '../context'
import { EVENTS_CHANNEL, subscribe } from '../lib/redis'

// Server-sent events: one Redis subscription per API process, fanned out to every open browser tab,
// each only getting events for mailboxes it may see.

type Listener = (event: ServerEvent) => void
const listeners = new Set<Listener>()
let subscribed = false

function ensureSubscribed() {
	if (subscribed) return
	subscribed = true
	subscribe<ServerEvent>(EVENTS_CHANNEL, event => {
		for (const l of listeners) l(event)
	})
}

export const eventRoutes = new Elysia().use(authed).get('/events', async ({ user, request }) => {
	ensureSubscribed()
	let allowed = new Set(await accessibleMailboxIds(user))
	const encoder = new TextEncoder()
	let cleanup = () => {}

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const send = (data: string) => {
				try {
					controller.enqueue(encoder.encode(data))
				} catch {
					cleanup()
				}
			}
			const listener: Listener = event => {
				if (event.type === 'access') {
					void accessibleMailboxIds(user).then(ids => {
						allowed = new Set(ids)
						send(`data: ${JSON.stringify(event)}\n\n`)
					})
					return
				}
				if (!allowed.has(event.mailboxId)) return
				send(`data: ${JSON.stringify(event)}\n\n`)
			}
			listeners.add(listener)
			// Comments keep proxies from closing an idle stream
			const heartbeat = setInterval(() => send(': ping\n\n'), 25_000)
			send('retry: 3000\n: connected\n\n')
			cleanup = () => {
				clearInterval(heartbeat)
				listeners.delete(listener)
				try {
					controller.close()
				} catch {}
			}
			request.signal.addEventListener('abort', () => cleanup())
		},
		cancel() {
			cleanup()
		},
	})

	return new Response(stream, {
		headers: {
			'content-type': 'text/event-stream; charset=utf-8',
			'cache-control': 'no-store, no-transform',
			connection: 'keep-alive',
			'x-accel-buffering': 'no',
		},
	})
})
