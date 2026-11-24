import { type Branding, DEFAULT_BRANDING } from '@mailroom/shared'
import { eq } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import { requireAdmin } from '../access'
import { sessionAuth } from '../context'
import { db, schema } from '../db'
import { badRequest } from '../lib/http'
import { publishEvent } from '../lib/redis'

// The name and logo the apps show instead of "Mailroom". Public, because the sign-in page needs it.

const KEY = 'branding'

export async function getBranding(): Promise<Branding> {
	const [row] = await db.select().from(schema.appSettings).where(eq(schema.appSettings.key, KEY))
	const value = (row?.value ?? {}) as Partial<Branding>
	return { name: value.name?.trim() || DEFAULT_BRANDING.name, logoUrl: value.logoUrl || null }
}

function cleanLogoUrl(input: string | null | undefined): string | null {
	const url = input?.trim()
	if (!url) return null
	if (/^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,[a-z0-9+/=\s]+$/i.test(url)) {
		if (url.length > 300_000) throw badRequest('That image is too big. Use an image URL, or one under 200 KB.')
		return url
	}
	let parsed: URL
	try {
		parsed = new URL(url)
	} catch {
		throw badRequest('The logo must be an image URL starting with https://')
	}
	const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
	if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local))
		throw badRequest('The logo URL must start with https:// (browsers block http images on an https site)')
	if (url.length > 2000) throw badRequest('That URL is too long')
	return parsed.toString()
}

export const brandingRoutes = new Elysia()
	.get('/branding', () => getBranding())
	.use(sessionAuth)
	.put(
		'/admin/branding',
		async ({ user, body }) => {
			requireAdmin(user)
			const name = body.name.trim().slice(0, 40)
			const value: Branding = { name: name || DEFAULT_BRANDING.name, logoUrl: cleanLogoUrl(body.logoUrl) }
			await db
				.insert(schema.appSettings)
				.values({ key: KEY, value })
				.onConflictDoUpdate({ target: schema.appSettings.key, set: { value, updatedAt: new Date() } })
			await publishEvent({ type: 'branding' })
			return value
		},
		{
			body: t.Object({
				name: t.String({ maxLength: 100 }),
				logoUrl: t.Union([t.String({ maxLength: 400_000 }), t.Null()]),
			}),
		},
	)
