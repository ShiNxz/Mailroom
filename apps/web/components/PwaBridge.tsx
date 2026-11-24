'use client'

import { useRouter } from 'next/navigation'
import { useEffect } from 'react'
import useSWR from 'swr'
import { fetcher } from '@/lib/api'
import { canPush, syncThisBrowser, workerRegistration } from '@/lib/pwa'

export interface PushState {
	publicKey: string
	devices: {
		id: string
		label: string
		endpointHash: string
		createdAt: string
		lastSentAt: string | null
		failing: boolean
		lastError: string | null
		current: boolean
	}[]
}

/**
 * In the signed-in app: registers the service worker (the app installs, pushes show), opens the
 * conversation a tapped notification points at, and drops a subscription the server no longer has.
 */
export function PwaBridge() {
	const router = useRouter()
	const { data } = useSWR<PushState>('/push', fetcher, { revalidateOnFocus: false })

	useEffect(() => {
		if (!canPush()) return
		void workerRegistration(true).catch(() => {})
		const onMessage = (e: MessageEvent) => {
			const msg = e.data as { type?: string; url?: string } | null
			if (msg?.type === 'open' && typeof msg.url === 'string' && msg.url.startsWith('/') && !msg.url.startsWith('//'))
				router.push(msg.url)
		}
		navigator.serviceWorker.addEventListener('message', onMessage)
		return () => navigator.serviceWorker.removeEventListener('message', onMessage)
	}, [router])

	useEffect(() => {
		if (data) void syncThisBrowser(data.devices, data.publicKey).catch(() => {})
	}, [data])

	return null
}
