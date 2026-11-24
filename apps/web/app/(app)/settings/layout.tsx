'use client'

import { isAdminRole } from '@mailroom/shared'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { type ReactNode, useEffect } from 'react'
import { SETTINGS_GROUPS, type SettingsPage } from '@/components/settings/pages'
import { Loading, SectionTitle } from '@/components/ui'
import { useMe } from '@/lib/api'
import { ActiveIndicator, EnterOnChange } from '@/lib/motion'

// Settings: a sidebar of pages grouped by topic (a row of tabs on phones), the open page's title, then
// its sections.

function NavLink({ page, active }: { page: SettingsPage; active: boolean }) {
	const Icon = page.icon
	return (
		<Link
			href={page.href}
			aria-current={active ? 'page' : undefined}
			className={`relative isolate flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-sm transition-colors ${
				active ? 'font-medium text-foreground' : 'text-foreground/85 hover:bg-default'
			}`}
		>
			{active && <ActiveIndicator layoutId="settings-nav" className="rounded-lg bg-accent/12" />}
			<Icon className={`size-4 shrink-0 ${active ? 'text-accent' : 'text-muted'}`} />
			<span className="truncate">{page.label}</span>
		</Link>
	)
}

function TabLink({ page, active }: { page: SettingsPage; active: boolean }) {
	const Icon = page.icon
	return (
		<Link
			href={page.href}
			data-settings-tab
			aria-current={active ? 'page' : undefined}
			className={`relative isolate flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-sm transition-colors ${
				active ? 'font-medium text-foreground' : 'text-muted hover:text-foreground'
			}`}
		>
			{active && <ActiveIndicator layoutId="settings-tabs" className="rounded-full bg-accent/12" />}
			<Icon className={`size-3.5 shrink-0 ${active ? 'text-accent' : ''}`} />
			{page.label}
		</Link>
	)
}

export default function SettingsLayout({ children }: { children: ReactNode }) {
	const pathname = usePathname()
	const { data: me } = useMe()
	// On phones the tabs scroll sideways: keep the open one in view
	useEffect(() => {
		document
			.querySelector('[data-settings-tab][aria-current="page"]')
			?.scrollIntoView({ inline: 'center', block: 'nearest' })
	}, [pathname, !!me])
	if (!me) return <Loading />
	const admin = isAdminRole(me.user.role)
	const groups = SETTINGS_GROUPS.filter(g => !g.admin || admin)
	const pages = groups.flatMap(g => g.pages)
	const current = pages.find(p => p.href === pathname)

	return (
		<div className="flex h-full min-h-0">
			<aside className="hidden w-60 shrink-0 flex-col border-r border-separator md:flex">
				{/* Below lg the app's menu button sits in the top-left corner */}
				<div className="flex h-14 shrink-0 items-center pr-5 pl-14 text-[15px] font-semibold lg:pl-5">Settings</div>
				<nav className="pane-scroll flex-1 px-2 pb-4">
					{groups.map(g => (
						<div key={g.label}>
							<SectionTitle>{g.label}</SectionTitle>
							<div className="flex flex-col gap-0.5">
								{g.pages.map(p => (
									<NavLink key={p.href} page={p} active={p.href === pathname} />
								))}
							</div>
						</div>
					))}
				</nav>
			</aside>

			<div className="pane-scroll min-w-0 flex-1">
				<div className="sticky top-0 z-10 border-b border-separator bg-background/85 backdrop-blur md:hidden">
					<div className="flex h-14 items-center pl-14 text-[15px] font-semibold">Settings</div>
					<nav className="flex gap-1 overflow-x-auto px-3 pb-2 [scrollbar-width:none]">
						{pages.map(p => (
							<TabLink key={p.href} page={p} active={p.href === pathname} />
						))}
					</nav>
				</div>

				<div className="mx-auto flex max-w-2xl flex-col gap-6 p-4 pb-24 sm:px-8 sm:pt-8">
					{current && (
						<header className="flex flex-col gap-1">
							<h1 className="text-2xl font-semibold tracking-tight">{current.label}</h1>
							<p className="text-sm text-muted">{current.description}</p>
						</header>
					)}
					<EnterOnChange motionKey={pathname} className="flex flex-col gap-4">
						{children}
					</EnterOnChange>
				</div>
			</div>
		</div>
	)
}
