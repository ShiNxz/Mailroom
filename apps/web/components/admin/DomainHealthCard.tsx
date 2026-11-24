'use client'

import type { CheckStatus, Domain, HealthCheck } from '@mailroom/shared'
import { Button, Card, Chip, Input, Label, TextField } from '@heroui/react'
import { formatDistanceToNow } from 'date-fns'
import { AlertTriangle, CheckCircle2, ChevronDown, Copy, Info, RefreshCw, Trash2, XCircle } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { IconButton } from '@/components/ui'
import { api, refreshBootstrap } from '@/lib/api'
import { copyText } from '@/lib/clipboard'

const ICON: Record<CheckStatus, React.ReactNode> = {
	pass: <CheckCircle2 className="size-4 text-success" />,
	warn: <AlertTriangle className="size-4 text-warning" />,
	fail: <XCircle className="size-4 text-danger" />,
	info: <Info className="size-4 text-muted" />,
}

function scoreColor(score: number) {
	if (score >= 85) return 'var(--success)'
	if (score >= 60) return 'var(--warning)'
	return 'var(--danger)'
}

function ScoreRing({ score }: { score: number }) {
	const r = 26
	const c = 2 * Math.PI * r
	return (
		<div className="relative size-16 shrink-0">
			<svg viewBox="0 0 64 64" className="size-16 -rotate-90">
				<circle cx="32" cy="32" r={r} fill="none" stroke="var(--border)" strokeWidth="6" />
				<circle
					cx="32"
					cy="32"
					r={r}
					fill="none"
					stroke={scoreColor(score)}
					strokeWidth="6"
					strokeLinecap="round"
					strokeDasharray={c}
					strokeDashoffset={c * (1 - score / 100)}
				/>
			</svg>
			<span className="absolute inset-0 flex items-center justify-center text-lg font-semibold tabular-nums">
				{score}
			</span>
		</div>
	)
}

const copy = async (text: string) => {
	if (await copyText(text)) toast('Copied')
	else toast.error("Couldn't copy. Select the text and copy it instead.")
}

function CheckRow({ check }: { check: HealthCheck }) {
	const [open, setOpen] = useState(check.status === 'fail' || check.status === 'warn')
	const hasMore = !!(check.records?.length || check.fix || check.detail)
	return (
		<li className="border-b border-separator last:border-0">
			<button
				type="button"
				className="flex w-full items-start gap-3 py-2.5 text-left"
				onClick={() => hasMore && setOpen(o => !o)}
			>
				<span className="pt-0.5">{ICON[check.status]}</span>
				<span className="min-w-0 flex-1">
					<span className="block text-sm font-medium text-foreground">{check.label}</span>
					<span className="block text-sm text-muted">{check.summary}</span>
				</span>
				{hasMore && (
					<ChevronDown className={`mt-1 size-4 shrink-0 text-muted transition-transform ${open ? 'rotate-180' : ''}`} />
				)}
			</button>
			{open && hasMore && (
				<div className="mb-3 ml-7 flex flex-col gap-2">
					{check.detail && <p className="text-sm text-muted">{check.detail}</p>}
					{check.records?.map(r => (
						<code
							key={r}
							className="block overflow-x-auto rounded-lg bg-surface-secondary px-3 py-2 font-mono text-xs text-foreground/80"
						>
							{r}
						</code>
					))}
					{check.fix && (
						<div className="rounded-xl border border-accent/30 bg-accent/5 p-3">
							<div className="mb-2 text-xs font-semibold uppercase tracking-wide text-accent">
								{check.status === 'info' ? 'Optional record' : 'Add this record'}
							</div>
							<div className="grid grid-cols-[70px_1fr_auto] items-center gap-x-3 gap-y-1.5 text-xs">
								<span className="text-muted">Type</span>
								<code className="font-mono">{check.fix.type}</code>
								<span />
								<span className="text-muted">Name</span>
								<code className="font-mono">{check.fix.host}</code>
								<IconButton label="Copy name" onPress={() => copy(check.fix!.host)}>
									<Copy className="size-3.5" />
								</IconButton>
								<span className="text-muted">Value</span>
								<code className="break-all font-mono">{check.fix.value}</code>
								<IconButton label="Copy value" onPress={() => copy(check.fix!.value)}>
									<Copy className="size-3.5" />
								</IconButton>
							</div>
							{check.fix.note && <p className="mt-2 text-xs text-muted">{check.fix.note}</p>}
						</div>
					)}
				</div>
			)}
		</li>
	)
}

export function DomainHealthCard({ domain, onChange }: { domain: Domain; onChange: () => void }) {
	const [checking, setChecking] = useState(false)
	const [selectors, setSelectors] = useState(domain.dkimSelectors.join(', '))
	const [editSelectors, setEditSelectors] = useState(false)
	const health = domain.health
	const problems = health?.checks.filter(c => c.status === 'fail' || c.status === 'warn').length ?? 0

	const recheck = async () => {
		setChecking(true)
		try {
			await api(`/admin/domains/${domain.id}/check`, { method: 'POST' })
			onChange()
		} catch (err) {
			toast.error((err as Error).message)
		} finally {
			setChecking(false)
		}
	}

	const saveSelectors = async () => {
		setChecking(true)
		try {
			await api(`/admin/domains/${domain.id}`, {
				method: 'PATCH',
				body: { dkimSelectors: selectors.split(/[\s,]+/).filter(Boolean) },
			})
			setEditSelectors(false)
			onChange()
		} catch (err) {
			toast.error((err as Error).message)
		} finally {
			setChecking(false)
		}
	}

	const remove = async () => {
		if (!window.confirm(`Remove ${domain.name} from this project? Mailboxes stay connected.`)) return
		await api(`/admin/domains/${domain.id}`, { method: 'DELETE' })
		onChange()
		void refreshBootstrap()
	}

	return (
		<Card>
			<Card.Header className="flex-row items-center gap-4">
				{health ? (
					<ScoreRing score={health.score} />
				) : (
					<div className="size-16 shrink-0 animate-pulse rounded-full bg-default" />
				)}
				<div className="min-w-0 flex-1">
					<Card.Title className="truncate text-lg">{domain.name}</Card.Title>
					<Card.Description>
						{health ? (
							<>
								{problems === 0
									? 'Everything important is set up.'
									: `${problems} thing${problems === 1 ? '' : 's'} to fix.`}
								{health.provider && <> Mail hosted by {health.provider}.</>}
								{domain.checkedAt && (
									<span className="block text-xs">Checked {formatDistanceToNow(new Date(domain.checkedAt))} ago</span>
								)}
							</>
						) : (
							'Not checked yet'
						)}
					</Card.Description>
				</div>
				<div className="flex shrink-0 gap-1">
					<Button size="sm" variant="secondary" onPress={() => void recheck()} isPending={checking}>
						<RefreshCw className="size-3.5" /> Check again
					</Button>
					<IconButton label="Remove domain" onPress={() => void remove()}>
						<Trash2 className="size-4" />
					</IconButton>
				</div>
			</Card.Header>
			{health && (
				<Card.Content>
					<ul>
						{health.checks.map(c => (
							<CheckRow key={c.id} check={c} />
						))}
					</ul>
					<div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted">
						<span>DKIM selectors checked besides the usual ones:</span>
						{domain.dkimSelectors.length ? (
							domain.dkimSelectors.map(s => (
								<Chip key={s} size="sm">
									{s}
								</Chip>
							))
						) : (
							<span>none</span>
						)}
						<button type="button" className="text-accent" onClick={() => setEditSelectors(e => !e)}>
							{editSelectors ? 'Cancel' : 'Edit'}
						</button>
					</div>
					{editSelectors && (
						<div className="mt-2 flex items-end gap-2">
							<TextField value={selectors} onChange={setSelectors} className="flex-1">
								<Label>Selectors (from your provider, e.g. "mail" for mail._domainkey)</Label>
								<Input placeholder="mail, s1" />
							</TextField>
							<Button size="sm" onPress={() => void saveSelectors()} isPending={checking}>
								Save and check
							</Button>
						</div>
					)}
				</Card.Content>
			)}
		</Card>
	)
}
