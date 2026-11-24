// The API: auth, users and access, projects/domains/mailboxes, mail views and actions, sending.
// The web app proxies /api/* here, so the browser only ever talks to the web app's origin.

import { Elysia } from 'elysia'
import { runMigrations } from './db'
import { env } from './env'
import { HttpError } from './lib/http'
import { log } from './lib/log'
import { adminRoutes } from './routes/admin'
import { authRoutes } from './routes/auth'
import { brandingRoutes } from './routes/branding'
import { composeRoutes } from './routes/compose'
import { eventRoutes } from './routes/events'
import { mailRoutes } from './routes/mail'
import { prefsRoutes } from './routes/prefs'

await runMigrations()

const app = new Elysia()
	.onError(({ error, code, set }) => {
		if (error instanceof HttpError) {
			set.status = error.status
			return { error: error.message }
		}
		if (code === 'VALIDATION') {
			set.status = 400
			const first = (error as { all?: { path?: string; message?: string; summary?: string }[] }).all?.[0]
			const field = first?.path?.replace(/^\//, '')
			return { error: first ? `${field ? `${field}: ` : ''}${first.summary ?? first.message}` : 'Invalid request' }
		}
		if (code === 'NOT_FOUND') {
			set.status = 404
			return { error: 'Not found' }
		}
		if (code === 'PARSE') {
			set.status = 400
			return { error: 'Invalid request body' }
		}
		log.error('unhandled error', { err: error instanceof Error ? error : new Error(String(error)), code })
		set.status = 500
		return { error: 'Something went wrong on the server' }
	})
	.get('/health', () => ({ ok: true }))
	.use(authRoutes)
	.use(brandingRoutes)
	.use(adminRoutes)
	.use(mailRoutes)
	.use(composeRoutes)
	.use(prefsRoutes)
	.use(eventRoutes)
	.listen({ port: env.port, hostname: '0.0.0.0', maxRequestBodySize: env.maxUploadBytes + 1024 * 1024, idleTimeout: 0 })

log.info('api listening', { port: app.server?.port })

const stop = () => {
	app.stop()
	process.exit(0)
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
