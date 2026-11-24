// Mailroom's service worker: push notifications for new mail, nothing else. It caches nothing, so every
// page still comes from the server and an update never leaves anyone on an old screen.
//
// A push is the JSON the server encrypts for this browser (apps/server/src/push/push.ts):
// { title, body, url, tag, at }.

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))

/** Only a path in this app: a message can never open another site. */
function appPath(url) {
	return typeof url === 'string' && url.startsWith('/') && !url.startsWith('//') && !url.startsWith('/\\') ? url : '/mail'
}

self.addEventListener('push', event => {
	let message = {}
	try {
		message = event.data ? event.data.json() : {}
	} catch {
		message = { body: event.data ? event.data.text() : '' }
	}
	const title = typeof message.title === 'string' && message.title ? message.title : 'New mail'
	event.waitUntil(
		self.registration.showNotification(title, {
			body: typeof message.body === 'string' ? message.body : '',
			// One notification per conversation: a newer message in it replaces the older one
			tag: typeof message.tag === 'string' ? message.tag : undefined,
			renotify: typeof message.tag === 'string',
			icon: '/pwa/icon-192.png',
			badge: '/pwa/badge-96.png',
			timestamp: typeof message.at === 'number' ? message.at : Date.now(),
			data: { url: appPath(message.url) },
		}),
	)
})

self.addEventListener('notificationclick', event => {
	event.notification.close()
	const path = appPath(event.notification.data && event.notification.data.url)
	event.waitUntil(
		(async () => {
			const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
			const open = windows.find(client => new URL(client.url).origin === self.location.origin)
			if (open) {
				// The app moves there without a reload (lib/pwa.ts listens); focus first, as browsers require
				await open.focus()
				open.postMessage({ type: 'open', url: path })
				return
			}
			await self.clients.openWindow(path)
		})(),
	)
})
