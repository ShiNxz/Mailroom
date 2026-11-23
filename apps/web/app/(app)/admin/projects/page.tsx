'use client'

import type { Domain, Project, UserWithAccess } from '@mailroom/shared'
import { Button, Card, Chip, Description, Input, Label, Modal, TextField } from '@heroui/react'
import { formatDistanceToNow } from 'date-fns'
import { Globe, MailPlus, Pause, Pencil, Play, Plus, RefreshCw, Trash2, Users } from 'lucide-react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Suspense, useEffect, useState } from 'react'
import { toast } from 'sonner'
import useSWR from 'swr'
import { DomainHealthCard } from '@/components/admin/DomainHealthCard'
import { MailboxDialog } from '@/components/admin/MailboxDialog'
import { EmptyState, IconButton, Loading, PROJECT_COLORS, StatusDot, STATUS_LABEL } from '@/components/ui'
import { api, fetcher, refreshBootstrap, useBootstrap } from '@/lib/api'

function ProjectForm({
	isOpen,
	onOpenChange,
	project,
	onSaved,
}: {
	isOpen: boolean
	onOpenChange: (v: boolean) => void
	project?: Project
	onSaved: (id: string) => void
}) {
	const [name, setName] = useState('')
	const [domain, setDomain] = useState('')
	const [color, setColor] = useState(PROJECT_COLORS[0]!)
	const [busy, setBusy] = useState(false)

	useEffect(() => {
		if (!isOpen) return
		setName(project?.name ?? '')
		setColor(project?.color ?? PROJECT_COLORS[Math.floor(Math.random() * PROJECT_COLORS.length)]!)
		setDomain('')
	}, [isOpen, project])

	const save = async () => {
		if (!name.trim()) return toast.error('Give the project a name')
		setBusy(true)
		try {
			if (project) {
				await api(`/admin/projects/${project.id}`, { method: 'PATCH', body: { name, color } })
				onSaved(project.id)
			} else {
				const r = await api<{ project: { id: string } }>('/admin/projects', {
					body: { name, color, domain: domain.trim() || undefined },
				})
				onSaved(r.project.id)
			}
			void refreshBootstrap()
			onOpenChange(false)
		} catch (err) {
			toast.error((err as Error).message)
		} finally {
			setBusy(false)
		}
	}

	return (
		<Modal.Backdrop isOpen={isOpen} onOpenChange={onOpenChange}>
			<Modal.Container size="md">
				<Modal.Dialog>
					<Modal.CloseTrigger />
					<Modal.Header>
						<Modal.Heading>{project ? 'Edit project' : 'New project'}</Modal.Heading>
					</Modal.Header>
					<Modal.Body className="flex flex-col gap-4">
						<TextField value={name} onChange={setName} autoFocus>
							<Label>Name</Label>
							<Input placeholder="Acme" />
						</TextField>
						{!project && (
							<TextField value={domain} onChange={setDomain}>
								<Label>Domain</Label>
								<Input placeholder="acme.com" />
								<Description>We check its mail setup right away. You can add more domains later.</Description>
							</TextField>
						)}
						<div className="flex flex-col gap-2">
							<span className="text-sm font-medium">Color</span>
							<div className="flex gap-2">
								{PROJECT_COLORS.map(c => (
									<button
										key={c}
										type="button"
										aria-label={c}
										onClick={() => setColor(c)}
										className={`size-7 rounded-full transition-transform ${color === c ? 'scale-110 ring-2 ring-foreground ring-offset-2 ring-offset-surface' : ''}`}
										style={{ background: c }}
									/>
								))}
							</div>
						</div>
					</Modal.Body>
					<Modal.Footer>
						<Button slot="close" variant="secondary">
							Cancel
						</Button>
						<Button onPress={() => void save()} isPending={busy}>
							{project ? 'Save' : 'Create project'}
						</Button>
					</Modal.Footer>
				</Modal.Dialog>
			</Modal.Container>
		</Modal.Backdrop>
	)
}

function ProjectDetail({ project, onEdit }: { project: Project; onEdit: () => void }) {
	const { mutate: mutateBoot } = useBootstrap()
	const { data: people } = useSWR<{ users: UserWithAccess[] }>('/admin/users', fetcher)
	const [newDomain, setNewDomain] = useState('')
	const [adding, setAdding] = useState(false)
	const [mailboxDialog, setMailboxDialog] = useState<{ open: boolean; id?: string }>({ open: false })
	const router = useRouter()

	const reload = () => void mutateBoot()

	const addDomain = async () => {
		if (!newDomain.trim()) return
		setAdding(true)
		try {
			await api(`/admin/projects/${project.id}/domains`, { body: { name: newDomain } })
			setNewDomain('')
			reload()
		} catch (err) {
			toast.error((err as Error).message)
		} finally {
			setAdding(false)
		}
	}

	const removeProject = async () => {
		if (
			!window.confirm(
				`Delete ${project.name}? Its mailboxes are disconnected and their synced mail is removed from Mailroom (nothing is deleted on the mail servers).`,
			)
		)
			return
		await api(`/admin/projects/${project.id}`, { method: 'DELETE' })
		reload()
		router.replace('/admin/projects')
	}

	const mailboxAction = async (id: string, action: 'resync' | 'pause' | 'resume' | 'delete', address: string) => {
		try {
			if (action === 'resync') await api(`/admin/mailboxes/${id}/resync`, { method: 'POST' })
			if (action === 'pause' || action === 'resume')
				await api(`/admin/mailboxes/${id}`, { method: 'PATCH', body: { enabled: action === 'resume' } })
			if (action === 'delete') {
				if (
					!window.confirm(
						`Disconnect ${address}? Its synced mail is removed from Mailroom. Nothing is deleted on the mail server.`,
					)
				)
					return
				await api(`/admin/mailboxes/${id}`, { method: 'DELETE' })
			}
			reload()
		} catch (err) {
			toast.error((err as Error).message)
		}
	}

	const withAccess = (people?.users ?? []).filter(
		u => u.role !== 'member' || u.grants.some(g => g.projectId === project.id),
	)

	return (
		<div className="mx-auto flex max-w-4xl flex-col gap-6 p-4 sm:p-8">
			<div className="flex items-center gap-3 pl-10 lg:pl-0">
				<span className="size-4 rounded-md" style={{ background: project.color }} />
				<h1 className="flex-1 truncate text-2xl font-semibold">{project.name}</h1>
				<IconButton label="Edit project" onPress={onEdit}>
					<Pencil className="size-4" />
				</IconButton>
				<IconButton label="Delete project" onPress={() => void removeProject()}>
					<Trash2 className="size-4" />
				</IconButton>
			</div>

			<section className="flex flex-col gap-3">
				<div className="flex items-center gap-2">
					<Globe className="size-4 text-muted" />
					<h2 className="flex-1 font-semibold">Domains</h2>
				</div>
				{project.domains.map((d: Domain) => (
					<DomainHealthCard key={d.id} domain={d} onChange={reload} />
				))}
				<form
					className="flex items-end gap-2"
					onSubmit={e => {
						e.preventDefault()
						void addDomain()
					}}
				>
					<TextField value={newDomain} onChange={setNewDomain} className="flex-1">
						<Label>{project.domains.length ? 'Add another domain' : 'Add a domain'}</Label>
						<Input placeholder="example.com" />
					</TextField>
					<Button type="submit" variant="secondary" isPending={adding}>
						<Plus className="size-4" /> Add and check
					</Button>
				</form>
			</section>

			<section className="flex flex-col gap-3">
				<div className="flex items-center gap-2">
					<MailPlus className="size-4 text-muted" />
					<h2 className="flex-1 font-semibold">Mailboxes</h2>
					<Button size="sm" onPress={() => setMailboxDialog({ open: true })}>
						<Plus className="size-4" /> Connect mailbox
					</Button>
				</div>
				{project.mailboxes.length === 0 ? (
					<Card>
						<Card.Content>
							<EmptyState icon={<MailPlus />} title="No mailboxes yet">
								Connect an address on this project's domain. Mailroom syncs its whole history and gets new mail
								instantly.
							</EmptyState>
						</Card.Content>
					</Card>
				) : (
					<Card className="p-0">
						<ul>
							{project.mailboxes.map(m => {
								const pct = m.totalCount ? Math.min(100, Math.round((m.syncedCount / m.totalCount) * 100)) : 100
								return (
									<li
										key={m.id}
										className="flex flex-wrap items-center gap-3 border-b border-separator px-4 py-3 last:border-0"
									>
										<StatusDot status={m.status} />
										<div className="min-w-0 flex-1">
											<div className="truncate text-sm font-medium">{m.address}</div>
											<div className="truncate text-xs text-muted">
												{m.displayName && `${m.displayName} · `}
												{STATUS_LABEL[m.status]}
												{m.status === 'syncing' &&
													m.totalCount > 0 &&
													` · ${pct}% of ${m.totalCount.toLocaleString()} messages`}
												{m.status === 'idle' &&
													m.lastSyncAt &&
													` · ${m.syncedCount.toLocaleString()} messages · synced ${formatDistanceToNow(new Date(m.lastSyncAt))} ago`}
											</div>
											{m.status === 'error' && m.statusMessage && (
												<div className="mt-1 text-xs text-danger">{m.statusMessage}</div>
											)}
										</div>
										<div className="flex gap-0.5">
											<IconButton
												label="Settings and signature"
												onPress={() => setMailboxDialog({ open: true, id: m.id })}
											>
												<Pencil className="size-4" />
											</IconButton>
											<IconButton label="Sync now" onPress={() => void mailboxAction(m.id, 'resync', m.address)}>
												<RefreshCw className="size-4" />
											</IconButton>
											<IconButton
												label={m.enabled ? 'Pause sync' : 'Resume sync'}
												onPress={() => void mailboxAction(m.id, m.enabled ? 'pause' : 'resume', m.address)}
											>
												{m.enabled ? <Pause className="size-4" /> : <Play className="size-4" />}
											</IconButton>
											<IconButton label="Disconnect" onPress={() => void mailboxAction(m.id, 'delete', m.address)}>
												<Trash2 className="size-4" />
											</IconButton>
										</div>
									</li>
								)
							})}
						</ul>
					</Card>
				)}
			</section>

			<section className="flex flex-col gap-3 pb-16">
				<div className="flex items-center gap-2">
					<Users className="size-4 text-muted" />
					<h2 className="flex-1 font-semibold">Who has access</h2>
					<Link href="/admin/users" className="text-sm text-accent">
						Manage people
					</Link>
				</div>
				<div className="flex flex-wrap gap-2">
					{withAccess.map(u => {
						const g = u.grants.find(x => x.projectId === project.id)
						const what =
							u.role !== 'member'
								? u.role
								: g?.access === 'all'
									? 'all mailboxes'
									: `${g?.mailboxIds.length ?? 0} mailbox${g?.mailboxIds.length === 1 ? '' : 'es'}`
						return (
							<Chip key={u.id} variant="secondary">
								{u.name} <span className="text-muted">· {what}</span>
							</Chip>
						)
					})}
				</div>
			</section>

			<MailboxDialog
				isOpen={mailboxDialog.open}
				onOpenChange={open => setMailboxDialog(s => ({ ...s, open }))}
				projectId={project.id}
				mailboxId={mailboxDialog.id}
				onSaved={reload}
			/>
		</div>
	)
}

function ProjectsAdmin() {
	const { data: boot, isLoading } = useBootstrap()
	const params = useSearchParams()
	const router = useRouter()
	const pathname = usePathname()
	const [formOpen, setFormOpen] = useState(params.get('new') === '1')
	const [editing, setEditing] = useState<Project | undefined>()
	const selectedId = params.get('id') ?? boot?.projects[0]?.id
	const project = boot?.projects.find(p => p.id === selectedId)

	useEffect(() => {
		if (params.get('new') === '1') {
			setEditing(undefined)
			setFormOpen(true)
		}
	}, [params])

	if (isLoading) return <Loading />

	return (
		<div className="flex h-full min-h-0">
			<aside className="hidden w-64 shrink-0 flex-col border-r border-separator md:flex">
				<div className="flex h-14 items-center gap-2 border-b border-separator px-4">
					<span className="flex-1 font-semibold">Projects</span>
					<IconButton
						label="New project"
						onPress={() => {
							setEditing(undefined)
							setFormOpen(true)
						}}
					>
						<Plus className="size-4" />
					</IconButton>
				</div>
				<div className="pane-scroll flex-1 p-2">
					{boot?.projects.map(p => {
						const score = p.domains[0]?.health?.score
						return (
							<Link
								key={p.id}
								href={`/admin/projects?id=${p.id}`}
								className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm ${p.id === selectedId ? 'bg-accent/12 font-medium' : 'hover:bg-default'}`}
							>
								<span className="size-2.5 rounded-[4px]" style={{ background: p.color }} />
								<span className="min-w-0 flex-1 truncate">{p.name}</span>
								{score !== undefined && (
									<span
										className={`text-xs tabular-nums ${score >= 85 ? 'text-success' : score >= 60 ? 'text-warning' : 'text-danger'}`}
									>
										{score}
									</span>
								)}
							</Link>
						)
					})}
				</div>
			</aside>
			<div className="pane-scroll min-w-0 flex-1">
				{project ? (
					<ProjectDetail
						key={project.id}
						project={project}
						onEdit={() => {
							setEditing(project)
							setFormOpen(true)
						}}
					/>
				) : (
					<EmptyState icon={<Globe />} title="Create your first project">
						<p className="mb-3">
							A project is a brand or client: its domain, its mailboxes and the people who work on it.
						</p>
						<Button onPress={() => setFormOpen(true)}>
							<Plus className="size-4" /> New project
						</Button>
					</EmptyState>
				)}
			</div>
			<ProjectForm
				isOpen={formOpen}
				onOpenChange={open => {
					setFormOpen(open)
					if (!open && params.get('new')) router.replace(pathname + (selectedId ? `?id=${selectedId}` : ''))
				}}
				project={editing}
				onSaved={id => router.replace(`/admin/projects?id=${id}`)}
			/>
		</div>
	)
}

export default function Page() {
	return (
		<Suspense fallback={<Loading />}>
			<ProjectsAdmin />
		</Suspense>
	)
}
