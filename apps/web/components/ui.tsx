'use client'

import type { Address, MailboxStatus } from '@mailroom/shared'
import { Button, Spinner, Tooltip } from '@heroui/react'
import type { ReactNode } from 'react'
import { colorFor, initials } from '@/lib/format'

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

export function PersonAvatar({ who, size = 36 }: { who: Address; size?: number }) {
	return (
		<div
			className="flex shrink-0 select-none items-center justify-center rounded-full font-medium text-white"
			style={{ width: size, height: size, background: colorFor(who.address || who.name), fontSize: size * 0.38 }}
			aria-hidden
		>
			{initials(who)}
		</div>
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
