// Every setting comes from the environment (Seylo service env, or apps/server/.env locally, which Bun loads).

function required(name: string): string {
	const value = process.env[name]
	if (!value) throw new Error(`${name} is not set (see apps/server/.env.example)`)
	return value
}

const appSecret = required('APP_SECRET')
if (appSecret.length < 32) throw new Error('APP_SECRET must be at least 32 characters (openssl rand -hex 32)')

export const env = {
	databaseUrl: required('DATABASE_URL'),
	redisUrl: required('REDIS_URL'),
	/** Encrypts mailbox passwords at rest. Changing it makes every saved mailbox password unreadable. */
	appSecret,
	port: Number(process.env.PORT ?? 3001),
	/** Postgres over TLS without checking the certificate, for an exposed Seylo database during local dev. */
	databaseSsl: process.env.DATABASE_SSL === 'require' ? ('require' as const) : undefined,
	/** Largest single upload for outgoing attachments. */
	maxUploadBytes: Number(process.env.MAX_UPLOAD_MB ?? 25) * 1024 * 1024,
	/** How long a web session lasts without use. */
	sessionDays: Number(process.env.SESSION_DAYS ?? 30),
	logLevel: process.env.LOG_LEVEL ?? 'info',
	/** The web app's address (https://mail.example.com). Passkeys are bound to its host name. */
	publicUrl: process.env.PUBLIC_URL?.replace(/\/$/, '') || null,
	/** Webhooks to private and loopback addresses are refused unless this is set (local dev only). */
	webhookAllowPrivate: process.env.WEBHOOK_ALLOW_PRIVATE === '1',
	/** When set, the first-run setup (creating the owner) needs this token, so a fresh install can't be claimed by a stranger. */
	setupToken: process.env.SETUP_TOKEN || null,
}
