// Webhook deliveries: every event a token may see is POSTed to its URL, signed with the token's
// webhook secret. Retries back off up to about 10 hours. URLs must be public (no private, loopback or
// link-local addresses) so a webhook can't be used to reach services inside the network.

import { createHmac } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { eq, inArray, sql } from 'drizzle-orm'
import { toApiEvents } from '../api-format'
import { db, schema } from '../db'
import { env } from '../env'
import { decryptSecret } from '../lib/crypto'
import { HttpError } from '../lib/http'
import { errorMessage, log } from '../lib/log'

const BACKOFF_MINUTES = [1, 5, 15, 60, 180, 360]
const TIMEOUT_MS = 10_000

export function signWebhook(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)) {
	const v1 = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
	return `t=${timestamp},v1=${v1}`
}

// --- Keeping webhooks off the internal network ----------------------------------------------------

function ipv4Private(ip: string) {
	const [a = 0, b = 0, c = 0] = ip.split('.').map(Number)
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 192 && b === 0 && c === 0) ||
		(a === 198 && (b === 18 || b === 19)) ||
		a >= 224
	)
}

function ipPrivate(ip: string) {
	if (isIP(ip) === 4) return ipv4Private(ip)
	const v6 = ip.toLowerCase().replace(/^\[|\]$/g, '')
	const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
	if (mapped) return ipv4Private(mapped[1]!)
	// Hex-written IPv4-mapped addresses (the URL parser turns ::ffff:127.0.0.1 into ::ffff:7f00:1)
	const hex = v6.match(/^(?:0{1,4}:){0,5}:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
	if (hex) {
		const hi = Number.parseInt(hex[1]!, 16)
		const lo = Number.parseInt(hex[2]!, 16)
		return ipv4Private(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)
	}
	return (
		// ::, ::1 and the IPv4-compatible and mapped forms: nothing public starts with ::
		v6.startsWith('::') ||
		v6.startsWith('fc') ||
		v6.startsWith('fd') ||
		v6.startsWith('fe8') ||
		v6.startsWith('fe9') ||
		v6.startsWith('fea') ||
		v6.startsWith('feb') ||
		v6.startsWith('ff') ||
		v6.startsWith('64:ff9b:')
	)
}

/** Throws unless the URL is https on a public host. WEBHOOK_ALLOW_PRIVATE=1 lifts this for local testing. */
export async function assertWebhookUrl(raw: string) {
	let url: URL
	try {
		url = new URL(raw)
	} catch {
		throw new HttpError(400, 'The webhook URL is not a valid URL')
	}
	if (url.username || url.password) throw new HttpError(400, 'Leave credentials out of the webhook URL')
	if (env.webhookAllowPrivate) {
		if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new HttpError(400, 'Use an http or https URL')
		return url
	}
	if (url.protocol !== 'https:') throw new HttpError(400, 'Webhook URLs must use https')
	const host = url.hostname.replace(/^\[|\]$/g, '')
	if (isIP(host)) {
		if (ipPrivate(host)) throw new HttpError(400, 'Webhook URLs must point to a public address')
		return url
	}
	if (!host.includes('.') || /\.(local|internal|localhost|lan|home|arpa)$/i.test(host))
		throw new HttpError(400, 'Webhook URLs must point to a public host')
	let addresses: { address: string }[]
	try {
		addresses = await lookup(host, { all: true, verbatim: true })
	} catch {
		throw new HttpError(400, `Could not find ${host} in DNS`)
	}
	if (!addresses.length || addresses.some(a => ipPrivate(a.address)))
		throw new HttpError(400, 'Webhook URLs must point to a public address')
	return url
}

/** One POST. Returns the HTTP status, or throws with a short reason. */
export async function postWebhook(urlRaw: string, secret: string, body: string, headers: Record<string, string>) {
	// Checked again right before each delivery, since DNS can change after the token was saved
	const url = await assertWebhookUrl(urlRaw)
	const res = await fetch(url, {
		method: 'POST',
		redirect: 'manual',
		signal: AbortSignal.timeout(TIMEOUT_MS),
		headers: {
			'content-type': 'application/json',
			'user-agent': 'Mailroom-Webhooks/1',
			'mailroom-signature': signWebhook(secret, body),
			...headers,
		},
		body,
	})
	// Drain without keeping it: nothing from the response is stored or shown except the status
	await res.body?.cancel().catch(() => {})
	return res.status
}

// --- The delivery loop (worker) -------------------------------------------------------------------

export async function deliverWebhooks() {
	for (let round = 0; round < 10; round++) {
		// Claim a batch; the lease (next_attempt_at two minutes out) covers a worker that dies mid-delivery
		const claimed = (await db.execute(sql`
			update webhook_deliveries set attempts = attempts + 1, next_attempt_at = now() + interval '2 minutes'
			where id in (
				select id from webhook_deliveries where status = 'pending' and next_attempt_at <= now()
				order by next_attempt_at limit 20 for update skip locked
			)
			returning id`)) as unknown as { id: number | string }[]
		if (!claimed.length) return
		const rows = await db
			.select({ d: schema.webhookDeliveries, token: schema.apiTokens, event: schema.mailEvents })
			.from(schema.webhookDeliveries)
			.innerJoin(schema.apiTokens, eq(schema.apiTokens.id, schema.webhookDeliveries.tokenId))
			.innerJoin(schema.mailEvents, eq(schema.mailEvents.id, schema.webhookDeliveries.eventId))
			.where(
				inArray(
					schema.webhookDeliveries.id,
					claimed.map(c => Number(c.id)),
				),
			)
		await Promise.all(rows.map(r => deliverOne(r.d, r.token, r.event)))
	}
}

async function deliverOne(
	d: typeof schema.webhookDeliveries.$inferSelect,
	token: typeof schema.apiTokens.$inferSelect,
	event: typeof schema.mailEvents.$inferSelect,
) {
	const finish = (set: Partial<typeof schema.webhookDeliveries.$inferInsert>) =>
		db.update(schema.webhookDeliveries).set(set).where(eq(schema.webhookDeliveries.id, d.id))
	if (token.revokedAt || !token.webhookUrl || !token.webhookSecret || (token.expiresAt && token.expiresAt < new Date()))
		return finish({ status: 'failed', lastError: 'The token was revoked or its webhook removed' })
	const [payload] = await toApiEvents([event])
	if (!payload) return finish({ status: 'failed', lastError: 'The message is gone' })
	let status: number | null = null
	let error: string | null = null
	try {
		status = await postWebhook(token.webhookUrl, decryptSecret(token.webhookSecret), JSON.stringify(payload), {
			'mailroom-event': payload.type,
			'mailroom-delivery': String(d.id),
		})
		if (status >= 200 && status < 300) return finish({ status: 'delivered', responseStatus: status, lastError: null })
		error = `The endpoint answered ${status}`
	} catch (err) {
		error = err instanceof HttpError ? err.message : errorMessage(err).slice(0, 300)
	}
	const wait = BACKOFF_MINUTES[d.attempts - 1]
	log.info('webhook delivery failed', { token: token.id, delivery: d.id, attempts: d.attempts, error })
	return finish(
		wait === undefined
			? { status: 'failed', responseStatus: status, lastError: error }
			: { responseStatus: status, lastError: error, nextAttemptAt: new Date(Date.now() + wait * 60_000) },
	)
}
