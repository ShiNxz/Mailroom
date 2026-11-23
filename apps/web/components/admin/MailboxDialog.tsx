'use client'

import type { AutoconfigResult, MailboxSettings, Security } from '@mailroom/shared'
import { Alert, Button, Description, Input, Label, ListBox, Modal, Select, Switch, TextField } from '@heroui/react'
import { CheckCircle2, ChevronDown, XCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { MailEditor } from '@/components/compose/Editor'
import { api, refreshBootstrap } from '@/lib/api'

type TestResult = { imap: { ok: boolean; error?: string }; smtp: { ok: boolean; error?: string } }

const SECURITY: { id: Security; label: string }[] = [
	{ id: 'tls', label: 'SSL/TLS' },
	{ id: 'starttls', label: 'STARTTLS' },
	{ id: 'none', label: 'None (unsafe)' },
]

const blank: MailboxSettings & { password: string } = {
	address: '',
	displayName: '',
	username: '',
	password: '',
	imapHost: '',
	imapPort: 993,
	imapSecurity: 'tls',
	smtpHost: '',
	smtpPort: 465,
	smtpSecurity: 'tls',
	saveSent: true,
	signature: '',
	enabled: true,
}

function SecuritySelect({
	value,
	onChange,
	label,
}: {
	value: Security
	onChange: (v: Security) => void
	label: string
}) {
	return (
		<Select value={value} onChange={v => onChange(v as Security)} aria-label={label} className="w-36">
			<Label>Security</Label>
			<Select.Trigger>
				<Select.Value />
				<Select.Indicator />
			</Select.Trigger>
			<Select.Popover>
				<ListBox>
					{SECURITY.map(s => (
						<ListBox.Item key={s.id} id={s.id} textValue={s.label}>
							{s.label}
							<ListBox.ItemIndicator />
						</ListBox.Item>
					))}
				</ListBox>
			</Select.Popover>
		</Select>
	)
}

/** Connect a mailbox (create) or change its settings (edit). Settings are detected from the address. */
export function MailboxDialog({
	isOpen,
	onOpenChange,
	projectId,
	mailboxId,
	onSaved,
}: {
	isOpen: boolean
	onOpenChange: (v: boolean) => void
	projectId: string
	mailboxId?: string
	onSaved: () => void
}) {
	const editing = !!mailboxId
	const [form, setForm] = useState(blank)
	const [step, setStep] = useState<'address' | 'details'>(editing ? 'details' : 'address')
	const [detected, setDetected] = useState<AutoconfigResult | null>(null)
	const [advanced, setAdvanced] = useState(editing)
	const [busy, setBusy] = useState(false)
	const [test, setTest] = useState<TestResult | null>(null)

	useEffect(() => {
		if (!isOpen) return
		setTest(null)
		setDetected(null)
		if (mailboxId) {
			setStep('details')
			setAdvanced(true)
			api<{ settings: MailboxSettings }>(`/admin/mailboxes/${mailboxId}`)
				.then(r => setForm({ ...r.settings, password: '' }))
				.catch(err => toast.error((err as Error).message))
		} else {
			setForm(blank)
			setStep('address')
			setAdvanced(false)
		}
	}, [isOpen, mailboxId])

	const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm(f => ({ ...f, [key]: value }))

	const detect = async () => {
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.address)) return toast.error('Enter a valid email address')
		setBusy(true)
		try {
			const r = await api<AutoconfigResult>('/admin/autoconfig', { body: { address: form.address } })
			setDetected(r)
			setForm(f => ({
				...f,
				username: r.username,
				imapHost: r.imapHost,
				imapPort: r.imapPort,
				imapSecurity: r.imapSecurity,
				smtpHost: r.smtpHost,
				smtpPort: r.smtpPort,
				smtpSecurity: r.smtpSecurity,
				saveSent: r.saveSent,
			}))
			setAdvanced(r.source === 'guess')
			setStep('details')
		} catch (err) {
			toast.error((err as Error).message)
		} finally {
			setBusy(false)
		}
	}

	const connection = () => ({
		username: form.username,
		imapHost: form.imapHost,
		imapPort: Number(form.imapPort),
		imapSecurity: form.imapSecurity,
		smtpHost: form.smtpHost,
		smtpPort: Number(form.smtpPort),
		smtpSecurity: form.smtpSecurity,
	})

	const runTest = async () => {
		setBusy(true)
		setTest(null)
		try {
			const r = await api<TestResult>('/admin/mailboxes/test', {
				body: { ...connection(), password: form.password || undefined, mailboxId },
			})
			setTest(r)
			return r
		} catch (err) {
			toast.error((err as Error).message)
			return null
		} finally {
			setBusy(false)
		}
	}

	const save = async () => {
		setBusy(true)
		try {
			if (editing) {
				await api(`/admin/mailboxes/${mailboxId}`, {
					method: 'PATCH',
					body: {
						...connection(),
						displayName: form.displayName,
						saveSent: form.saveSent,
						signature: form.signature,
						enabled: form.enabled,
						...(form.password ? { password: form.password } : {}),
					},
				})
				toast.success('Saved')
			} else {
				if (!form.password) return toast.error('Enter the password')
				const r = await api<{ ok: boolean } & Partial<TestResult>>(`/admin/projects/${projectId}/mailboxes`, {
					body: {
						...connection(),
						address: form.address,
						password: form.password,
						displayName: form.displayName,
						saveSent: form.saveSent,
						signature: form.signature,
					},
				})
				if (!r.ok) {
					setTest({ imap: r.imap!, smtp: r.smtp! })
					setAdvanced(true)
					return
				}
				toast.success(`${form.address} connected. Syncing starts now.`)
			}
			onSaved()
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
			<Modal.Container size="lg" scroll="inside">
				<Modal.Dialog>
					<Modal.CloseTrigger />
					<Modal.Header>
						<Modal.Heading>{editing ? form.address : 'Connect a mailbox'}</Modal.Heading>
					</Modal.Header>
					<Modal.Body className="flex flex-col gap-4">
						{step === 'address' ? (
							<>
								<TextField value={form.address} onChange={v => set('address', v.trim())} type="email" autoFocus>
									<Label>Email address</Label>
									<Input placeholder="hello@yourdomain.com" />
									<Description>We look up the server settings for you.</Description>
								</TextField>
							</>
						) : (
							<>
								{detected && (
									<Alert status={detected.source === 'guess' ? 'warning' : 'accent'}>
										<Alert.Indicator />
										<Alert.Content>
											<Alert.Title>
												{detected.source === 'guess'
													? 'Could not find the settings, so these are guesses'
													: `Found settings${detected.provider ? ` for ${detected.provider}` : ''}`}
											</Alert.Title>
											{detected.note && <Alert.Description>{detected.note}</Alert.Description>}
										</Alert.Content>
									</Alert>
								)}
								<div className="grid gap-3 sm:grid-cols-2">
									{!editing && (
										<TextField value={form.address} isReadOnly>
											<Label>Address</Label>
											<Input />
										</TextField>
									)}
									<TextField value={form.displayName} onChange={v => set('displayName', v)}>
										<Label>Sender name</Label>
										<Input placeholder="Acme Support" />
									</TextField>
									<TextField
										value={form.password}
										onChange={v => set('password', v)}
										type="password"
										autoFocus={!editing}
									>
										<Label>{editing ? 'New password (leave empty to keep)' : 'Password'}</Label>
										<Input autoComplete="new-password" />
									</TextField>
								</div>

								<button
									type="button"
									className="flex items-center gap-1 self-start text-sm text-muted hover:text-foreground"
									onClick={() => setAdvanced(a => !a)}
								>
									<ChevronDown className={`size-4 transition-transform ${advanced ? 'rotate-180' : ''}`} /> Server
									settings
								</button>
								{advanced && (
									<div className="flex flex-col gap-3 rounded-xl bg-surface-secondary p-3">
										<TextField value={form.username} onChange={v => set('username', v)}>
											<Label>Username</Label>
											<Input />
										</TextField>
										<div className="flex flex-wrap items-end gap-2">
											<TextField
												value={form.imapHost}
												onChange={v => set('imapHost', v.trim())}
												className="min-w-48 flex-1"
											>
												<Label>IMAP server (incoming)</Label>
												<Input placeholder="imap.example.com" />
											</TextField>
											<TextField
												value={String(form.imapPort)}
												onChange={v => set('imapPort', Number(v.replace(/\D/g, '')) || 0)}
												className="w-24"
											>
												<Label>Port</Label>
												<Input inputMode="numeric" />
											</TextField>
											<SecuritySelect
												value={form.imapSecurity}
												onChange={v => set('imapSecurity', v)}
												label="IMAP security"
											/>
										</div>
										<div className="flex flex-wrap items-end gap-2">
											<TextField
												value={form.smtpHost}
												onChange={v => set('smtpHost', v.trim())}
												className="min-w-48 flex-1"
											>
												<Label>SMTP server (outgoing)</Label>
												<Input placeholder="smtp.example.com" />
											</TextField>
											<TextField
												value={String(form.smtpPort)}
												onChange={v => set('smtpPort', Number(v.replace(/\D/g, '')) || 0)}
												className="w-24"
											>
												<Label>Port</Label>
												<Input inputMode="numeric" />
											</TextField>
											<SecuritySelect
												value={form.smtpSecurity}
												onChange={v => set('smtpSecurity', v)}
												label="SMTP security"
											/>
										</div>
										<Switch isSelected={form.saveSent} onChange={v => set('saveSent', v)}>
											<Switch.Control>
												<Switch.Thumb />
											</Switch.Control>
											<Switch.Content>
												<Label>Save sent mail to the Sent folder</Label>
												<Description>Turn off for Gmail and Microsoft 365, they do it themselves.</Description>
											</Switch.Content>
										</Switch>
										{editing && (
											<Switch isSelected={form.enabled} onChange={v => set('enabled', v)}>
												<Switch.Control>
													<Switch.Thumb />
												</Switch.Control>
												<Switch.Content>
													<Label>Sync this mailbox</Label>
												</Switch.Content>
											</Switch>
										)}
									</div>
								)}

								<div className="flex flex-col gap-1.5">
									<span className="text-sm font-medium">Default signature</span>
									<span className="text-xs text-muted">
										Everyone who sends from this mailbox gets it, unless they set their own in Settings.
									</span>
									<div className="overflow-hidden rounded-xl border border-border bg-field">
										<MailEditor
											value={form.signature}
											onChange={v => set('signature', v)}
											placeholder="Name, title, phone..."
											minHeight={70}
										/>
									</div>
								</div>

								{test && (
									<div className="flex flex-col gap-1.5 rounded-xl border border-border p-3 text-sm">
										{(['imap', 'smtp'] as const).map(k => (
											<div key={k} className="flex items-start gap-2">
												{test[k].ok ? (
													<CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
												) : (
													<XCircle className="mt-0.5 size-4 shrink-0 text-danger" />
												)}
												<span>
													<span className="font-medium">{k === 'imap' ? 'Incoming (IMAP)' : 'Outgoing (SMTP)'}:</span>{' '}
													<span className="text-muted">{test[k].ok ? 'connected' : test[k].error}</span>
												</span>
											</div>
										))}
									</div>
								)}
							</>
						)}
					</Modal.Body>
					<Modal.Footer>
						{step === 'address' ? (
							<Button onPress={() => void detect()} isPending={busy}>
								Continue
							</Button>
						) : (
							<>
								{!editing && (
									<Button variant="ghost" onPress={() => setStep('address')}>
										Back
									</Button>
								)}
								<Button
									variant="secondary"
									onPress={() => void runTest()}
									isPending={busy}
									isDisabled={!editing && !form.password}
								>
									Test connection
								</Button>
								<Button onPress={() => void save()} isPending={busy}>
									{editing ? 'Save' : 'Connect'}
								</Button>
							</>
						)}
					</Modal.Footer>
				</Modal.Dialog>
			</Modal.Container>
		</Modal.Backdrop>
	)
}
