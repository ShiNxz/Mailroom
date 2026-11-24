// The API: auth, users and access, projects/domains/mailboxes, mail views and actions, sending.
// The web app proxies /api/* here, so the browser only ever talks to the web app's origin.

import { Elysia } from 'elysia'
import { runMigrations } from './db'
import { env } from './env'
import { HttpError } from './lib/http'
import { log } from './lib/log'
import { adminRoutes } from './routes/admin'
import { appRoutes } from './routes/app'
import { authRoutes } from './routes/auth'
import { brandingRoutes } from './routes/branding'
import { composeRoutes } from './routes/compose'
import { eventRoutes } from './routes/events'
import { mailRoutes } from './routes/mail'
import { prefsRoutes } from './routes/prefs'
import { pushRoutes } from './routes/push'
import { securityRoutes } from './routes/security'
import { tokenRoutes } from './routes/tokens'

await runMigrations()

const app = new Elysia()
	.onError(({ error, code, set }) => {
		if (error instanceof HttpError) {
			set.status = error.status
			return error.code ? { error: error.message, code: error.code } : { error: error.message }
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
	.use(securityRoutes)
	.use(brandingRoutes)
	.use(adminRoutes)
	.use(mailRoutes)
	.use(composeRoutes)
	.use(prefsRoutes)
	.use(pushRoutes)
	.use(eventRoutes)
	.use(tokenRoutes)
	.use(appRoutes)
	.listen({
		port: env.port,
		hostname: '0.0.0.0',
		// API sends carry attachments as base64, a third bigger than the files
		maxRequestBodySize: Math.ceil(env.maxUploadBytes * 1.4) + 1024 * 1024,
		idleTimeout: 0,
	})

log.info('api listening', { port: app.server?.port })
if (!env.publicUrl)
	log.warn(
		'PUBLIC_URL is not set: passkeys use the browser origin and cross-site checks are off. Set it in production.',
	)

const stop = () => {
	app.stop()
	process.exit(0)
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
