'use client'

import type { Draft, OutboxItem } from '@mailroom/shared'
import { Button, Chip } from '@heroui/react'
import { format } from 'date-fns'
import { AlertTriangle, FileText, Send } from 'lucide-react'
import { toast } from 'sonner'
import useSWR, { mutate } from 'swr'
import { draftFromPayload, newDraftId, useCompose } from '@/components/compose/context'
import { EmptyState, Loading } from '@/components/ui'
import { api, fetcher, refreshBootstrap, useBootstrap } from '@/lib/api'
import { displayName } from '@/lib/format'

/** Scheduled and failed sends: send now, edit (back into the composer) or cancel. */
export function OutboxList() {
	const { data, isLoading } = useSWR<{ items: OutboxItem[] }>('/outbox?status=queued,failed', fetcher, {
		refreshInterval: 30_000,
	})
	const { data: boot } = useBootstrap()
	const { open } = useCompose()
	const addressOf = (id: string) => boot?.projects.flatMap(p => p.mailboxes).find(m => m.id === id)?.address ?? ''

	const refresh = () => {
		void mutate('/outbox?status=queued,failed')
		void refreshBootstrap()
	}
	const cancel = async (item: OutboxItem, edit: boolean) => {
		try {
			await api(`/outbox/${item.id}/cancel`, { method: 'POST' })
			if (edit) {
				open({
					...draftFromPayload(newDraftId(), item.payload),
					title: 'Edit scheduled message',
					includeSignature: false,
				})
			} else toast('Cancelled')
		} catch (err) {
			toast.error((err as Error).message)
		}
		refresh()
	}
	const sendNow = async (item: OutboxItem) => {
		try {
			await api(`/outbox/${item.id}`, { method: 'PATCH', body: { sendAt: 'now' } })
			toast('Sending now')
		} catch (err) {
			toast.error((err as Error).message)
		}
		refresh()
	}

	if (isLoading) return <Loading />
	const items = (data?.items ?? []).filter(
		i => i.status === 'failed' || new Date(i.sendAt).getTime() > Date.now() + 5000,
	)
	if (!items.length)
		return (
			<EmptyState icon={<Send />} title="Nothing scheduled">
				Use the arrow next to Send to pick a time.
			</EmptyState>
		)

	return (
		<ul>
			{items.map(item => (
				<li key={item.id} className="flex flex-col gap-2 border-b border-separator px-4 py-3">
					<div className="flex items-center gap-2">
						<span className="min-w-0 flex-1 truncate text-sm font-medium">
							To {item.payload.to.map(displayName).join(', ') || item.payload.cc.map(displayName).join(', ')}
						</span>
						{item.status === 'failed' ? (
							<Chip size="sm" color="danger" variant="soft">
								<AlertTriangle className="size-3" /> Failed
							</Chip>
						) : (
							<Chip size="sm" color="accent" variant="soft">
								{format(new Date(item.sendAt), "EEE, MMM d 'at' HH:mm")}
							</Chip>
						)}
					</div>
					<div className="truncate text-sm text-foreground/80">{item.payload.subject || '(no subject)'}</div>
					<div className="text-xs text-muted">From {addressOf(item.mailboxId)}</div>
					{item.error && <div className="rounded-lg bg-danger-soft px-2 py-1 text-xs text-danger">{item.error}</div>}
					<div className="flex gap-2">
						<Button size="sm" variant="secondary" onPress={() => void sendNow(item)}>
							{item.status === 'failed' ? 'Retry now' : 'Send now'}
						</Button>
						<Button size="sm" variant="ghost" onPress={() => void cancel(item, true)}>
							Edit
						</Button>
						<Button size="sm" variant="ghost" onPress={() => void cancel(item, false)}>
							Cancel
						</Button>
					</div>
				</li>
			))}
		</ul>
	)
}

export function DraftsList() {
	const { data, isLoading } = useSWR<{ drafts: Draft[] }>('/drafts', fetcher)
	const { open } = useCompose()
	if (isLoading) return <Loading />
	if (!data?.drafts.length)
		return (
			<EmptyState icon={<FileText />} title="No drafts">
				Messages you start writing are saved here automatically.
			</EmptyState>
		)
	return (
		<ul>
			{data.drafts.map(d => (
				<li key={d.id}>
					<button
						type="button"
						className="flex w-full flex-col gap-0.5 border-b border-separator px-4 py-3 text-left hover:bg-default/50"
						onClick={() => open(draftFromPayload(d.id, d.payload))}
					>
						<span className="flex items-baseline gap-2">
							<span className="min-w-0 flex-1 truncate text-sm text-danger">
								Draft
								{d.payload.to?.length ? (
									<span className="text-foreground/80"> to {d.payload.to.map(displayName).join(', ')}</span>
								) : null}
							</span>
							<span className="text-xs text-muted">{format(new Date(d.updatedAt), 'MMM d, HH:mm')}</span>
						</span>
						<span className="truncate text-sm">{d.payload.subject || '(no subject)'}</span>
						<span className="truncate text-xs text-muted">
							{(d.payload.html ?? '')
								.replace(/<[^>]+>/g, ' ')
								.replace(/\s+/g, ' ')
								.slice(0, 140)}
						</span>
					</button>
				</li>
			))}
		</ul>
	)
}
