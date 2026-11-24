import { type Branding, DEFAULT_BRANDING } from '@mailroom/shared'
import { createHash } from 'node:crypto'

// The branding, read on the server (root layout, manifest, app icons). Cached for 30 seconds.

const API_URL = (process.env.API_URL ?? 'http://localhost:3001').replace(/\/$/, '')

export async function serverBranding(): Promise<Branding> {
	try {
		const res = await fetch(`${API_URL}/branding`, { next: { revalidate: 30 }, signal: AbortSignal.timeout(2000) })
		if (res.ok) return (await res.json()) as Branding
	} catch {}
	return DEFAULT_BRANDING
}

/** Changes when the branding does, so installed apps and browsers fetch the new icons. */
export const brandingVersion = (b: Branding) =>
	createHash('sha256')
		.update(`${b.name}|${b.logoUrl ?? ''}`)
		.digest('hex')
		.slice(0, 10)
