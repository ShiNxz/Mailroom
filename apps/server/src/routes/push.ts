import { and, count, eq } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import { accessibleMailboxIds } from '../access'
import { toUser } from '../auth'
import { sessionAuth } from '../context'
import { db, schema } from '../db'
import { HttpError, notFound } from '../lib/http'
import { getBranding } from './branding'
import { devicesOf, endpointHash, isPushHost, sealTarget, sendToDevice, vapidKeys } from '../push/push'
import { validTargetKeys } from '../push/web-push'

// Turning push notifications on and off per device (Settings > Notifications). Only signed-in, verified
// sessions; a device belongs to the session that added it and goes away with it.

const MAX_DEVICES = 20

export const pushRoutes = new Elysia({ prefix: '/push' })
	.use(sessionAuth)
	.get('/', async ({ user, sessionId }) => {
		const rows = await devicesOf(user.id)
		return {
			publicKey: (await vapidKeys()).publicKey,
			devices: rows.map(d => ({
				id: d.id,
				label: d.label,
				endpointHash: d.endpointHash,
				createdAt: d.createdAt.toISOString(),
				lastSentAt: d.lastSentAt?.toISOString() ?? null,
				failing: d.failures > 0,
				lastError: d.lastError,
				current: d.sessionId === sessionId,
			})),
		}
	})

	.post(
		'/devices',
		async ({ user, sessionId, body }) => {
			let url: URL
			try {
				url = new URL(body.endpoint)
			} catch {
				throw new HttpError(400, 'That is not a push address')
			}
			if (url.protocol !== 'https:' || !isPushHost(url.hostname))
				throw new HttpError(400, "This browser's push service isn't supported")
			if (!validTargetKeys(body)) throw new HttpError(400, 'The browser sent keys that are not valid')
			const hash = endpointHash(body.endpoint)
			const [n] = await db.select({ n: count() }).from(schema.pushDevices).where(eq(schema.pushDevices.userId, user.id))
			if ((n?.n ?? 0) >= MAX_DEVICES) throw new HttpError(400, `Up to ${MAX_DEVICES} devices. Remove one first.`)
			// One row per browser: signing in as someone else on the same browser moves it to them
			await db.delete(schema.pushDevices).where(eq(schema.pushDevices.endpointHash, hash))
			const [row] = await db
				.insert(schema.pushDevices)
				.values({
					userId: user.id,
					sessionId: sessionId!,
					endpointHash: hash,
					subscription: sealTarget(body),
					label: body.label.trim().slice(0, 80) || 'Browser',
				})
				.returning()
			return { id: row!.id }
		},
		{
			body: t.Object({
				endpoint: t.String({ maxLength: 2000 }),
				p256dh: t.String({ maxLength: 200 }),
				auth: t.String({ maxLength: 100 }),
				label: t.String({ maxLength: 200 }),
			}),
		},
	)

	// Which mailboxes notify: the ones listed here don't, every other one the person can open does
	.put(
		'/muted',
		async ({ user, body }) => {
			const mine = new Set(await accessibleMailboxIds(user))
			// Mailboxes they can't open stay out; one they lose access to drops out at the next save
			const notifyMuted = [...new Set(body.muted)].filter(id => mine.has(id))
			const [updated] = await db
				.update(schema.users)
				.set({ settings: { ...user.settings, notifyMuted } })
				.where(eq(schema.users.id, user.id))
				.returning()
			return { user: toUser(updated!) }
		},
		{ body: t.Object({ muted: t.Array(t.String({ maxLength: 64 }), { maxItems: 1000 }) }) },
	)

	.delete('/devices/:id', async ({ user, params }) => {
		await db
			.delete(schema.pushDevices)
			.where(and(eq(schema.pushDevices.id, params.id), eq(schema.pushDevices.userId, user.id)))
		return { ok: true }
	})

	// A test notification to one of your devices, so you can see it works
	.post('/devices/:id/test', async ({ user, params }) => {
		const [device] = await db
			.select()
			.from(schema.pushDevices)
			.where(and(eq(schema.pushDevices.id, params.id), eq(schema.pushDevices.userId, user.id)))
		if (!device) throw notFound('No such device')
		const branding = await getBranding()
		const result = await sendToDevice(
			device,
			{
				title: branding.name,
				body: 'Notifications work on this device. New mail will show up like this.',
				url: '/mail',
				tag: 'test',
				at: Date.now(),
			},
			60,
		)
		if (result === 'gone')
			throw new HttpError(410, 'This device dropped its subscription. Turn notifications on again.')
		if (result === 'failed') throw new HttpError(502, 'The push service did not take it. Try again in a moment.')
		return { ok: true }
	})
