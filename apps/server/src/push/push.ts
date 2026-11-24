// Push notifications for new mail, to the installed app (PWA) and browsers that turned them on.
//
// Who gets one is decided when the mail arrives: every device whose person can read that mailbox right
// now (owner and admins: all mailboxes; members: their projects or picked mailboxes). Losing access, being
// disabled, signing out or a reset stops them at once: devices belong to the session that added them.
// The message is encrypted for each browser (web-push.ts); the push service can't read it.

import { createHash } from 'node:crypto'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { accessibleMailboxIds } from '../access'
import { db, schema } from '../db'
import { env } from '../env'
import { decryptSecret, encryptSecret } from '../lib/crypto'
import { errorMessage, log } from '../lib/log'
import { redis } from '../lib/redis'
import { generateVapidKeys, maxPushPayloadBytes, type PushTarget, pushRequest, type VapidKeys } from './web-push'

type DeviceRow = typeof schema.pushDevices.$inferSelect

/** Push services we send to: the browser makers'. Any other endpoint is refused, so a device can't point us anywhere. */
const PUSH_HOSTS = [
	'fcm.googleapis.com',
	'jmt17.google.com',
	'updates.push.services.mozilla.com',
	'push.services.mozilla.com',
	'web.push.apple.com',
	'notify.windows.com',
]
export const isPushHost = (hostname: string) => {
	const host = hostname.toLowerCase()
	return PUSH_HOSTS.some(known => host === known || host.endsWith(`.${known}`))
}

export const endpointHash = (endpoint: string) => createHash('sha256').update(endpoint).digest('hex')

export const sealTarget = (target: PushTarget) =>
	encryptSecret(JSON.stringify({ endpoint: target.endpoint, p256dh: target.p256dh, auth: target.auth }))

function openTarget(row: DeviceRow): PushTarget | null {
	try {
		return JSON.parse(decryptSecret(row.subscription)) as PushTarget
	} catch {
		return null
	}
}

// --- Keys ----------------------------------------------------------------------------------------

const VAPID_KEY = 'push_vapid'
let cachedKeys: VapidKeys | null = null

/** The server's VAPID key pair, made the first time it is needed. Browsers bind a subscription to the public key. */
export async function vapidKeys(): Promise<VapidKeys> {
	if (cachedKeys) return cachedKeys
	const read = async () => {
		const [row] = await db.select().from(schema.appSettings).where(eq(schema.appSettings.key, VAPID_KEY))
		const value = row?.value as { publicKey: string; privateKey: string } | undefined
		return value ? { publicKey: value.publicKey, privateKey: decryptSecret(value.privateKey) } : null
	}
	let keys = await read()
	if (!keys) {
		const fresh = generateVapidKeys()
		// The API and the worker may both get here first: whichever insert wins, both use what is stored
		await db
			.insert(schema.appSettings)
			.values({ key: VAPID_KEY, value: { publicKey: fresh.publicKey, privateKey: encryptSecret(fresh.privateKey) } })
			.onConflictDoNothing()
		keys = await read()
	}
	if (!keys) throw new Error('Could not store the push keys')
	cachedKeys = keys
	return keys
}

/** How the push services can reach whoever runs this server: its address. */
const subject = () => env.publicUrl ?? 'mailto:postmaster@localhost'

// --- Sending -------------------------------------------------------------------------------------

export interface PushMessage {
	title: string
	body: string
	/** A path in the app to open when tapped */
	url: string
	/** A newer message with the same tag replaces the old one (one per conversation) */
	tag: string
	at: number
}

const MAX_FAILURES = 5
/** At most this many pushes per device in BURST_WINDOW; the rest are dropped (the app still shows the mail) */
const BURST_LIMIT = 30
const BURST_WINDOW = 10 * 60

type Result = 'sent' | 'gone' | 'failed'

/** Sends one message to one device. Never throws; removes devices the push service says are gone. */
export async function sendToDevice(device: DeviceRow, message: PushMessage, ttlSeconds = 24 * 3600): Promise<Result> {
	const target = openTarget(device)
	let result: Result = 'failed'
	let error: string | null = null
	if (!target) error = 'The subscription could not be read'
	else
		try {
			const url = new URL(target.endpoint)
			if (url.protocol !== 'https:' || !isPushHost(url.hostname)) throw new Error('Not a known push service')
			let payload = Buffer.from(JSON.stringify(message))
			if (payload.length > maxPushPayloadBytes)
				payload = Buffer.from(JSON.stringify({ ...message, body: message.body.slice(0, 500) }))
			const request = pushRequest(target, payload, {
				keys: await vapidKeys(),
				subject: subject(),
				ttlSeconds,
				urgency: 'high',
				topic: createHash('sha256').update(message.tag).digest('base64url').slice(0, 32),
			})
			const res = await fetch(request.url, { ...request.init, signal: AbortSignal.timeout(10_000) })
			await res.body?.cancel().catch(() => {})
			if (res.ok) result = 'sent'
			else if (res.status === 404 || res.status === 410) result = 'gone'
			else error = `The push service answered ${res.status}`
		} catch (err) {
			error = errorMessage(err).slice(0, 200)
		}

	if (result === 'gone') await db.delete(schema.pushDevices).where(eq(schema.pushDevices.id, device.id))
	else if (result === 'sent')
		await db
			.update(schema.pushDevices)
			.set({ failures: 0, lastError: null, lastSentAt: new Date() })
			.where(eq(schema.pushDevices.id, device.id))
	else {
		const [row] = await db
			.update(schema.pushDevices)
			.set({ failures: sql`${schema.pushDevices.failures} + 1`, lastError: error })
			.where(eq(schema.pushDevices.id, device.id))
			.returning({ failures: schema.pushDevices.failures })
		if (row && row.failures >= MAX_FAILURES)
			await db.delete(schema.pushDevices).where(eq(schema.pushDevices.id, device.id))
	}
	return result
}

async function takeBurstSlot(deviceId: string) {
	const key = `push:burst:${deviceId}`
	const n = await redis.incr(key)
	if (n === 1) await redis.expire(key, BURST_WINDOW)
	return n <= BURST_LIMIT
}

/** Pushes a new message to everyone who may read its mailbox. Runs in the worker; never throws. */
export async function pushNewMail(messageId: string) {
	try {
		const devices = await db
			.select({ device: schema.pushDevices, user: schema.users })
			.from(schema.pushDevices)
			.innerJoin(schema.users, eq(schema.users.id, schema.pushDevices.userId))
			.innerJoin(schema.sessions, eq(schema.sessions.id, schema.pushDevices.sessionId))
			// A live, verified session that is not expired, and an enabled person
			.where(
				and(
					eq(schema.users.disabled, false),
					sql`${schema.sessions.mfaAt} is not null`,
					sql`${schema.sessions.expiresAt} > now()`,
				),
			)
		if (!devices.length) return
		const [row] = await db
			.select({ m: schema.messages, mailbox: schema.mailboxes })
			.from(schema.messages)
			.innerJoin(schema.mailboxes, eq(schema.mailboxes.id, schema.messages.mailboxId))
			.where(eq(schema.messages.id, messageId))
		if (!row) return
		const { m, mailbox } = row
		// Read already (on a phone, another client), or mail the mailbox sent itself: nothing to tell
		if (m.seen || m.fromAddress.toLowerCase() === mailbox.address.toLowerCase()) return

		const message: PushMessage = {
			title: m.fromName || m.fromAddress || 'New mail',
			body: [m.subject || '(no subject)', m.snippet].filter(Boolean).join('\n').slice(0, 1000),
			url: `/mail?t=${encodeURIComponent(m.threadId)}`,
			tag: `thread:${m.threadId}`,
			at: m.date.getTime(),
		}
		// Access is checked now, per person, so it always matches what they can open
		const allowed = new Map<string, boolean>()
		const sends: Promise<unknown>[] = []
		for (const { device, user } of devices) {
			if (!allowed.has(user.id)) allowed.set(user.id, (await accessibleMailboxIds(user)).includes(mailbox.id))
			if (!allowed.get(user.id)) continue
			if (!(await takeBurstSlot(device.id))) continue
			sends.push(sendToDevice(device, message))
		}
		await Promise.allSettled(sends)
	} catch (err) {
		log.warn('push for new mail failed', { message: messageId, err: errorMessage(err) })
	}
}

/** A person's devices, newest first. */
export const devicesOf = (userId: string) =>
	db
		.select()
		.from(schema.pushDevices)
		.where(eq(schema.pushDevices.userId, userId))
		.orderBy(sql`${schema.pushDevices.createdAt} desc`)

export const removeDevices = (userId: string, ids: string[]) =>
	ids.length
		? db
				.delete(schema.pushDevices)
				.where(and(eq(schema.pushDevices.userId, userId), inArray(schema.pushDevices.id, ids)))
		: Promise.resolve()
