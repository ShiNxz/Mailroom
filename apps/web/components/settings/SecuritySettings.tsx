'use client'

import type { SessionInfo } from '@mailroom/shared'
import { Button, Chip, Input, Label, Modal, TextField } from '@heroui/react'
import { formatDistanceToNow } from 'date-fns'
import { Fingerprint, KeyRound, Laptop, LogOut, Pencil, Plus, Smartphone, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import useSWR from 'swr'
import { RecoveryCodes, TotpSetup } from '@/components/security/parts'
import { IconButton } from '@/components/ui'
import { api, fetcher, useMe } from '@/lib/api'
import { addPasskey, passkeyError, passkeysSupported } from '@/lib/webauthn'
import { Section } from './Section'

const ago = (iso: string | null) => (iso ? formatDistanceToNow(new Date(iso), { addSuffix: true }) : 'never')

/** "Chrome on Mac" from a user agent, for the sessions list. */
function deviceOf(label: string | null) {
	if (!label) return 'Unknown device'
	if (label.startsWith('Mailroom')) return label
	const os = /iPhone/.test(label)
		? 'iPhone'
		: /iPad/.test(label)
			? 'iPad'
			: /Android/.test(label)
				? 'Android'
				: /Mac OS X|Macintosh/.test(label)
					? 'Mac'
					: /Windows/.test(label)
						? 'Windows'
						: /Linux/.test(label)
							? 'Linux'
							: ''
	const browser = /Edg\//.test(label)
		? 'Edge'
		: /Firefox\//.test(label)
			? 'Firefox'
			: /Chrome\//.test(label)
				? 'Chrome'
				: /Safari\//.test(label)
					? 'Safari'
					: ''
	return [browser, os].filter(Boolean).join(' on ') || label.slice(0, 60)
}

export function SecuritySettings() {
	const { data: me, mutate } = useMe()
	const { data: sessions, mutate: reloadSessions } = useSWR<{ sessions: SessionInfo[] }>('/auth/sessions', fetcher)
	const [busy, setBusy] = useState(false)
	const [totpOpen, setTotpOpen] = useState(false)
	const [codes, setCodes] = useState<string[] | null>(null)
	const [rename, setRename] = useState<{ id: string; name: string } | null>(null)
	const security = me?.security
	if (!security) return null
	const factors = security.passkeys.length + (security.totp ? 1 : 0)

	const run = async (fn: () => Promise<unknown>, ok?: string) => {
		setBusy(true)
		try {
			await fn()
			if (ok) toast.success(ok)
		} catch (err) {
			toast.error(passkeyError(err))
		} finally {
			setBusy(false)
			void mutate()
		}
	}

	return (
		<Section
			title="Sign-in security"
			description="Every sign-in needs your password and a passkey or authenticator code, or a passkey alone."
		>
			<div className="flex flex-col gap-2">
				<div className="flex items-center justify-between">
					<h3 className="flex items-center gap-2 text-sm font-medium">
						<Fingerprint className="size-4 text-muted" /> Passkeys
					</h3>
					<Button
						size="sm"
						variant="secondary"
						isDisabled={busy || !passkeysSupported()}
						onPress={() =>
							void run(async () => {
								const r = await addPasskey()
								if (r.recoveryCodes) setCodes(r.recoveryCodes)
							}, 'Passkey added')
						}
					>
						<Plus className="size-3.5" /> Add a passkey
					</Button>
				</div>
				{security.passkeys.length === 0 && <p className="text-xs text-muted">No passkeys yet.</p>}
				{security.passkeys.map(p => (
					<div key={p.id} className="flex items-center gap-3 rounded-lg border border-separator px-3 py-2">
						<KeyRound className="size-4 shrink-0 text-muted" />
						<div className="min-w-0 flex-1">
							<div className="truncate text-sm">{p.name}</div>
							<div className="text-xs text-muted">
								Added {ago(p.createdAt)} · last used {ago(p.lastUsedAt)}
							</div>
						</div>
						<IconButton label="Rename" onPress={() => setRename({ id: p.id, name: p.name })}>
							<Pencil className="size-4" />
						</IconButton>
						<IconButton
							label={factors <= 1 ? 'Add another passkey or an authenticator first' : 'Remove'}
							isDisabled={factors <= 1}
							onPress={() => {
								if (!window.confirm(`Remove the passkey "${p.name}"? It won't sign you in anymore.`)) return
								void run(
									() => api(`/auth/passkeys/${encodeURIComponent(p.id)}`, { method: 'DELETE' }),
									'Passkey removed',
								)
							}}
						>
							<Trash2 className="size-4" />
						</IconButton>
					</div>
				))}
			</div>

			<div className="flex items-center justify-between gap-3 border-t border-separator pt-4">
				<div className="min-w-0">
					<h3 className="flex items-center gap-2 text-sm font-medium">
						<Smartphone className="size-4 text-muted" /> Authenticator app
						{security.totp && (
							<Chip size="sm" color="success" variant="soft">
								On
							</Chip>
						)}
					</h3>
					<p className="text-xs text-muted">6-digit codes from 1Password, Google Authenticator, Authy...</p>
				</div>
				{security.totp ? (
					<Button
						size="sm"
						variant="ghost"
						isDisabled={busy || factors <= 1}
						onPress={() => {
							if (!window.confirm('Turn off the authenticator app? Its codes will stop working.')) return
							void run(() => api('/auth/totp', { method: 'DELETE' }), 'Authenticator turned off')
						}}
					>
						Turn off
					</Button>
				) : (
					<Button size="sm" variant="secondary" isDisabled={busy} onPress={() => setTotpOpen(true)}>
						Set up
					</Button>
				)}
			</div>

			<div className="flex items-center justify-between gap-3 border-t border-separator pt-4">
				<div className="min-w-0">
					<h3 className="text-sm font-medium">Recovery codes</h3>
					<p className="text-xs text-muted">
						{security.recoveryCodes} left. Each signs you in once if you lose your passkey or phone.
					</p>
				</div>
				<Button
					size="sm"
					variant="secondary"
					isDisabled={busy}
					onPress={() => {
						if (!window.confirm('Make new recovery codes? The old ones stop working.')) return
						void run(async () => {
							const r = await api<{ recoveryCodes: string[] }>('/auth/recovery-codes', { body: {} })
							setCodes(r.recoveryCodes)
						})
					}}
				>
					New codes
				</Button>
			</div>

			<div className="flex flex-col gap-2 border-t border-separator pt-4">
				<h3 className="text-sm font-medium">Where you're signed in</h3>
				{sessions?.sessions.map(s => (
					<div key={s.id} className="flex items-center gap-3">
						<Laptop className="size-4 shrink-0 text-muted" />
						<div className="min-w-0 flex-1">
							<div className="truncate text-sm">
								{deviceOf(s.label)}
								{s.current && <span className="ml-2 text-xs text-success">This device</span>}
							</div>
							<div className="text-xs text-muted">
								Active {ago(s.lastSeenAt)} · signed in {ago(s.createdAt)}
							</div>
						</div>
						{!s.current && (
							<IconButton
								label="Sign out this device"
								onPress={async () => {
									await api(`/auth/sessions/${s.id}`, { method: 'DELETE' }).catch(err => toast.error(err.message))
									void reloadSessions()
								}}
							>
								<LogOut className="size-4" />
							</IconButton>
						)}
					</div>
				))}
			</div>

			<Modal.Backdrop isOpen={totpOpen} onOpenChange={setTotpOpen}>
				<Modal.Container size="sm">
					<Modal.Dialog>
						<Modal.CloseTrigger />
						<Modal.Header>
							<Modal.Heading>Set up an authenticator app</Modal.Heading>
						</Modal.Header>
						<Modal.Body>
							{totpOpen && (
								<TotpSetup
									onDone={recoveryCodes => {
										setTotpOpen(false)
										if (recoveryCodes) setCodes(recoveryCodes)
										toast.success('Authenticator app is on')
										void mutate()
									}}
								/>
							)}
						</Modal.Body>
					</Modal.Dialog>
				</Modal.Container>
			</Modal.Backdrop>

			<Modal.Backdrop isOpen={!!codes} onOpenChange={open => !open && setCodes(null)} isDismissable={false}>
				<Modal.Container size="sm">
					<Modal.Dialog>
						<Modal.Header>
							<Modal.Heading>Your recovery codes</Modal.Heading>
						</Modal.Header>
						<Modal.Body>
							{codes && <RecoveryCodes codes={codes} onDone={() => setCodes(null)} doneLabel="Done" />}
						</Modal.Body>
					</Modal.Dialog>
				</Modal.Container>
			</Modal.Backdrop>

			<Modal.Backdrop isOpen={!!rename} onOpenChange={open => !open && setRename(null)}>
				<Modal.Container size="sm">
					<Modal.Dialog>
						<Modal.CloseTrigger />
						<Modal.Header>
							<Modal.Heading>Rename passkey</Modal.Heading>
						</Modal.Header>
						<Modal.Body>
							<TextField
								value={rename?.name ?? ''}
								onChange={v => setRename(r => (r ? { ...r, name: v } : r))}
								autoFocus
							>
								<Label>Name</Label>
								<Input placeholder="MacBook Touch ID" />
							</TextField>
						</Modal.Body>
						<Modal.Footer>
							<Button slot="close" variant="secondary">
								Cancel
							</Button>
							<Button
								onPress={() => {
									const r = rename
									setRename(null)
									if (r)
										void run(
											() =>
												api(`/auth/passkeys/${encodeURIComponent(r.id)}`, { method: 'PATCH', body: { name: r.name } }),
											'Renamed',
										)
								}}
							>
								Save
							</Button>
						</Modal.Footer>
					</Modal.Dialog>
				</Modal.Container>
			</Modal.Backdrop>
		</Section>
	)
}
