'use client'

import { type Branding, DEFAULT_BRANDING } from '@mailroom/shared'
import { Mail } from 'lucide-react'
import { useEffect, useState } from 'react'
import useSWR from 'swr'
import { fetcher } from '@/lib/api'

/** The instance's name and logo (Settings > Branding), with the defaults until it loads. */
export function useBranding(): Branding {
	const { data } = useSWR<Branding>('/branding', fetcher, { revalidateOnFocus: false, dedupingInterval: 60_000 })
	return data ?? DEFAULT_BRANDING
}

/** The logo, or the default envelope mark when there is none or it fails to load. */
export function BrandMark({ branding, size = 28 }: { branding: Branding; size?: number }) {
	const [broken, setBroken] = useState(false)
	useEffect(() => setBroken(false), [branding.logoUrl])
	if (branding.logoUrl && !broken)
		return (
			// biome-ignore lint/performance/noImgElement: any external URL, so next/image doesn't fit
			<img
				src={branding.logoUrl}
				alt=""
				width={size}
				height={size}
				onError={() => setBroken(true)}
				className="shrink-0 rounded-lg object-contain"
				style={{ width: size, height: size }}
				referrerPolicy="no-referrer"
			/>
		)
	return (
		<div
			className="flex shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground"
			style={{ width: size, height: size, borderRadius: size * 0.28 }}
		>
			<Mail style={{ width: size * 0.55, height: size * 0.55 }} />
		</div>
	)
}

/** Keeps the tab title and favicon in line with the branding. */
export function useBrandingInDocument(branding: Branding, page?: string) {
	useEffect(() => {
		document.title = page ? `${page} · ${branding.name}` : branding.name
		let link = document.querySelector<HTMLLinkElement>('link[rel="icon"][data-brand]')
		if (branding.logoUrl) {
			if (!link) {
				link = document.createElement('link')
				link.rel = 'icon'
				link.dataset.brand = '1'
				document.head.appendChild(link)
			}
			link.href = branding.logoUrl
		} else link?.remove()
	}, [branding.name, branding.logoUrl, page])
}
