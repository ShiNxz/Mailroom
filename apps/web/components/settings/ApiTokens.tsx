'use client'

import type { ApiToken, NewApiToken, TokenScope } from '@mailroom/shared'
import {
	Alert,
	Button,
	Checkbox,
	Chip,
	Description,
	Input,
	Label,
	ListBox,
	Modal,
	Radio,
	RadioGroup,
	Select,
	TextField,
} from '@heroui/react'
import { formatDistanceToNow } from 'date-fns'
import { Copy, KeyRound, Plus, Send, Trash2, Webhook } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import useSWR from 'swr'
import { IconButton } from '@/components/ui'
import { api, fetcher, useBootstrap } from '@/lib/api'
import { Section } from './Section'

type TokenRow = ApiToken & { failedDeliveries: number }

const EXPIRY = [
	{ id: '30', label: '30 days', days: 30 },
	{ id: '90', label: '90 days', days: 90 },
	{ id: '365', label: '1 year', days: 365 },
	{ id: 'never', label: 'Never', days: null },
] as const

function CopyField({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex flex-col gap-1">
			<span className="text-xs font-medium text-muted">{label}</span>
			<div className="flex items-center gap-2 rounded-lg bg-surface-secondary px-3 py-2">
				<code className="min-w-0 flex-1 truncate font-mono text-xs select-all">{value}</code>
				<IconButton
					label="Copy"
					onPress={() => {
						void navigator.clipboard.writeText(value)
						toast.success(`${label} copied`)
					}}
				>
					<Copy className="size-3.5" />
				</IconButton>
			</div>
		</div>
	)
}

export function ApiTokens() {
	const { data, mutate } = useSWR<{ tokens: TokenRow[] }>('/tokens', fetcher)
	const { data: boot } = useBootstrap()
	const [open, setOpen] = useState(false)
	const [created, setCreated] = useState<NewApiToken | null>(null)
	const projects = boot?.projects ?? []

	const scopeText = (scope: TokenScope) => {
		if (scope.type === 'all') return 'All your mailboxes'
		const names = [
			...scope.projectIds.map(id => projects.find(p => p.id === id)?.name).filter(Boolean),
			...scope.mailboxIds.map(id => projects.flatMap(p => p.mailboxes).find(m => m.id === id)?.address).filter(Boolean),
		]
		return names.join(', ') || 'Nothing (the mailboxes were removed)'
	}

	return (
		<Section
			title="API tokens"
			description={
				<>
					Let your apps send and receive mail through{' '}
					{typeof window !== 'undefined' ? window.location.host : 'Mailroom'} instead of SMTP. A token reaches only what
					you can, narrowed to the mailboxes you pick.
				</>
			}
			action={
				<Button size="sm" variant="secondary" onPress={() => setOpen(true)}>
					<Plus className="size-3.5" /> New token
				</Button>
			}
		>
			{data && !data.tokens.length && <p className="text-sm text-muted">No tokens yet.</p>}
			{data?.tokens.map(t => (
				<div key={t.id} className="flex items-start gap-3 rounded-lg border border-separator px-3 py-2.5">
					<KeyRound className="mt-0.5 size-4 shrink-0 text-muted" />
					<div className="min-w-0 flex-1">
						<div className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
							{t.name}
							<code className="font-mono text-xs font-normal text-muted">{t.prefix}...</code>
							{t.canRead && (
								<Chip size="sm" variant="soft">
									read
								</Chip>
							)}
							{t.canSend && (
								<Chip size="sm" variant="soft">
									send
								</Chip>
							)}
						</div>
						<div className="truncate text-xs text-muted">{scopeText(t.scope)}</div>
						<div className="text-xs text-muted">
							Used {t.lastUsedAt ? formatDistanceToNow(new Date(t.lastUsedAt), { addSuffix: true }) : 'never'}
							{t.expiresAt && ` · expires ${formatDistanceToNow(new Date(t.expiresAt), { addSuffix: true })}`}
						</div>
						{t.webhookUrl && (
							<div className="mt-1 flex items-center gap-1.5 text-xs text-muted">
								<Webhook className="size-3 shrink-0" />
								<span className="truncate">{t.webhookUrl}</span>
								{t.failedDeliveries > 0 && <span className="shrink-0 text-danger">· {t.failedDeliveries} failed</span>}
							</div>
						)}
					</div>
					{t.webhookUrl && (
						<IconButton
							label="Send a test webhook"
							onPress={async () => {
								try {
									const r = await api<{ ok: boolean; status: number | null; error?: string }>(
										`/tokens/${t.id}/webhook/test`,
										{
											body: {},
										},
									)
									if (r.ok) toast.success(`Webhook answered ${r.status}`)
									else
										toast.error(r.status ? `Webhook answered ${r.status}` : (r.error ?? 'The webhook did not answer'))
								} catch (err) {
									toast.error((err as Error).message)
								}
							}}
						>
							<Send className="size-4" />
						</IconButton>
					)}
					<IconButton
						label="Revoke"
						onPress={async () => {
							if (!window.confirm(`Revoke "${t.name}"? Apps using it stop working right away.`)) return
							await api(`/tokens/${t.id}`, { method: 'DELETE' }).catch(err => toast.error(err.message))
							void mutate()
						}}
					>
						<Trash2 className="size-4" />
					</IconButton>
				</div>
			))}

			{open && (
				<NewTokenDialog
					onClose={() => setOpen(false)}
					onCreated={t => {
						setOpen(false)
						setCreated(t)
						void mutate()
					}}
				/>
			)}

			<Modal.Backdrop isOpen={!!created} onOpenChange={o => !o && setCreated(null)} isDismissable={false}>
				<Modal.Container size="lg">
					<Modal.Dialog>
						<Modal.Header>
							<Modal.Heading>Token created</Modal.Heading>
						</Modal.Header>
						<Modal.Body className="flex flex-col gap-4">
							{created && (
								<>
									<Alert status="warning">
										<Alert.Indicator />
										<Alert.Content>
											<Alert.Description>Copy it now. It is stored hashed and won't be shown again.</Alert.Description>
										</Alert.Content>
									</Alert>
									<CopyField label="Token" value={created.secret} />
									{created.webhookSecret && <CopyField label="Webhook signing secret" value={created.webhookSecret} />}
									<SdkSnippet token={created.secret} />
								</>
							)}
						</Modal.Body>
						<Modal.Footer>
							<Button onPress={() => setCreated(null)}>Done</Button>
						</Modal.Footer>
					</Modal.Dialog>
				</Modal.Container>
			</Modal.Backdrop>
		</Section>
	)
}

function SdkSnippet({ token }: { token: string }) {
	const { data: boot } = useBootstrap()
	const origin = typeof window !== 'undefined' ? window.location.origin : 'https://mail.example.com'
	const address = boot?.projects[0]?.mailboxes[0]?.address ?? 'hello@example.com'
	const env = `MAILROOM_URL=${origin}\nMAILROOM_TOKEN=${token}`
	const code = `import { Mailroom } from 'mailroom-sdk'

const mail = new Mailroom() // reads MAILROOM_URL and MAILROOM_TOKEN
const support = mail.mailbox('${address}')

await support.send({ to: 'someone@example.com', subject: 'Hi', text: 'Hello!' })

support.on('message', async msg => {
  console.log(msg.from.address, msg.subject)
  await msg.reply({ text: 'Got it, thanks!' })
})`
	return (
		<div className="flex flex-col gap-2">
			<span className="text-xs font-medium text-muted">Use it</span>
			<pre className="overflow-x-auto rounded-lg bg-surface-secondary p-3 font-mono text-xs leading-relaxed">{env}</pre>
			<pre className="overflow-x-auto rounded-lg bg-surface-secondary p-3 font-mono text-xs leading-relaxed">
				{code}
			</pre>
			<p className="text-xs text-muted">
				Or without the SDK:{' '}
				<code className="font-mono">curl -H "Authorization: Bearer $MAILROOM_TOKEN" {origin}/api/mailboxes</code>
			</p>
		</div>
	)
}

function NewTokenDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (t: NewApiToken) => void }) {
	const { data: boot } = useBootstrap()
	const [name, setName] = useState('')
	const [canRead, setCanRead] = useState(true)
	const [canSend, setCanSend] = useState(true)
	const [scopeType, setScopeType] = useState<'all' | 'selected'>('all')
	const [projectIds, setProjectIds] = useState<string[]>([])
	const [mailboxIds, setMailboxIds] = useState<string[]>([])
	const [expiry, setExpiry] = useState<string>('90')
	const [webhookUrl, setWebhookUrl] = useState('')
	const [busy, setBusy] = useState(false)
	const projects = boot?.projects ?? []
	const toggle = (list: string[], id: string, on: boolean) => (on ? [...list, id] : list.filter(x => x !== id))

	const create = async () => {
		setBusy(true)
		try {
			const scope: TokenScope = scopeType === 'all' ? { type: 'all' } : { type: 'selected', projectIds, mailboxIds }
			const days = EXPIRY.find(e => e.id === expiry)?.days ?? null
			onCreated(
				await api<NewApiToken>('/tokens', {
					body: { name, canRead, canSend, scope, expiresInDays: days, webhookUrl: webhookUrl.trim() || null },
				}),
			)
		} catch (err) {
			toast.error((err as Error).message)
		} finally {
			setBusy(false)
		}
	}

	return (
		<Modal.Backdrop isOpen onOpenChange={o => !o && onClose()}>
			<Modal.Container size="lg">
				<Modal.Dialog>
					<Modal.CloseTrigger />
					<Modal.Header>
						<Modal.Heading>New API token</Modal.Heading>
					</Modal.Header>
					<Modal.Body className="flex flex-col gap-4">
						<TextField value={name} onChange={setName} autoFocus>
							<Label>Name</Label>
							<Input placeholder="Billing service" />
						</TextField>

						<div className="flex flex-col gap-2">
							<span className="text-sm font-medium">It can</span>
							<div className="flex gap-4">
								<Checkbox isSelected={canRead} onChange={setCanRead}>
									<Checkbox.Content>
										<Checkbox.Control>
											<Checkbox.Indicator />
										</Checkbox.Control>
										<span className="text-sm">Read and receive mail</span>
									</Checkbox.Content>
								</Checkbox>
								<Checkbox isSelected={canSend} onChange={setCanSend}>
									<Checkbox.Content>
										<Checkbox.Control>
											<Checkbox.Indicator />
										</Checkbox.Control>
										<span className="text-sm">Send mail</span>
									</Checkbox.Content>
								</Checkbox>
							</div>
						</div>

						<RadioGroup value={scopeType} onChange={v => setScopeType(v as 'all' | 'selected')}>
							<Label>Mailboxes</Label>
							{/* Radio.Content is the clickable label: it wraps the control and the label */}
							<Radio value="all">
								<Radio.Content>
									<Radio.Control>
										<Radio.Indicator />
									</Radio.Control>
									<Label>All my mailboxes</Label>
								</Radio.Content>
								<Description>Including ones you get access to later</Description>
							</Radio>
							<Radio value="selected">
								<Radio.Content>
									<Radio.Control>
										<Radio.Indicator />
									</Radio.Control>
									<Label>Only the projects or mailboxes I pick</Label>
								</Radio.Content>
							</Radio>
						</RadioGroup>

						{scopeType === 'selected' && (
							<div className="flex max-h-64 flex-col gap-3 overflow-y-auto rounded-xl border border-separator p-3">
								{projects.map(p => {
									const whole = projectIds.includes(p.id)
									return (
										<div key={p.id} className="flex flex-col gap-1.5">
											<Checkbox isSelected={whole} onChange={on => setProjectIds(l => toggle(l, p.id, on))}>
												<Checkbox.Content>
													<Checkbox.Control>
														<Checkbox.Indicator />
													</Checkbox.Control>
													<span className="inline-flex items-center gap-1.5 text-sm font-medium">
														<span className="size-2 rounded-[3px]" style={{ background: p.color }} />
														{p.name}
														<span className="font-normal text-muted">· every mailbox</span>
													</span>
												</Checkbox.Content>
											</Checkbox>
											<div className="flex flex-col gap-1 pl-6">
												{p.mailboxes.map(m => (
													<Checkbox
														key={m.id}
														isSelected={whole || mailboxIds.includes(m.id)}
														isDisabled={whole}
														onChange={on => setMailboxIds(l => toggle(l, m.id, on))}
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
										</div>
									)
								})}
							</div>
						)}

						<div className="grid gap-4 sm:grid-cols-[160px_1fr]">
							<Select value={expiry} onChange={v => setExpiry(String(v))}>
								<Label>Expires</Label>
								<Select.Trigger>
									<Select.Value />
									<Select.Indicator />
								</Select.Trigger>
								<Select.Popover>
									<ListBox>
										{EXPIRY.map(e => (
											<ListBox.Item key={e.id} id={e.id} textValue={e.label}>
												{e.label}
												<ListBox.ItemIndicator />
											</ListBox.Item>
										))}
									</ListBox>
								</Select.Popover>
							</Select>
							<TextField value={webhookUrl} onChange={setWebhookUrl}>
								<Label>Webhook URL (optional)</Label>
								<Input placeholder="https://your-app.com/hooks/mail" inputMode="url" />
								<Description>New mail and send results are POSTed here, signed.</Description>
							</TextField>
						</div>
					</Modal.Body>
					<Modal.Footer>
						<Button slot="close" variant="secondary">
							Cancel
						</Button>
						<Button
							onPress={() => void create()}
							isPending={busy}
							isDisabled={
								(!canRead && !canSend) || (scopeType === 'selected' && !projectIds.length && !mailboxIds.length)
							}
						>
							Create token
						</Button>
					</Modal.Footer>
				</Modal.Dialog>
			</Modal.Container>
		</Modal.Backdrop>
	)
}
