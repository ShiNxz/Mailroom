'use client'

import type { Folder, Mailbox, Project, View } from '@mailroom/shared'
import { isAdminRole } from '@mailroom/shared'
import { Button, Dropdown, Label, Tooltip } from '@heroui/react'
import {
	Archive,
	ChevronRight,
	Clock,
	FileText,
	Folder as FolderIcon,
	Inbox,
	LogOut,
	Mail,
	Moon,
	PenSquare,
	Plus,
	Send,
	Settings,
	ShieldAlert,
	Star,
	Sun,
	Trash2,
	Users,
	Globe,
} from 'lucide-react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { type ReactNode, useEffect, useState } from 'react'
import { api, useBootstrap, useMe } from '@/lib/api'
import { useCompose } from './compose/context'
import { SectionTitle, StatusDot, STATUS_LABEL } from './ui'

const VIEWS: { view: View; label: string; icon: ReactNode }[] = [
	{ view: 'inbox', label: 'Inbox', icon: <Inbox /> },
	{ view: 'starred', label: 'Starred', icon: <Star /> },
	{ view: 'snoozed', label: 'Snoozed', icon: <Clock /> },
	{ view: 'scheduled', label: 'Scheduled', icon: <Send className="-rotate-12" /> },
	{ view: 'drafts', label: 'Drafts', icon: <FileText /> },
	{ view: 'sent', label: 'Sent', icon: <Send /> },
	{ view: 'archive', label: 'Archive', icon: <Archive /> },
	{ view: 'junk', label: 'Spam', icon: <ShieldAlert /> },
	{ view: 'trash', label: 'Trash', icon: <Trash2 /> },
]

const SPECIAL_ORDER = ['inbox', 'sent', 'drafts', 'archive', 'all', 'junk', 'trash']

function NavRow({
	href,
	active,
	icon,
	label,
	count,
	indent = 0,
	trailing,
	muted,
}: {
	href: string
	active: boolean
	icon?: ReactNode
	label: ReactNode
	count?: number
	indent?: number
	trailing?: ReactNode
	muted?: boolean
}) {
	return (
		<Link
			href={href}
			className={`group flex h-8 items-center gap-2.5 rounded-lg pr-2 text-sm transition-colors [&_svg]:size-4 [&_svg]:shrink-0 ${
				active
					? 'bg-accent/12 font-medium text-foreground'
					: `${muted ? 'text-muted' : 'text-foreground/85'} hover:bg-default`
			}`}
			style={{ paddingLeft: 10 + indent * 14 }}
		>
			{icon && <span className={active ? 'text-accent' : 'text-muted'}>{icon}</span>}
			<span className="min-w-0 flex-1 truncate">{label}</span>
			{trailing}
			{!!count && (
				<span className={`text-xs tabular-nums ${active ? 'text-foreground' : 'text-muted'}`}>
					{count > 999 ? '999+' : count}
				</span>
			)}
		</Link>
	)
}

function useExpanded(key: string, initial = false) {
	const [open, setOpen] = useState(initial)
	useEffect(() => {
		try {
			const saved = localStorage.getItem(`mr-open:${key}`)
			if (saved !== null) setOpen(saved === '1')
		} catch {}
	}, [key])
	const toggle = () =>
		setOpen(o => {
			try {
				localStorage.setItem(`mr-open:${key}`, o ? '0' : '1')
			} catch {}
			return !o
		})
	return [open, toggle] as const
}

function Chevron({ open, onToggle }: { open: boolean; onToggle: () => void }) {
	return (
		<button
			type="button"
			aria-label={open ? 'Collapse' : 'Expand'}
			onClick={e => {
				e.preventDefault()
				e.stopPropagation()
				onToggle()
			}}
			className="-ml-1 rounded p-0.5 text-muted hover:bg-surface hover:text-foreground"
		>
			<ChevronRight className={`size-3.5 transition-transform ${open ? 'rotate-90' : ''}`} />
		</button>
	)
}

function MailboxNode({ mailbox, folders, current }: { mailbox: Mailbox; folders: Folder[]; current: URLSearchParams }) {
	const [open, toggle] = useExpanded(`mb:${mailbox.id}`)
	const mine = folders
		.filter(f => f.mailboxId === mailbox.id && f.specialUse !== 'flagged')
		.sort((a, b) => {
			const ai = a.specialUse ? SPECIAL_ORDER.indexOf(a.specialUse) : 99
			const bi = b.specialUse ? SPECIAL_ORDER.indexOf(b.specialUse) : 99
			return ai - bi || a.path.localeCompare(b.path)
		})
	const active = current.get('m') === mailbox.id && !current.get('f')
	const [local, domain] = mailbox.address.split('@')
	return (
		<div>
			<NavRow
				href={`/mail?view=inbox&m=${mailbox.id}`}
				active={active}
				indent={1}
				icon={
					<Tooltip delay={300}>
						<Tooltip.Trigger>
							<span className="flex size-4 items-center justify-center">
								<StatusDot status={mailbox.status} />
							</span>
						</Tooltip.Trigger>
						<Tooltip.Content>
							{STATUS_LABEL[mailbox.status]}
							{mailbox.status === 'syncing' &&
								mailbox.totalCount > 0 &&
								` · ${Math.min(100, Math.round((mailbox.syncedCount / mailbox.totalCount) * 100))}%`}
							{mailbox.statusMessage && `: ${mailbox.statusMessage}`}
						</Tooltip.Content>
					</Tooltip>
				}
				label={
					<span title={mailbox.address}>
						{local}
						<span className="text-muted">@{domain}</span>
					</span>
				}
				count={mailbox.unread}
				trailing={mine.length > 0 && <Chevron open={open} onToggle={toggle} />}
			/>
			{open &&
				mine.map(f => (
					<NavRow
						key={f.id}
						href={`/mail?f=${f.id}`}
						active={current.get('f') === f.id}
						indent={2}
						icon={<FolderIcon />}
						label={f.name}
						count={f.specialUse === 'inbox' || !f.specialUse ? f.unread : undefined}
						muted
					/>
				))}
		</div>
	)
}

function ProjectNode({ project, folders, current }: { project: Project; folders: Folder[]; current: URLSearchParams }) {
	const [open, toggle] = useExpanded(`p:${project.id}`, true)
	const unread = project.mailboxes.reduce((s, m) => s + m.unread, 0)
	const hasError = project.mailboxes.some(m => m.status === 'error')
	return (
		<div>
			<NavRow
				href={`/mail?view=inbox&p=${project.id}`}
				active={current.get('p') === project.id && !current.get('m') && !current.get('f')}
				icon={<span className="block size-2.5 rounded-[4px]" style={{ background: project.color }} />}
				label={
					<span className="inline-flex items-center gap-1.5">
						{project.name}
						{hasError && <span className="size-1.5 rounded-full bg-danger" title="A mailbox has a problem" />}
					</span>
				}
				count={unread}
				trailing={project.mailboxes.length > 0 && <Chevron open={open} onToggle={toggle} />}
			/>
			{open && project.mailboxes.map(m => <MailboxNode key={m.id} mailbox={m} folders={folders} current={current} />)}
		</div>
	)
}

export function toggleTheme() {
	const root = document.documentElement
	const next = root.classList.contains('dark') ? 'light' : 'dark'
	root.classList.toggle('dark', next === 'dark')
	root.dataset.theme = next
	try {
		localStorage.setItem('mr-theme', next)
	} catch {}
}

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
	const { data: boot } = useBootstrap()
	const { data: me } = useMe()
	const { open } = useCompose()
	const params = useSearchParams()
	const pathname = usePathname()
	const router = useRouter()
	const onMail = pathname.startsWith('/mail')
	const view = params.get('view') ?? (params.get('f') ? null : 'inbox')
	const scoped = params.get('p') || params.get('m') || params.get('f')
	const inboxUnread = boot?.projects.reduce((s, p) => s + p.mailboxes.reduce((t, m) => t + m.unread, 0), 0) ?? 0
	const admin = me && isAdminRole(me.user.role)

	const counts: Partial<Record<View, number>> = {
		inbox: inboxUnread,
		drafts: boot?.counts.drafts,
		scheduled: boot?.counts.scheduled,
	}

	return (
		<nav
			className="flex h-full w-full flex-col"
			onClickCapture={e => (e.target as HTMLElement).closest('a') && onNavigate?.()}
		>
			<div className="flex h-14 shrink-0 items-center gap-2 px-4">
				<div className="flex size-7 items-center justify-center rounded-lg bg-accent text-accent-foreground">
					<Mail className="size-4" />
				</div>
				<span className="flex-1 font-semibold tracking-tight">Mailroom</span>
				<button
					type="button"
					aria-label="Toggle theme"
					onClick={toggleTheme}
					className="rounded-md p-1.5 text-muted hover:bg-default hover:text-foreground"
				>
					<Sun className="hidden size-4 dark:block" />
					<Moon className="size-4 dark:hidden" />
				</button>
			</div>
			<div className="px-3 pb-2">
				<Button fullWidth onPress={() => open({ mailboxId: params.get('m') ?? undefined })}>
					<PenSquare className="size-4" /> Compose
				</Button>
			</div>

			<div className="pane-scroll min-h-0 flex-1 px-2 pb-4">
				{VIEWS.map(v => (
					<NavRow
						key={v.view}
						href={`/mail?view=${v.view}`}
						active={onMail && !scoped && view === v.view}
						icon={v.icon}
						label={v.label}
						count={counts[v.view]}
					/>
				))}

				<SectionTitle
					action={
						admin && (
							<Link
								href="/admin/projects?new=1"
								aria-label="New project"
								className="rounded p-0.5 text-muted hover:bg-default hover:text-foreground"
							>
								<Plus className="size-3.5" />
							</Link>
						)
					}
				>
					Projects
				</SectionTitle>
				{boot?.projects.map(p => (
					<ProjectNode key={p.id} project={p} folders={boot.folders} current={params} />
				))}
				{boot && !boot.projects.length && (
					<p className="px-3 py-2 text-xs text-muted">
						{admin ? (
							<>
								No projects yet.{' '}
								<Link className="text-accent" href="/admin/projects?new=1">
									Create one
								</Link>{' '}
								and connect a mailbox.
							</>
						) : (
							'Nobody gave you access to a project yet.'
						)}
					</p>
				)}

				{admin && (
					<>
						<SectionTitle>Admin</SectionTitle>
						<NavRow
							href="/admin/projects"
							active={pathname.startsWith('/admin/projects')}
							icon={<Globe />}
							label="Projects & domains"
						/>
						<NavRow href="/admin/users" active={pathname.startsWith('/admin/users')} icon={<Users />} label="People" />
					</>
				)}
			</div>

			<div className="flex shrink-0 items-center gap-1 border-t border-separator p-2">
				<Dropdown>
					<Button variant="ghost" className="min-w-0 flex-1 justify-start">
						<span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent text-[11px] font-semibold text-accent-foreground">
							{me?.user.name.slice(0, 1).toUpperCase()}
						</span>
						<span className="truncate text-sm">{me?.user.name}</span>
					</Button>
					<Dropdown.Popover placement="top start">
						<Dropdown.Menu
							onAction={async key => {
								if (key === 'settings') router.push('/settings')
								if (key === 'logout') {
									await api('/auth/logout', { method: 'POST' }).catch(() => {})
									window.location.href = '/login'
								}
							}}
						>
							<Dropdown.Item id="settings" textValue="Settings">
								<Settings className="size-4 text-muted" />
								<Label>Settings</Label>
							</Dropdown.Item>
							<Dropdown.Item id="logout" textValue="Sign out" variant="danger">
								<LogOut className="size-4" />
								<Label>Sign out</Label>
							</Dropdown.Item>
						</Dropdown.Menu>
					</Dropdown.Popover>
				</Dropdown>
				<Link
					href="/settings"
					aria-label="Settings"
					className="rounded-lg p-2 text-muted hover:bg-default hover:text-foreground"
				>
					<Settings className="size-4" />
				</Link>
			</div>
		</nav>
	)
}
