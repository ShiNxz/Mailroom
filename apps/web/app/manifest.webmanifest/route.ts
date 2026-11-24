import { brandingVersion, serverBranding } from '@/lib/server-branding'

// The installable app's manifest, with the name and icons from the branding (Settings > Branding).

export const dynamic = 'force-dynamic'

export async function GET() {
	const branding = await serverBranding()
	const v = brandingVersion(branding)
	const icon = (size: number, purpose: 'any' | 'maskable') => ({
		src: `/pwa/icon-${size}${purpose === 'maskable' ? '-maskable' : ''}.png?v=${v}`,
		sizes: `${size}x${size}`,
		type: 'image/png',
		purpose,
	})
	return Response.json(
		{
			id: '/mail',
			name: branding.name,
			short_name: branding.name.slice(0, 24),
			description: 'Mail for every project',
			start_url: '/mail',
			scope: '/',
			display: 'standalone',
			background_color: '#f7f7f8',
			theme_color: '#f7f7f8',
			icons: [icon(192, 'any'), icon(512, 'any'), icon(192, 'maskable'), icon(512, 'maskable')],
		},
		{ headers: { 'content-type': 'application/manifest+json', 'cache-control': 'public, max-age=300' } },
	)
}
