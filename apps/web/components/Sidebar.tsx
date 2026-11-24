'use client'

import type { Folder, Mailbox, Project, View } from '@mailroom/shared'
import { isAdminRole } from '@mailroom/shared'
import { Button, Dropdown, Label, Tooltip } from '@heroui/react'
import {
	Archive,
	ChevronRight,
	Clock,
	Eye,
	EyeOff,
	FileText,
	Folder as FolderIcon,
	Inbox,
	LogOut,
	Moon,
	MoreHorizontal,
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
import { ActiveIndicator } from '@/lib/motion'
import { ordered, useSidebarPrefs } from '@/lib/sidebar'
import { BrandMark, useBranding } from './Brand'
import { useCompose } from './compose/context'
import { draggingClass, SortableGrip, SortableGroup, type SortableItem, useSortableItem } from './Sortable'
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
	leading,
	muted,
	countHidesOnHover,
}: {
	href: string
	active: boolean
	icon?: ReactNode
	label: ReactNode
	count?: number
	indent?: number
	/** Before the icon: a project's or mailbox's expand chevron */
	leading?: ReactNode
	muted?: boolean
	/** The row's "..." menu shows over the count on hover */
	countHidesOnHover?: boolean
}) {
	return (
		<Link
			href={href}
			className={`relative isolate flex h-8 items-center gap-2 rounded-lg pr-2 text-sm transition-colors [&_svg]:size-4 [&_svg]:shrink-0 ${
				active ? 'font-medium text-foreground' : `${muted ? 'text-muted' : 'text-foreground/85'} hover:bg-default`
			}`}
			style={{ paddingLeft: (leading ? 4 : 10) + indent * 14 }}
		>
			{/* One background for the whole sidebar that slides to the row you open (layoutId, as in Seylo) */}
			{active && <ActiveIndicator layoutId="sidebar-active" className="rounded-lg bg-accent/12" />}
			{leading}
			{icon && <span className={active ? 'text-accent' : 'text-muted'}>{icon}</span>}
			<span className="min-w-0 flex-1 truncate">{label}</span>
			{!!count && (
				<span
					className={`text-xs tabular-nums ${active ? 'text-foreground' : 'text-muted'} ${
						countHidesOnHover
							? 'transition-opacity group-hover/row:opacity-0 group-has-[[aria-expanded=true]]/row:opacity-0'
							: ''
					}`}
				>
					{count > 999 ? '999+' : count}
				</span>
			)}
		</Link>
	)
}

/** Hide or show a project or mailbox in the sidebar. Sits over the row's count, shown on hover. */
function RowMenu({
	name,
	hidden,
	onHiddenChange,
}: {
	name: string
	hidden: boolean
	onHiddenChange: (hide: boolean) => void
}) {
	return (
		<div className="absolute top-1/2 right-1 z-10 -translate-y-1/2 opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100 has-[[aria-expanded=true]]:opacity-100 pointer-coarse:opacity-100">
			<Dropdown>
				<Button
					isIconOnly
					variant="ghost"
					size="sm"
					aria-label={`More for ${name}`}
					className="size-6 min-w-6 rounded-md"
				>
					<MoreHorizontal className="size-3.5" />
				</Button>
				<Dropdown.Popover placement="bottom end">
					<Dropdown.Menu onAction={() => onHiddenChange(!hidden)}>
						<Dropdown.Item id="hide" textValue={hidden ? 'Show in sidebar' : 'Hide from sidebar'}>
							{hidden ? <Eye className="size-4 text-muted" /> : <EyeOff className="size-4 text-muted" />}
							<Label>{hidden ? 'Show in sidebar' : 'Hide from sidebar'}</Label>
						</Dropdown.Item>
					</Dropdown.Menu>
				</Dropdown.Popover>
			</Dropdown>
		</div>
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

function Chevron({ open, onToggle, label }: { open: boolean; onToggle: () => void; label: string }) {
	return (
		<button
			type="button"
			aria-label={`${open ? 'Collapse' : 'Expand'} ${label}`}
			aria-expanded={open}
			onClick={e => {
				e.preventDefault()
				e.stopPropagation()
				onToggle()
			}}
			className="flex size-5 shrink-0 items-center justify-center rounded text-muted hover:text-foreground"
		>
			<ChevronRight className={`size-3.5! transition-transform ${open ? 'rotate-90' : ''}`} />
		</button>
	)
}

/** Keeps rows without children lined up with the ones that have a chevron */
const ChevronSpace = () => <span className="size-5 shrink-0" />

function MailboxNode({
	mailbox,
	folders,
	current,
	hidden,
	onHiddenChange,
	sortable,
}: {
	mailbox: Mailbox
	folders: Folder[]
	current: URLSearchParams
	hidden: boolean
	onHiddenChange: (hide: boolean) => void
	sortable?: SortableItem
}) {
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
		<>
			<div {...sortable?.handle} className="group/row relative">
				{sortable?.enabled && <SortableGrip grip={sortable.grip} name={mailbox.address} />}
				<NavRow
					href={`/mail?view=inbox&m=${mailbox.id}`}
					active={active}
					indent={1}
					muted={hidden}
					countHidesOnHover
					leading={
						mine.length > 0 ? <Chevron open={open} onToggle={toggle} label={mailbox.address} /> : <ChevronSpace />
					}
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
				/>
				<RowMenu name={mailbox.address} hidden={hidden} onHiddenChange={onHiddenChange} />
			</div>
			{open &&
				mine.map(f => (
					<NavRow
						key={f.id}
						href={`/mail?f=${f.id}`}
						active={current.get('f') === f.id}
						indent={2}
						leading={<ChevronSpace />}
						icon={<FolderIcon />}
						label={f.name}
						count={f.specialUse === 'inbox' || !f.specialUse ? f.unread : undefined}
						muted
					/>
				))}
		</>
	)
}

function ProjectNode({
	project,
	folders,
	current,
	hidden,
	sortable,
}: {
	project: Project
	folders: Folder[]
	current: URLSearchParams
	hidden: boolean
	sortable?: SortableItem
}) {
	const [open, toggle] = useExpanded(`p:${project.id}`, true)
	const [showHidden, setShowHidden] = useState(false)
	const sidebar = useSidebarPrefs()
	const unread = project.mailboxes.reduce((s, m) => s + m.unread, 0)
	const hasError = project.mailboxes.some(m => m.status === 'error')
	const mailboxes = ordered(project.mailboxes, sidebar.prefs.mailboxOrder?.[project.id])
	const shown = mailboxes.filter(m => !sidebar.hiddenMailboxes.has(m.id))
	const hiddenHere = mailboxes.filter(m => sidebar.hiddenMailboxes.has(m.id))
	const setMailboxHidden = (id: string, hide: boolean) => {
		// Showing the last hidden one folds the row, so the next hidden mailbox starts out of sight
		if (!hide && hiddenHere.length === 1) setShowHidden(false)
		sidebar.setMailboxHidden(id, hide)
	}
	return (
		<>
			<div {...sortable?.handle} className="group/row relative">
				{sortable?.enabled && <SortableGrip grip={sortable.grip} name={project.name} />}
				<NavRow
					href={`/mail?view=inbox&p=${project.id}`}
					active={current.get('p') === project.id && !current.get('m') && !current.get('f')}
					muted={hidden}
					countHidesOnHover
					leading={
						project.mailboxes.length > 0 ? (
							<Chevron open={open} onToggle={toggle} label={project.name} />
						) : (
							<ChevronSpace />
						)
					}
					icon={<span className="block size-2.5 rounded-[4px]" style={{ background: project.color }} />}
					label={
						<span className="inline-flex items-center gap-1.5">
							{project.name}
							{hasError && <span className="size-1.5 rounded-full bg-danger" title="A mailbox has a problem" />}
						</span>
					}
					count={unread}
				/>
				<RowMenu
					name={project.name}
					hidden={hidden}
					onHiddenChange={hide => sidebar.setProjectHidden(project.id, hide)}
				/>
			</div>
			{open && (
				<>
					<SortableGroup
						ids={shown.map(m => m.id)}
						onMove={ids =>
							sidebar.setMailboxOrder(
								project.id,
								ids,
								mailboxes.map(m => m.id),
							)
						}
						disabled={hidden}
					>
						{shown.map(m => (
							<SortableRow key={m.id} id={m.id}>
								{item => (
									<MailboxNode
										mailbox={m}
										folders={folders}
										current={current}
										hidden={false}
										onHiddenChange={hide => setMailboxHidden(m.id, hide)}
										sortable={item}
									/>
								)}
							</SortableRow>
						))}
					</SortableGroup>
					{hiddenHere.length > 0 && (
						<>
							<HiddenToggle
								open={showHidden}
								onToggle={() => setShowHidden(v => !v)}
								count={hiddenHere.length}
								what="mailbox"
								indent={1}
							/>
							{showHidden &&
								hiddenHere.map(m => (
									<MailboxNode
										key={m.id}
										mailbox={m}
										folders={folders}
										current={current}
										hidden
										onHiddenChange={hide => setMailboxHidden(m.id, hide)}
									/>
								))}
						</>
					)}
				</>
			)}
		</>
	)
}

/** "Hidden (N)": folds the hidden projects or mailboxes away at the end of their list. */
function HiddenToggle({
	open,
	onToggle,
	count,
	what,
	indent = 0,
}: {
	open: boolean
	onToggle: () => void
	count: number
	what: 'project' | 'mailbox'
	indent?: number
}) {
	return (
		<button
			type="button"
			aria-expanded={open}
			onClick={onToggle}
			className="flex h-7 w-full items-center gap-2 rounded-lg pr-2 text-left text-xs text-muted transition-colors hover:bg-default hover:text-foreground"
			style={{ paddingLeft: 4 + indent * 14 }}
		>
			<span className="flex size-5 items-center justify-center">
				<ChevronRight className={`size-3.5 transition-transform ${open ? 'rotate-90' : ''}`} />
			</span>
			Hidden {what === 'project' ? 'projects' : count === 1 ? 'mailbox' : 'mailboxes'} ({count})
		</button>
	)
}

/** A project or mailbox in the person's order: it drags by its row (a click still opens it). */
function SortableRow({ id, children }: { id: string; children: (item: SortableItem) => ReactNode }) {
	const item = useSortableItem(id)
	return (
		<div ref={item.ref} style={item.style} className={draggingClass(item.dragging)}>
			{children(item)}
		</div>
	)
}

/** Projects in the person's order, with the hidden ones folded at the end. */
function ProjectsList({
	projects,
	folders,
	current,
}: {
	projects: Project[]
	folders: Folder[]
	current: URLSearchParams
}) {
	const sidebar = useSidebarPrefs()
	const [showHidden, setShowHidden] = useState(false)
	const all = ordered(projects, sidebar.prefs.projectOrder)
	const shown = all.filter(p => !sidebar.hiddenProjects.has(p.id))
	const hidden = all.filter(p => sidebar.hiddenProjects.has(p.id))
	return (
		<>
			<SortableGroup
				ids={shown.map(p => p.id)}
				onMove={ids =>
					sidebar.setProjectOrder(
						ids,
						all.map(p => p.id),
					)
				}
			>
				{shown.map(p => (
					<SortableRow key={p.id} id={p.id}>
						{item => <ProjectNode project={p} folders={folders} current={current} hidden={false} sortable={item} />}
					</SortableRow>
				))}
			</SortableGroup>
			{hidden.length > 0 && (
				<>
					<HiddenToggle
						open={showHidden}
						onToggle={() => setShowHidden(v => !v)}
						count={hidden.length}
						what="project"
					/>
					{showHidden &&
						hidden.map(p => <ProjectNode key={p.id} project={p} folders={folders} current={current} hidden />)}
				</>
			)}
		</>
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
	const branding = useBranding()
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
				<BrandMark branding={branding} />
				<span className="min-w-0 flex-1 truncate font-semibold tracking-tight">{branding.name}</span>
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
				{boot && <ProjectsList projects={boot.projects} folders={boot.folders} current={params} />}
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
