'use client'

import type { Address, MailboxStatus } from '@mailroom/shared'
import { Button, Spinner, Tooltip } from '@heroui/react'
import type { ReactNode } from 'react'

/** Icon-only button with a tooltip. */
export function IconButton({
	label,
	onPress,
	children,
	isDisabled,
	variant = 'ghost',
	size = 'sm',
	className,
}: {
	label: string
	onPress?: () => void
	children: ReactNode
	isDisabled?: boolean
	variant?: 'ghost' | 'secondary' | 'tertiary' | 'outline' | 'danger-soft' | 'primary'
	size?: 'sm' | 'md'
	className?: string
}) {
	return (
		<Tooltip delay={500}>
			<Tooltip.Trigger>
				<Button
					isIconOnly
					aria-label={label}
					variant={variant}
					size={size}
					onPress={onPress}
					isDisabled={isDisabled}
					className={className}
				>
					{children}
				</Button>
			</Tooltip.Trigger>
			<Tooltip.Content>{label}</Tooltip.Content>
		</Tooltip>
	)
}

// Soft gradient orbs, one per sender: a deep color low in the circle fading to a pale rim, with a light
// highlight up top. [deep, mid, pale]
const ORBS: [string, string, string][] = [
	['#1f8a5b', '#4fc796', '#c9f1de'], // green
	['#2251e8', '#5b86f5', '#cdd9fb'], // blue
	['#ee5a1c', '#f79a4f', '#fadfc6'], // orange
	['#1b6ff0', '#2ec5e8', '#c9f3fb'], // cyan
	['#b0247a', '#c75ee0', '#f0caf4'], // magenta
	['#6a35f0', '#a06af5', '#ddd0fb'], // violet
	['#e0322b', '#f2706a', '#f9d2cf'], // red
	['#0f9b84', '#4fd3b5', '#cbf4ea'], // teal
	['#d4a106', '#f2c94c', '#fbefc4'], // amber
]
const GRAPHITE: [string, string, string] = ['#0d0e10', '#3a3c41', '#8b8e94']
// Brands people know by their color
const BRANDS: [RegExp, [string, string, string]][] = [
	[/github\./, GRAPHITE],
	[/(^|\.)(x|twitter|apple|vercel|notion)\./, GRAPHITE],
]

function orbFor(who: Address) {
	const key = (who.address || who.name).toLowerCase()
	const domain = key.split('@')[1] ?? ''
	const brand = BRANDS.find(([re]) => re.test(domain))
	if (brand) return brand[1]
	let h = 0
	for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) | 0
	return ORBS[Math.abs(h) % ORBS.length]!
}

export const orbBackground = (who: Address) => {
	const [deep, mid, pale] = orbFor(who)
	return `radial-gradient(60% 45% at 38% 24%, rgba(255,255,255,.55), rgba(255,255,255,0) 70%), radial-gradient(95% 95% at 55% 80%, ${deep} 0%, ${mid} 42%, ${pale} 88%)`
}

export function PersonAvatar({ who, size = 40 }: { who: Address; size?: number }) {
	return (
		<div
			className="shrink-0 select-none rounded-full shadow-[inset_0_0_0_1px_rgba(0,0,0,0.05)]"
			style={{ width: size, height: size, background: orbBackground(who) }}
			title={who.name || who.address}
			aria-hidden
		/>
	)
}

const STATUS_COLOR: Record<MailboxStatus, string> = {
	idle: 'bg-success',
	syncing: 'bg-accent animate-pulse',
	connecting: 'bg-warning animate-pulse',
	error: 'bg-danger',
	paused: 'bg-muted',
}

export const STATUS_LABEL: Record<MailboxStatus, string> = {
	idle: 'Up to date',
	syncing: 'Syncing',
	connecting: 'Connecting',
	error: 'Error',
	paused: 'Paused',
}

export function StatusDot({ status, className = '' }: { status: MailboxStatus; className?: string }) {
	return <span className={`inline-block size-2 shrink-0 rounded-full ${STATUS_COLOR[status]} ${className}`} />
}

export function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
	return (
		<div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
			<div className="mb-1 text-muted [&>svg]:size-10 [&>svg]:stroke-[1.4]">{icon}</div>
			<p className="font-medium text-foreground">{title}</p>
			{children && <div className="max-w-xs text-sm text-muted">{children}</div>}
		</div>
	)
}

export function Loading({ label }: { label?: string }) {
	return (
		<div className="flex h-full items-center justify-center gap-2 p-8 text-sm text-muted">
			<Spinner size="sm" color="current" />
			{label}
		</div>
	)
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
	return (
		<div className="flex items-center justify-between px-3 pt-4 pb-1">
			<span className="text-[11px] font-semibold uppercase tracking-wider text-muted">{children}</span>
			{action}
		</div>
	)
}

export const PROJECT_COLORS = ['#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4', '#a855f7', '#ec4899', '#64748b']
