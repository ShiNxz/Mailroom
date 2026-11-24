'use client'

import { Menu } from 'lucide-react'
import { usePathname, useRouter } from 'next/navigation'
import { type ReactNode, Suspense, useEffect, useState } from 'react'
import { useBranding, useBrandingInDocument } from '@/components/Brand'
import { ComposerHost } from '@/components/compose/Composer'
import { ComposeProvider, useCompose } from '@/components/compose/context'
import { Sidebar } from '@/components/Sidebar'
import { Loading } from '@/components/ui'
import { useMe } from '@/lib/api'
import { MotionProvider } from '@/lib/motion'
import { useServerEvents } from '@/lib/events'

function Shortcuts() {
	const { open } = useCompose()
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const target = e.target as HTMLElement
			if (
				target.closest('input, textarea, [contenteditable="true"], [role="dialog"]') ||
				e.metaKey ||
				e.ctrlKey ||
				e.altKey
			)
				return
			if (e.key === 'c') {
				e.preventDefault()
				open()
			}
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [open])
	return null
}

function Shell({ children }: { children: ReactNode }) {
	const { data: me, error } = useMe()
	const router = useRouter()
	const pathname = usePathname()
	const [navOpen, setNavOpen] = useState(false)
	useServerEvents({ notifications: me?.user.settings.notifications ?? false })
	useBrandingInDocument(useBranding())

	useEffect(() => {
		if (error) router.replace(`/login?next=${encodeURIComponent(pathname)}`)
	}, [error])
	// Signed in, but no passkey or authenticator yet: setting one up comes first
	const unverified = !!me && !me.security.verified
	useEffect(() => {
		if (unverified) router.replace(`/security/setup?next=${encodeURIComponent(pathname)}`)
	}, [unverified])

	if (!me || unverified) return <Loading />

	return (
		<div className="flex h-dvh overflow-hidden bg-background">
			<aside className="hidden w-64 shrink-0 border-r border-separator bg-surface/40 lg:block">
				<Suspense>
					<Sidebar />
				</Suspense>
			</aside>
			{navOpen && (
				<div className="fixed inset-0 z-50 lg:hidden">
					<button
						type="button"
						aria-label="Close menu"
						className="absolute inset-0 bg-black/40"
						onClick={() => setNavOpen(false)}
					/>
					<aside className="absolute inset-y-0 left-0 w-72 border-r border-separator bg-surface shadow-xl">
						<Suspense>
							<Sidebar onNavigate={() => setNavOpen(false)} />
						</Suspense>
					</aside>
				</div>
			)}
			<main className="relative flex min-w-0 flex-1 flex-col">
				<button
					type="button"
					aria-label="Open menu"
					onClick={() => setNavOpen(true)}
					className="absolute top-3 left-3 z-20 rounded-lg p-1.5 text-muted hover:bg-default lg:hidden"
				>
					<Menu className="size-5" />
				</button>
				{children}
			</main>
			<ComposerHost />
			<Shortcuts />
		</div>
	)
}

export default function AppLayout({ children }: { children: ReactNode }) {
	return (
		<MotionProvider>
			<ComposeProvider>
				<Shell>{children}</Shell>
			</ComposeProvider>
		</MotionProvider>
	)
}
