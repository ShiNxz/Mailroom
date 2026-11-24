'use client'

import { type Branding, DEFAULT_BRANDING, isAdminRole, type Template } from '@mailroom/shared'
import { Button, Description, Input, Label, ListBox, Modal, Select, Switch, TextField } from '@heroui/react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import useSWR, { mutate } from 'swr'
import { BrandMark, useBranding } from '@/components/Brand'
import { MailEditor } from '@/components/compose/Editor'
import { toggleTheme } from '@/components/Sidebar'
import { ApiTokens } from '@/components/settings/ApiTokens'
import { NotificationsSettings } from '@/components/settings/NotificationsSettings'
import { Section } from '@/components/settings/Section'
import { SecuritySettings } from '@/components/settings/SecuritySettings'
import { IconButton, Loading } from '@/components/ui'
import { api, fetcher, refreshBootstrap, useBootstrap, useMe } from '@/lib/api'

function Profile() {
	const { data: me, mutate } = useMe()
	const [name, setName] = useState(me?.user.name ?? '')
	const [current, setCurrent] = useState('')
	const [next, setNext] = useState('')
	const [busy, setBusy] = useState(false)
	const settings = me?.user.settings ?? {}

	const saveSettings = async (patch: Record<string, unknown>) => {
		try {
			const r = await api<{ user: NonNullable<typeof me>['user'] }>('/auth/me', { method: 'PATCH', body: patch })
			void mutate(prev => (prev ? { ...prev, user: r.user } : prev), { revalidate: false })
		} catch (err) {
			toast.error((err as Error).message)
		}
	}

	const changePassword = async () => {
		setBusy(true)
		try {
			await api('/auth/password', { body: { current, next } })
			setCurrent('')
			setNext('')
			toast.success('Password changed. Other devices were signed out.')
		} catch (err) {
			toast.error((err as Error).message)
		} finally {
			setBusy(false)
		}
	}

	return (
		<>
			<Section title="Profile">
				<div className="flex items-end gap-2">
					<TextField value={name} onChange={setName} className="flex-1">
						<Label>Name</Label>
						<Input />
					</TextField>
					<Button variant="secondary" onPress={() => void saveSettings({ name })}>
						Save
					</Button>
				</div>
				<div className="flex items-center justify-between">
					<div>
						<div className="text-sm font-medium">Theme</div>
						<div className="text-xs text-muted">Also in the sidebar header.</div>
					</div>
					<Button variant="secondary" size="sm" onPress={toggleTheme}>
						Switch light / dark
					</Button>
				</div>
			</Section>

			<Section title="Sending and reading">
				<Select
					value={String(settings.undoSeconds ?? 10)}
					onChange={v => void saveSettings({ settings: { undoSeconds: Number(v) } })}
					className="max-w-xs"
				>
					<Label>Undo send</Label>
					<Select.Trigger>
						<Select.Value />
						<Select.Indicator />
					</Select.Trigger>
					<Select.Popover>
						<ListBox>
							{[0, 5, 10, 20, 30].map(s => (
								<ListBox.Item key={s} id={String(s)} textValue={s ? `${s} seconds` : 'Off'}>
									{s ? `${s} seconds` : 'Off'}
									<ListBox.ItemIndicator />
								</ListBox.Item>
							))}
						</ListBox>
					</Select.Popover>
					<Description>How long a sent message waits so you can take it back.</Description>
				</Select>
				<Switch
					isSelected={settings.notifications ?? false}
					onChange={async on => {
						if (on && 'Notification' in window && Notification.permission !== 'granted') {
							const p = await Notification.requestPermission()
							if (p !== 'granted') return toast.error('The browser blocked notifications for this site')
						}
						void saveSettings({ settings: { notifications: on } })
					}}
				>
					<Switch.Control>
						<Switch.Thumb />
					</Switch.Control>
					<Switch.Content>
						<Label>Desktop notifications for new mail</Label>
						<Description>While Mailroom is open in a tab.</Description>
					</Switch.Content>
				</Switch>
				<Switch
					isSelected={settings.showImages ?? false}
					onChange={on => void saveSettings({ settings: { showImages: on } })}
				>
					<Switch.Control>
						<Switch.Thumb />
					</Switch.Control>
					<Switch.Content>
						<Label>Always show remote images</Label>
						<Description>Off keeps tracking pixels from telling senders you opened their mail.</Description>
					</Switch.Content>
				</Switch>
			</Section>

			<Section title="Password">
				<div className="grid gap-3 sm:grid-cols-2">
					<TextField value={current} onChange={setCurrent} type="password">
						<Label>Current password</Label>
						<Input autoComplete="current-password" />
					</TextField>
					<TextField value={next} onChange={setNext} type="password">
						<Label>New password</Label>
						<Input autoComplete="new-password" placeholder="At least 10 characters" />
					</TextField>
				</div>
				<div>
					<Button
						variant="secondary"
						onPress={() => void changePassword()}
						isPending={busy}
						isDisabled={!current || !next}
					>
						Change password
					</Button>
				</div>
			</Section>
		</>
	)
}

function Signatures() {
	const { data: boot } = useBootstrap()
	const [editing, setEditing] = useState<string | null>(null)
	const [html, setHtml] = useState('')
	const mailboxes = boot?.projects.flatMap(p => p.mailboxes.map(m => ({ ...m, project: p }))) ?? []

	const save = async (mailboxId: string, value: string | null) => {
		try {
			await api(`/mailboxes/${mailboxId}/signature`, { method: 'PUT', body: { html: value } })
			void refreshBootstrap()
			setEditing(null)
			toast.success(value === null ? 'Using the mailbox default' : 'Signature saved')
		} catch (err) {
			toast.error((err as Error).message)
		}
	}

	return (
		<Section
			title="Signatures"
			description="Your own signature for each mailbox. Without one you get the mailbox default an admin set."
		>
			{mailboxes.length === 0 && <p className="text-sm text-muted">No mailboxes yet.</p>}
			{mailboxes.map(m => (
				<div key={m.id} className="flex flex-col gap-2 border-b border-separator pb-4 last:border-0 last:pb-0">
					<div className="flex items-center gap-2">
						<span className="size-2 rounded-full" style={{ background: m.project.color }} />
						<span className="flex-1 truncate text-sm font-medium">{m.address}</span>
						{editing !== m.id && (
							<Button
								size="sm"
								variant="ghost"
								onPress={() => {
									setHtml(m.signature)
									setEditing(m.id)
								}}
							>
								<Pencil className="size-3.5" /> Edit
							</Button>
						)}
					</div>
					{editing === m.id ? (
						<>
							<div className="overflow-hidden rounded-xl border border-border bg-field">
								<MailEditor value={html} onChange={setHtml} placeholder="Your name, title, phone" minHeight={80} />
							</div>
							<div className="flex gap-2">
								<Button size="sm" onPress={() => void save(m.id, html)}>
									Save
								</Button>
								<Button size="sm" variant="secondary" onPress={() => void save(m.id, null)}>
									Use mailbox default
								</Button>
								<Button size="sm" variant="ghost" onPress={() => setEditing(null)}>
									Cancel
								</Button>
							</div>
						</>
					) : m.signature ? (
						<div
							className="signature-preview rounded-lg bg-surface-secondary px-3 py-2 text-sm text-muted"
							dangerouslySetInnerHTML={{ __html: m.signature }}
						/>
					) : (
						<p className="text-xs text-muted">No signature</p>
					)}
				</div>
			))}
		</Section>
	)
}

function Templates() {
	const { data, mutate } = useSWR<{ templates: Template[] }>('/templates', fetcher)
	const { data: boot } = useBootstrap()
	const [open, setOpen] = useState(false)
	const [edit, setEdit] = useState<Template | null>(null)
	const [name, setName] = useState('')
	const [subject, setSubject] = useState('')
	const [html, setHtml] = useState('')
	const [scope, setScope] = useState('personal')

	useEffect(() => {
		if (!open) return
		setName(edit?.name ?? '')
		setSubject(edit?.subject ?? '')
		setHtml(edit?.html ?? '')
		setScope(edit?.projectId ?? 'personal')
	}, [open, edit])

	const save = async () => {
		if (!name.trim() || !html.trim()) return toast.error('Give it a name and some text')
		try {
			if (edit) await api(`/templates/${edit.id}`, { method: 'PUT', body: { name, subject, html } })
			else await api('/templates', { body: { name, subject, html, projectId: scope === 'personal' ? null : scope } })
			void mutate()
			setOpen(false)
		} catch (err) {
			toast.error((err as Error).message)
		}
	}

	return (
		<Section
			title="Templates"
			description="Saved replies you insert from the composer. Project templates are shared with everyone on the project."
		>
			{data?.templates.map(t => (
				<div key={t.id} className="flex items-center gap-2">
					<div className="min-w-0 flex-1">
						<div className="truncate text-sm font-medium">{t.name}</div>
						<div className="truncate text-xs text-muted">
							{t.projectId ? (boot?.projects.find(p => p.id === t.projectId)?.name ?? 'Project') : 'Personal'}
							{t.subject && ` · ${t.subject}`}
						</div>
					</div>
					<IconButton
						label="Edit"
						onPress={() => {
							setEdit(t)
							setOpen(true)
						}}
					>
						<Pencil className="size-4" />
					</IconButton>
					<IconButton
						label="Delete"
						onPress={async () => {
							await api(`/templates/${t.id}`, { method: 'DELETE' }).catch(err => toast.error(err.message))
							void mutate()
						}}
					>
						<Trash2 className="size-4" />
					</IconButton>
				</div>
			))}
			<div>
				<Button
					variant="secondary"
					size="sm"
					onPress={() => {
						setEdit(null)
						setOpen(true)
					}}
				>
					<Plus className="size-4" /> New template
				</Button>
			</div>
			<Modal.Backdrop isOpen={open} onOpenChange={setOpen}>
				<Modal.Container size="lg">
					<Modal.Dialog>
						<Modal.CloseTrigger />
						<Modal.Header>
							<Modal.Heading>{edit ? 'Edit template' : 'New template'}</Modal.Heading>
						</Modal.Header>
						<Modal.Body className="flex flex-col gap-3">
							<div className="grid gap-3 sm:grid-cols-2">
								<TextField value={name} onChange={setName} autoFocus>
									<Label>Name</Label>
									<Input placeholder="Pricing reply" />
								</TextField>
								{!edit && (
									<Select value={scope} onChange={v => setScope(String(v))}>
										<Label>Who can use it</Label>
										<Select.Trigger>
											<Select.Value />
											<Select.Indicator />
										</Select.Trigger>
										<Select.Popover>
											<ListBox>
												<ListBox.Item id="personal" textValue="Only me">
													Only me
													<ListBox.ItemIndicator />
												</ListBox.Item>
												{boot?.projects.map(p => (
													<ListBox.Item key={p.id} id={p.id} textValue={p.name}>
														Everyone on {p.name}
														<ListBox.ItemIndicator />
													</ListBox.Item>
												))}
											</ListBox>
										</Select.Popover>
									</Select>
								)}
							</div>
							<TextField value={subject} onChange={setSubject}>
								<Label>Subject (optional)</Label>
								<Input />
							</TextField>
							<div className="overflow-hidden rounded-xl border border-border bg-field">
								<MailEditor value={html} onChange={setHtml} minHeight={160} />
							</div>
						</Modal.Body>
						<Modal.Footer>
							<Button slot="close" variant="secondary">
								Cancel
							</Button>
							<Button onPress={() => void save()}>Save</Button>
						</Modal.Footer>
					</Modal.Dialog>
				</Modal.Container>
			</Modal.Backdrop>
		</Section>
	)
}

function BrandingSettings() {
	const current = useBranding()
	const [name, setName] = useState(current.name)
	const [logoUrl, setLogoUrl] = useState(current.logoUrl ?? '')
	const [busy, setBusy] = useState(false)

	// Fill the form once the saved branding has loaded
	useEffect(() => {
		setName(current.name)
		setLogoUrl(current.logoUrl ?? '')
	}, [current.name, current.logoUrl])

	const preview: Branding = { name: name.trim() || DEFAULT_BRANDING.name, logoUrl: logoUrl.trim() || null }
	const changed = preview.name !== current.name || preview.logoUrl !== current.logoUrl

	const save = async (value: Branding) => {
		setBusy(true)
		try {
			const saved = await api<Branding>('/admin/branding', { method: 'PUT', body: value })
			void mutate('/branding', saved, { revalidate: false })
			toast.success('Branding saved for everyone')
		} catch (err) {
			toast.error((err as Error).message)
		} finally {
			setBusy(false)
		}
	}

	return (
		<Section
			title="Branding"
			description="The name and logo everyone sees instead of Mailroom: sidebar, sign-in page and browser tab."
		>
			<div className="grid gap-3 sm:grid-cols-2">
				<TextField value={name} onChange={setName} maxLength={40}>
					<Label>Name</Label>
					<Input placeholder="Mailroom" />
				</TextField>
				<TextField value={logoUrl} onChange={setLogoUrl}>
					<Label>Logo image URL</Label>
					<Input placeholder="https://example.com/logo.png" inputMode="url" />
					<Description>A square PNG, SVG or JPG works best. Leave empty for the default.</Description>
				</TextField>
			</div>
			<div className="flex items-center gap-3 rounded-xl border border-border bg-surface-secondary px-4 py-3">
				<span className="text-xs text-muted">Preview</span>
				<BrandMark branding={preview} />
				<span className="truncate font-semibold tracking-tight">{preview.name}</span>
			</div>
			<div className="flex gap-2">
				<Button onPress={() => void save(preview)} isPending={busy} isDisabled={!changed}>
					Save
				</Button>
				<Button
					variant="secondary"
					isDisabled={busy || (current.name === DEFAULT_BRANDING.name && !current.logoUrl)}
					onPress={() => void save(DEFAULT_BRANDING)}
				>
					Reset to default
				</Button>
			</div>
		</Section>
	)
}

export default function SettingsPage() {
	const { data: me } = useMe()
	if (!me) return <Loading />
	return (
		<div className="pane-scroll h-full">
			<div className="mx-auto flex max-w-3xl flex-col gap-4 p-4 pb-24 sm:p-8">
				<h1 className="pl-10 text-2xl font-semibold lg:pl-0">Settings</h1>
				<Profile />
				<NotificationsSettings />
				<SecuritySettings />
				<ApiTokens />
				{isAdminRole(me.user.role) && <BrandingSettings />}
				<Signatures />
				<Templates />
			</div>
		</div>
	)
}
