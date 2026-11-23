'use client'

import type { ProjectAccess, ProjectGrant, Role, UserWithAccess } from '@mailroom/shared'
import { ROLE_LABELS } from '@mailroom/shared'
import {
	Button,
	Card,
	Checkbox,
	Chip,
	Description,
	Input,
	Label,
	ListBox,
	Modal,
	Select,
	Switch,
	TextField,
} from '@heroui/react'
import { Pencil, Plus, Trash2, Users } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import useSWR from 'swr'
import { EmptyState, IconButton, Loading, PersonAvatar } from '@/components/ui'
import { api, fetcher, useBootstrap, useMe } from '@/lib/api'

type Level = 'none' | ProjectAccess

function AccessEditor({ grants, onChange }: { grants: ProjectGrant[]; onChange: (g: ProjectGrant[]) => void }) {
	const { data: boot } = useBootstrap()
	const levelOf = (projectId: string): Level => grants.find(g => g.projectId === projectId)?.access ?? 'none'
	const setLevel = (projectId: string, level: Level) => {
		const rest = grants.filter(g => g.projectId !== projectId)
		if (level === 'none') return onChange(rest)
		const current = grants.find(g => g.projectId === projectId)
		onChange([...rest, { projectId, access: level, mailboxIds: current?.mailboxIds ?? [] }])
	}
	const toggleMailbox = (projectId: string, mailboxId: string, on: boolean) => {
		onChange(
			grants.map(g =>
				g.projectId === projectId
					? {
							...g,
							mailboxIds: on ? [...new Set([...g.mailboxIds, mailboxId])] : g.mailboxIds.filter(id => id !== mailboxId),
						}
					: g,
			),
		)
	}
	if (!boot?.projects.length) return <p className="text-sm text-muted">Create a project first.</p>
	return (
		<div className="flex flex-col divide-y divide-separator rounded-xl border border-border">
			{boot.projects.map(p => {
				const level = levelOf(p.id)
				const g = grants.find(x => x.projectId === p.id)
				return (
					<div key={p.id} className="flex flex-col gap-2 p-3">
						<div className="flex items-center gap-2">
							<span className="size-2.5 rounded-[4px]" style={{ background: p.color }} />
							<span className="flex-1 text-sm font-medium">{p.name}</span>
							<div className="flex rounded-lg bg-default p-0.5 text-xs">
								{(['none', 'all', 'selected'] as Level[]).map(l => (
									<button
										key={l}
										type="button"
										onClick={() => setLevel(p.id, l)}
										className={`rounded-md px-2.5 py-1 ${level === l ? 'bg-surface font-medium text-foreground shadow-sm' : 'text-muted hover:text-foreground'}`}
									>
										{l === 'none' ? 'No access' : l === 'all' ? 'All mailboxes' : 'Some'}
									</button>
								))}
							</div>
						</div>
						{level === 'selected' && (
							<div className="flex flex-col gap-1.5 pl-5">
								{p.mailboxes.length === 0 && (
									<span className="text-xs text-muted">No mailboxes in this project yet.</span>
								)}
								{p.mailboxes.map(m => (
									<Checkbox
										key={m.id}
										isSelected={g?.mailboxIds.includes(m.id) ?? false}
										onChange={on => toggleMailbox(p.id, m.id, on)}
									>
										<Checkbox.Content>
											<Checkbox.Control>
												<Checkbox.Indicator />
											</Checkbox.Control>
											<span className="text-sm">{m.address}</span>
										</Checkbox.Content>
									</Checkbox>
								))}
							</div>
						)}
						{level === 'all' && (
							<span className="pl-5 text-xs text-muted">Includes mailboxes added to {p.name} later.</span>
						)}
					</div>
				)
			})}
		</div>
	)
}

function UserDialog({
	isOpen,
	onOpenChange,
	user,
	onSaved,
	actorRole,
}: {
	isOpen: boolean
	onOpenChange: (v: boolean) => void
	user?: UserWithAccess
	onSaved: () => void
	actorRole: Role
}) {
	const [name, setName] = useState('')
	const [email, setEmail] = useState('')
	const [password, setPassword] = useState('')
	const [role, setRole] = useState<Role>('member')
	const [disabled, setDisabled] = useState(false)
	const [grants, setGrants] = useState<ProjectGrant[]>([])
	const [busy, setBusy] = useState(false)

	useEffect(() => {
		if (!isOpen) return
		setName(user?.name ?? '')
		setEmail(user?.email ?? '')
		setPassword('')
		setRole(user?.role ?? 'member')
		setDisabled(user?.disabled ?? false)
		setGrants(user?.grants ?? [])
	}, [isOpen, user])

	const save = async () => {
		setBusy(true)
		try {
			if (user) {
				await api(`/admin/users/${user.id}`, {
					method: 'PATCH',
					body: {
						name,
						...(user.role !== 'owner' ? { role, disabled } : {}),
						...(password ? { password } : {}),
						grants,
					},
				})
			} else {
				await api('/admin/users', { body: { name, email, password, role, grants } })
			}
			toast.success(user ? 'Saved' : `${name} can sign in now`)
			onSaved()
			onOpenChange(false)
		} catch (err) {
			toast.error((err as Error).message)
		} finally {
			setBusy(false)
		}
	}

	const isOwner = user?.role === 'owner'

	return (
		<Modal.Backdrop isOpen={isOpen} onOpenChange={onOpenChange}>
			<Modal.Container size="lg" scroll="inside">
				<Modal.Dialog>
					<Modal.CloseTrigger />
					<Modal.Header>
						<Modal.Heading>{user ? user.name : 'Add a person'}</Modal.Heading>
					</Modal.Header>
					<Modal.Body className="flex flex-col gap-4">
						<div className="grid gap-3 sm:grid-cols-2">
							<TextField value={name} onChange={setName} autoFocus={!user}>
								<Label>Name</Label>
								<Input />
							</TextField>
							<TextField value={email} onChange={setEmail} type="email" isReadOnly={!!user}>
								<Label>Email (to sign in)</Label>
								<Input />
							</TextField>
							<TextField value={password} onChange={setPassword} type="password">
								<Label>{user ? 'New password' : 'Password'}</Label>
								<Input
									autoComplete="new-password"
									placeholder={user ? 'Leave empty to keep' : 'At least 10 characters'}
								/>
								{!user && <Description>Share it with them; they can change it in Settings.</Description>}
							</TextField>
							{!isOwner && (
								<Select
									value={role}
									onChange={v => setRole(v as Role)}
									isDisabled={actorRole !== 'owner' && role === 'admin'}
								>
									<Label>Role</Label>
									<Select.Trigger>
										<Select.Value />
										<Select.Indicator />
									</Select.Trigger>
									<Select.Popover>
										<ListBox>
											<ListBox.Item id="member" textValue="Member">
												<Label>Member</Label>
												<Description>Only the projects and mailboxes below</Description>
												<ListBox.ItemIndicator />
											</ListBox.Item>
											{actorRole === 'owner' && (
												<ListBox.Item id="admin" textValue="Admin">
													<Label>Admin</Label>
													<Description>Everything, and manages projects and people</Description>
													<ListBox.ItemIndicator />
												</ListBox.Item>
											)}
										</ListBox>
									</Select.Popover>
								</Select>
							)}
						</div>
						{role === 'member' && !isOwner ? (
							<div className="flex flex-col gap-2">
								<span className="text-sm font-medium">Access</span>
								<AccessEditor grants={grants} onChange={setGrants} />
							</div>
						) : (
							<p className="text-sm text-muted">
								{isOwner ? 'The owner' : 'Admins'} can see every project and mailbox.
							</p>
						)}
						{user && !isOwner && (
							<Switch isSelected={disabled} onChange={setDisabled}>
								<Switch.Control>
									<Switch.Thumb />
								</Switch.Control>
								<Switch.Content>
									<Label>Disable this account</Label>
									<Description>Signs them out everywhere and blocks sign-in.</Description>
								</Switch.Content>
							</Switch>
						)}
					</Modal.Body>
					<Modal.Footer>
						<Button slot="close" variant="secondary">
							Cancel
						</Button>
						<Button onPress={() => void save()} isPending={busy}>
							{user ? 'Save' : 'Add person'}
						</Button>
					</Modal.Footer>
				</Modal.Dialog>
			</Modal.Container>
		</Modal.Backdrop>
	)
}

export default function UsersPage() {
	const { data, isLoading, mutate } = useSWR<{ users: UserWithAccess[] }>('/admin/users', fetcher)
	const { data: boot } = useBootstrap()
	const { data: me } = useMe()
	const [dialog, setDialog] = useState<{ open: boolean; user?: UserWithAccess }>({ open: false })

	const projectName = (id: string) => boot?.projects.find(p => p.id === id)
	const remove = async (u: UserWithAccess) => {
		if (!window.confirm(`Remove ${u.name}? Their drafts and scheduled mail are deleted too.`)) return
		try {
			await api(`/admin/users/${u.id}`, { method: 'DELETE' })
			void mutate()
		} catch (err) {
			toast.error((err as Error).message)
		}
	}

	if (isLoading || !me) return <Loading />

	return (
		<div className="pane-scroll h-full">
			<div className="mx-auto flex max-w-4xl flex-col gap-4 p-4 sm:p-8">
				<div className="flex items-center gap-3 pl-10 lg:pl-0">
					<h1 className="flex-1 text-2xl font-semibold">People</h1>
					<Button onPress={() => setDialog({ open: true })}>
						<Plus className="size-4" /> Add person
					</Button>
				</div>
				<p className="text-sm text-muted">
					Give someone one project with all its mailboxes, or only some mailboxes. Admins see everything.
				</p>
				{!data?.users.length ? (
					<EmptyState icon={<Users />} title="Just you so far" />
				) : (
					<Card className="p-0">
						<ul>
							{data.users.map(u => (
								<li key={u.id} className="flex items-center gap-3 border-b border-separator px-4 py-3 last:border-0">
									<PersonAvatar who={{ name: u.name, address: u.email }} size={34} />
									<div className="min-w-0 flex-1">
										<div className="flex items-center gap-2">
											<span className="truncate text-sm font-medium">{u.name}</span>
											{u.role !== 'member' && (
												<Chip size="sm" color={u.role === 'owner' ? 'accent' : 'default'} variant="soft">
													{ROLE_LABELS[u.role]}
												</Chip>
											)}
											{u.disabled && (
												<Chip size="sm" color="danger" variant="soft">
													Disabled
												</Chip>
											)}
										</div>
										<div className="truncate text-xs text-muted">{u.email}</div>
										{u.role === 'member' && (
											<div className="mt-1 flex flex-wrap gap-1">
												{u.grants.length === 0 && <span className="text-xs text-warning">No access yet</span>}
												{u.grants.map(g => {
													const p = projectName(g.projectId)
													if (!p) return null
													return (
														<span
															key={g.projectId}
															className="inline-flex items-center gap-1 rounded-md bg-default px-1.5 py-0.5 text-[11px] text-muted"
														>
															<span className="size-1.5 rounded-full" style={{ background: p.color }} />
															{p.name}:{' '}
															{g.access === 'all'
																? 'all'
																: `${g.mailboxIds.length} mailbox${g.mailboxIds.length === 1 ? '' : 'es'}`}
														</span>
													)
												})}
											</div>
										)}
									</div>
									<IconButton label="Edit" onPress={() => setDialog({ open: true, user: u })}>
										<Pencil className="size-4" />
									</IconButton>
									{u.role !== 'owner' && u.id !== me.user.id && (
										<IconButton label="Remove" onPress={() => void remove(u)}>
											<Trash2 className="size-4" />
										</IconButton>
									)}
								</li>
							))}
						</ul>
					</Card>
				)}
			</div>
			<UserDialog
				isOpen={dialog.open}
				onOpenChange={open => setDialog(d => ({ ...d, open }))}
				user={dialog.user}
				onSaved={() => void mutate()}
				actorRole={me.user.role}
			/>
		</div>
	)
}
