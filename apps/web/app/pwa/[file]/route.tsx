import { ImageResponse } from 'next/og'
import { serverBranding } from '@/lib/server-branding'

// The installed app's icons, drawn from the branding logo (or the envelope mark without one):
// home screen icons, the iPhone one, and the small monochrome badge Android shows in the status bar.

export const dynamic = 'force-dynamic'

type Kind = 'icon' | 'maskable' | 'badge'
const FILES: Record<string, { size: number; kind: Kind }> = {
	'icon-192.png': { size: 192, kind: 'icon' },
	'icon-512.png': { size: 512, kind: 'icon' },
	'icon-192-maskable.png': { size: 192, kind: 'maskable' },
	'icon-512-maskable.png': { size: 512, kind: 'maskable' },
	// iOS rounds the corners itself and wants a full square
	'apple-touch-icon.png': { size: 180, kind: 'maskable' },
	'badge-96.png': { size: 96, kind: 'badge' },
}

/** The logo as a data URL the renderer can draw, or null (then the envelope mark is used). */
async function logoData(url: string | null): Promise<string | null> {
	if (!url) return null
	if (/^data:image\/(png|jpe?g|gif|svg\+xml);base64,/i.test(url)) return url
	try {
		const u = new URL(url)
		const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1'
		if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null
		const res = await fetch(u, { signal: AbortSignal.timeout(5000) })
		if (!res.ok) return null
		const type = res.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? ''
		// The renderer reads PNG, JPEG, GIF and SVG
		if (!/^image\/(png|jpe?g|gif|svg\+xml)$/.test(type)) return null
		const bytes = Buffer.from(await res.arrayBuffer())
		if (bytes.length > 2_000_000) return null
		return `data:${type};base64,${bytes.toString('base64')}`
	} catch {
		return null
	}
}

function Envelope({ size, stroke }: { size: number; stroke: number }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="white"
			strokeWidth={stroke}
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<rect x="3" y="5" width="18" height="14" rx="2.5" />
			<path d="m3.5 7 8.5 6 8.5-6" />
		</svg>
	)
}

export async function GET(_req: Request, { params }: { params: Promise<{ file: string }> }) {
	const { file } = await params
	const spec = FILES[file]
	if (!spec) return new Response('Not found', { status: 404 })
	const { size, kind } = spec
	const headers = { 'cache-control': 'public, max-age=300' }

	if (kind === 'badge')
		return new ImageResponse(
			<div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
				<Envelope size={size * 0.9} stroke={2.6} />
			</div>,
			{ width: size, height: size, headers },
		)

	const branding = await serverBranding()
	const logo = await logoData(branding.logoUrl)
	// Maskable icons get cropped to a circle or squircle: keep the mark inside the middle 60%
	const inner = kind === 'maskable' ? 0.6 : 0.72
	const radius = kind === 'maskable' ? 0 : size * 0.22

	return new ImageResponse(
		logo ? (
			<div
				style={{
					width: '100%',
					height: '100%',
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'center',
					background: 'white',
					borderRadius: radius,
				}}
			>
				{/* biome-ignore lint/performance/noImgElement: drawn into a PNG, not a page */}
				<img src={logo} width={size * inner} height={size * inner} style={{ objectFit: 'contain' }} alt="" />
			</div>
		) : (
			<div
				style={{
					width: '100%',
					height: '100%',
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'center',
					background: 'linear-gradient(180deg, #6b73fa 0%, #4d45d9 100%)',
					borderRadius: radius,
				}}
			>
				<Envelope size={size * inner * 0.75} stroke={1.8} />
			</div>
		),
		{ width: size, height: size, headers },
	)
}
