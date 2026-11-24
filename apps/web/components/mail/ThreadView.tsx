'use client'

import { type Folder, formatAddress, type Message, type OutboxItem, type Thread } from '@mailroom/shared'
import { Button, Dropdown, Header, Label, Modal, Separator, Spinner } from '@heroui/react'
import { format } from 'date-fns'
import {
	AlertTriangle,
	Archive,
	ArrowLeft,
	Check,
	Clock,
	Download,
	FolderInput,
	Forward,
	ImageOff,
	Inbox,
	MailOpen,
	ChevronDown,
	MoreVertical,
	Paperclip,
	Reply,
	ReplyAll,
	RotateCcw,
	ShieldAlert,
	ShieldCheck,
	Star,
	Trash2,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import useSWR from 'swr'
import { draftFromPayload, newDraftId, useCompose } from '@/components/compose/context'
import { EmptyState, IconButton, Loading, PersonAvatar } from '@/components/ui'
import { REMOVES, replyDraft, snoozeOptions, type ThreadAction, threadAction, whoLine } from '@/lib/actions'
import { api, fetcher, useBootstrap, useMe } from '@/lib/api'
import { displayName, fileSize, fullDate, listDate } from '@/lib/format'
import { EmailFrame } from './EmailFrame'

export function ThreadView({
	threadId,
	onClose,
	onRemoved,
}: {
	threadId: string
	onClose: () => void
	onRemoved: () => void
}) {
	const { data, error, isLoading } = useSWR<Thread>(`/threads/${threadId}`, fetcher)
	const { data: boot } = useBootstrap()
	const { data: me } = useMe()
	const { open } = useCompose()
	const [expanded, setExpanded] = useState<Set<string>>(new Set())
	const [customSnooze, setCustomSnooze] = useState(false)
	const [snoozeAt, setSnoozeAt] = useState('')

	const myAddresses = useMemo(() => new Set(boot?.projects.flatMap(p => p.mailboxes.map(m => m.address)) ?? []), [boot])
	const folders = boot?.folders ?? []
	const folderOf = (id: string) => folders.find(f => f.id === id)
	const messages = data?.messages ?? []
	const last = messages[messages.length - 1]
	const inTrash =
		messages.length > 0 && messages.every(m => ['trash', 'junk'].includes(folderOf(m.folderId)?.specialUse ?? ''))
	const inJunk = messages.some(m => folderOf(m.folderId)?.specialUse === 'junk')
	const inInbox = messages.some(m => folderOf(m.folderId)?.specialUse === 'inbox')
	const starred = messages.some(m => m.flagged)
	const snoozed = messages.some(m => m.snoozedUntil && new Date(m.snoozedUntil) > new Date())
	const mailboxFolders = folders.filter(
		f => f.mailboxId === data?.mailboxId && !['flagged', 'all'].includes(f.specialUse ?? ''),
	)

	// Newest and unread messages open; read history collapses
	useEffect(() => {
		if (!data) return
		const open = new Set<string>()
		data.messages.forEach((m, i) => {
			if (!m.seen || i === data.messages.length - 1) open.add(m.id)
		})
		setExpanded(open)
	}, [data?.threadId, data?.messages.length])

	// Opening a thread marks it read, once per opening: also when a refetch shows it unread after it first
	// came from cache, but not again after "Mark unread"
	const hasUnread = !!data?.messages.some(m => !m.seen)
	const markedRead = useRef<string | null>(null)
	useEffect(() => {
		if (!data || !hasUnread || markedRead.current === data.threadId) return
		const id = data.threadId
		const timer = setTimeout(() => {
			markedRead.current = id
			void threadAction([id], 'read')
		}, 600)
		return () => clearTimeout(timer)
	}, [data?.threadId, hasUnread])

	const act = async (action: ThreadAction, extra?: { folderId?: string; until?: Date }) => {
		if (REMOVES.includes(action)) onRemoved()
		await threadAction([threadId], action, extra)
	}

	const reply = (kind: 'reply' | 'replyAll' | 'forward', m = last) => {
		if (m) open(replyDraft(kind, m, myAddresses))
	}

	// r / a / f / e / # / s / shift+u while a thread is open
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const t = e.target as HTMLElement
			if (t.closest('input, textarea, [contenteditable="true"], [role="dialog"]') || e.metaKey || e.ctrlKey || e.altKey)
				return
			if (e.key === 'r') reply('reply')
			else if (e.key === 'a') reply('replyAll')
			else if (e.key === 'f') reply('forward')
			else if (e.key === 'e') void act(inInbox ? 'archive' : 'inbox')
			else if (e.key === '#') void act(inTrash ? 'delete' : 'trash')
			else if (e.key === 's') void act(starred ? 'unstar' : 'star')
			else if (e.key === 'U') void act('unread')
			else return
			e.preventDefault()
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	})

	if (isLoading) return <Loading />
	if (error || !data) return <EmptyState icon={<Inbox />} title="This conversation is gone" />

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex h-14 shrink-0 items-center gap-0.5 border-b border-separator px-3">
				<IconButton label="Back" onPress={onClose} className="xl:hidden">
					<ArrowLeft className="size-4" />
				</IconButton>
				{inInbox ? (
					<IconButton label="Archive (e)" onPress={() => void act('archive')}>
						<Archive className="size-4" />
					</IconButton>
				) : (
					<IconButton label="Move to Inbox" onPress={() => void act('inbox')}>
						<Inbox className="size-4" />
					</IconButton>
				)}
				{inJunk ? (
					<IconButton label="Not spam" onPress={() => void act('notspam')}>
						<ShieldCheck className="size-4" />
					</IconButton>
				) : (
					<IconButton label="Spam" onPress={() => void act('spam')}>
						<ShieldAlert className="size-4" />
					</IconButton>
				)}
				<IconButton
					label={inTrash ? 'Delete forever (#)' : 'Delete (#)'}
					onPress={() => void act(inTrash ? 'delete' : 'trash')}
				>
					<Trash2 className="size-4" />
				</IconButton>
				<span className="mx-1 h-5 w-px bg-separator" />
				<IconButton label="Mark unread (Shift+U)" onPress={() => void act('unread').then(onClose)}>
					<MailOpen className="size-4" />
				</IconButton>
				<Dropdown>
					<Button isIconOnly variant="ghost" size="sm" aria-label="Snooze">
						<Clock className="size-4" />
					</Button>
					<Dropdown.Popover>
						<Dropdown.Menu
							onAction={key => {
								if (key === 'custom') {
									setSnoozeAt(format(new Date(Date.now() + 86400_000), "yyyy-MM-dd'T'08:00"))
									setCustomSnooze(true)
								} else if (key === 'unsnooze') void act('unsnooze')
								else {
									const o = snoozeOptions().find(x => x.id === key)
									if (o) void act('snooze', { until: o.date })
								}
							}}
						>
							<Dropdown.Section>
								<Header>Snooze until</Header>
								{snoozeOptions().map(o => (
									<Dropdown.Item key={o.id} id={o.id} textValue={o.label}>
										<Label>{o.label}</Label>
										<span className="ml-auto pl-4 text-xs text-muted">{format(o.date, 'EEE HH:mm')}</span>
									</Dropdown.Item>
								))}
							</Dropdown.Section>
							<Separator />
							<Dropdown.Item id="custom" textValue="Pick date and time">
								<Label>Pick date and time...</Label>
							</Dropdown.Item>
							{snoozed ? (
								<Dropdown.Item id="unsnooze" textValue="Unsnooze">
									<Label>Unsnooze</Label>
								</Dropdown.Item>
							) : null}
						</Dropdown.Menu>
					</Dropdown.Popover>
				</Dropdown>
				<Dropdown>
					<Button isIconOnly variant="ghost" size="sm" aria-label="Move to folder">
						<FolderInput className="size-4" />
					</Button>
					<Dropdown.Popover>
						<Dropdown.Menu onAction={key => void act('move', { folderId: String(key) })}>
							<Dropdown.Section>
								<Header>Move to</Header>
								{mailboxFolders.map((f: Folder) => (
									<Dropdown.Item key={f.id} id={f.id} textValue={f.path}>
										<Label>{f.path}</Label>
									</Dropdown.Item>
								))}
							</Dropdown.Section>
						</Dropdown.Menu>
					</Dropdown.Popover>
				</Dropdown>
				<span className="flex-1" />
				<IconButton label={starred ? 'Unstar (s)' : 'Star (s)'} onPress={() => void act(starred ? 'unstar' : 'star')}>
					<Star className={`size-4 ${starred ? 'fill-warning text-warning' : ''}`} />
				</IconButton>
			</div>

			<div className="pane-scroll min-h-0 flex-1">
				<div className="px-4 py-5 sm:px-6">
					<h1 className="mb-2 text-xl font-semibold leading-snug text-foreground">{data.subject || '(no subject)'}</h1>
					<div className="flex flex-col divide-y divide-separator">
						{messages.map(m => (
							<MessageCard
								key={m.id}
								message={m}
								expanded={expanded.has(m.id)}
								onToggle={() =>
									setExpanded(s => {
										const n = new Set(s)
										n.has(m.id) ? n.delete(m.id) : n.add(m.id)
										return n
									})
								}
								me={myAddresses}
								showImagesByDefault={me?.user.settings.showImages ?? false}
								onReply={k => reply(k, m)}
								starred={starred}
								onStar={() => void act(starred ? 'unstar' : 'star')}
							/>
						))}
						<PendingReplies threadId={data.threadId} messages={messages} me={myAddresses} />
					</div>
					<div className="mt-4 flex flex-wrap gap-2 pb-24">
						<Button variant="secondary" onPress={() => reply('reply')}>
							<Reply className="size-4" /> Reply
						</Button>
						<Button variant="secondary" onPress={() => reply('replyAll')}>
							<ReplyAll className="size-4" /> Reply all
						</Button>
						<Button variant="secondary" onPress={() => reply('forward')}>
							<Forward className="size-4" /> Forward
						</Button>
					</div>
				</div>
			</div>

			<Modal.Backdrop isOpen={customSnooze} onOpenChange={setCustomSnooze}>
				<Modal.Container size="sm">
					<Modal.Dialog>
						<Modal.CloseTrigger />
						<Modal.Header>
							<Modal.Heading>Snooze until</Modal.Heading>
						</Modal.Header>
						<Modal.Body>
							<input
								type="datetime-local"
								value={snoozeAt}
								min={format(new Date(), "yyyy-MM-dd'T'HH:mm")}
								onChange={e => setSnoozeAt(e.target.value)}
								className="w-full rounded-xl border border-border bg-field px-3 py-2 text-sm text-foreground"
							/>
						</Modal.Body>
						<Modal.Footer>
							<Button slot="close" variant="secondary">
								Cancel
							</Button>
							<Button
								onPress={() => {
									const d = new Date(snoozeAt)
									if (Number.isNaN(d.getTime()) || d.getTime() < Date.now() + 60_000)
										return toast.error('Pick a time in the future')
									setCustomSnooze(false)
									void act('snooze', { until: d })
								}}
							>
								Snooze
							</Button>
						</Modal.Footer>
					</Modal.Dialog>
				</Modal.Container>
			</Modal.Backdrop>
		</div>
	)
}

function MessageCard({
	message: m,
	expanded,
	onToggle,
	me,
	showImagesByDefault,
	onReply,
	starred,
	onStar,
}: {
	message: Message
	expanded: boolean
	onToggle: () => void
	me: Set<string>
	showImagesByDefault: boolean
	onReply: (kind: 'reply' | 'replyAll' | 'forward') => void
	starred: boolean
	onStar: () => void
}) {
	const [allowImages, setAllowImages] = useState(showImagesByDefault)
	const [details, setDetails] = useState(false)
	const unsubscribe = m.listUnsubscribe?.match(/<(https:[^>]+)>/)?.[1]
	const files = m.attachments.filter(
		a => !(a.inline && a.cid && m.html?.includes(`/attachments/${encodeURIComponent(a.partId)}`)),
	)
	const date = new Date(m.date)
	const when = format(
		date,
		date.getFullYear() === new Date().getFullYear() ? 'EEE, MMM d, HH:mm' : 'MMM d, yyyy, HH:mm',
	)

	if (!expanded)
		return (
			<button
				type="button"
				onClick={onToggle}
				className="-mx-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-lg px-2 py-3 text-left transition-colors hover:bg-default/50"
			>
				<PersonAvatar who={m.from} size={32} />
				<span
					className={`w-44 shrink-0 truncate text-sm ${m.seen ? 'text-foreground' : 'font-semibold text-foreground'}`}
				>
					{me.has(m.from.address) ? 'You' : displayName(m.from)}
				</span>
				<span className="min-w-0 flex-1 truncate text-sm text-muted">{m.snippet}</span>
				<span className="shrink-0 text-xs text-muted">{listDate(m.date)}</span>
			</button>
		)

	return (
		<article className="py-5">
			<header className="flex items-start gap-3">
				<PersonAvatar who={m.from} size={40} />
				<div className="min-w-0 flex-1">
					<button type="button" className="block max-w-full text-left" onClick={onToggle}>
						<div className="truncate text-sm font-medium text-foreground">
							{me.has(m.from.address) ? 'You' : displayName(m.from)}
						</div>
						<div className="truncate text-xs text-muted">{m.from.address}</div>
					</button>
					<button
						type="button"
						onClick={() => setDetails(v => !v)}
						aria-expanded={details}
						className="inline-flex max-w-full items-center gap-0.5 text-xs text-muted hover:text-foreground"
					>
						<span className="truncate">
							to {whoLine(m.to, me) || 'undisclosed recipients'}
							{m.cc.length > 0 && `, cc ${whoLine(m.cc, me)}`}
						</span>
						<ChevronDown className={`size-3 shrink-0 transition-transform ${details ? 'rotate-180' : ''}`} />
					</button>
					{details && (
						<dl className="mt-2 grid max-w-xl grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg border border-separator bg-surface px-3 py-2 text-xs">
							<dt className="text-muted">From</dt>
							<dd className="min-w-0 break-words">{formatAddress(m.from)}</dd>
							{m.replyTo.length > 0 && (
								<>
									<dt className="text-muted">Reply to</dt>
									<dd className="min-w-0 break-words">{m.replyTo.map(formatAddress).join(', ')}</dd>
								</>
							)}
							<dt className="text-muted">To</dt>
							<dd className="min-w-0 break-words">{m.to.map(formatAddress).join(', ') || 'undisclosed recipients'}</dd>
							{m.cc.length > 0 && (
								<>
									<dt className="text-muted">Cc</dt>
									<dd className="min-w-0 break-words">{m.cc.map(formatAddress).join(', ')}</dd>
								</>
							)}
							<dt className="text-muted">Date</dt>
							<dd>{fullDate(m.date)}</dd>
							<dt className="text-muted">Subject</dt>
							<dd className="min-w-0 break-words">{m.subject || '(no subject)'}</dd>
						</dl>
					)}
				</div>
				<div className="flex shrink-0 flex-col items-end gap-1">
					<span className="text-xs text-muted" title={fullDate(m.date)}>
						{when}
					</span>
					<div className="flex items-center">
						<IconButton label="Reply" onPress={() => onReply('reply')}>
							<Reply className="size-4" />
						</IconButton>
						<IconButton label={starred ? 'Unstar' : 'Star'} onPress={onStar}>
							<Star className={`size-4 ${starred ? 'fill-warning text-warning' : ''}`} />
						</IconButton>
						<Dropdown>
							<Button isIconOnly variant="ghost" size="sm" aria-label="More">
								<MoreVertical className="size-4" />
							</Button>
							<Dropdown.Popover placement="bottom end">
								<Dropdown.Menu
									onAction={key => {
										if (key === 'raw') window.open(`/api/messages/${m.id}/raw`, '_blank')
										else onReply(key as 'reply' | 'replyAll' | 'forward')
									}}
								>
									<Dropdown.Item id="reply" textValue="Reply">
										<Reply className="size-4 text-muted" />
										<Label>Reply</Label>
									</Dropdown.Item>
									<Dropdown.Item id="replyAll" textValue="Reply all">
										<ReplyAll className="size-4 text-muted" />
										<Label>Reply all</Label>
									</Dropdown.Item>
									<Dropdown.Item id="forward" textValue="Forward">
										<Forward className="size-4 text-muted" />
										<Label>Forward</Label>
									</Dropdown.Item>
									<Separator />
									<Dropdown.Item id="raw" textValue="Download original">
										<Download className="size-4 text-muted" />
										<Label>Download original (.eml)</Label>
									</Dropdown.Item>
								</Dropdown.Menu>
							</Dropdown.Popover>
						</Dropdown>
					</div>
				</div>
			</header>

			{m.hasRemoteImages && !allowImages && (
				<div className="mt-4 flex items-center gap-2 rounded-lg bg-surface-secondary px-3 py-2 text-xs text-muted">
					<ImageOff className="size-3.5 shrink-0" />
					<span className="flex-1">Remote images are hidden, so the sender can't tell you opened this.</span>
					<button type="button" className="font-medium text-accent" onClick={() => setAllowImages(true)}>
						Show images
					</button>
				</div>
			)}

			<div className="mt-4">
				{m.html ? (
					<EmailFrame html={m.html} allowImages={allowImages} />
				) : (
					<p className="text-sm text-muted">(empty message)</p>
				)}
			</div>

			{files.length > 0 && (
				<div className="mt-4 flex flex-wrap gap-2">
					{files.map(a => (
						<a
							key={a.partId}
							href={`/api/messages/${m.id}/attachments/${encodeURIComponent(a.partId)}`}
							className="group flex max-w-[260px] items-center gap-2 rounded-lg border border-border bg-surface-secondary px-3 py-2 text-xs hover:border-accent"
							download={a.filename}
						>
							<Paperclip className="size-3.5 shrink-0 text-muted" />
							<span className="truncate text-foreground">{a.filename}</span>
							<span className="shrink-0 text-muted">{fileSize(a.size)}</span>
							<Download className="size-3.5 shrink-0 text-muted opacity-0 group-hover:opacity-100" />
						</a>
					))}
				</div>
			)}

			{unsubscribe && (
				<div className="mt-3">
					<a
						href={unsubscribe}
						target="_blank"
						rel="noopener noreferrer"
						className="text-xs text-muted hover:text-foreground"
					>
						Unsubscribe
					</a>
				</div>
			)}
		</article>
	)
}

// --- Replies on their way -------------------------------------------------------------------------

const SENT_GRACE_MS = 10 * 60_000

/**
 * Replies to this thread that are not in it yet, shown at once with their state: waiting out the undo
 * window, sending, sent (until the copy in Sent syncs in and takes its place), or failed.
 */
function PendingReplies({ threadId, messages, me }: { threadId: string; messages: Message[]; me: Set<string> }) {
	const { open } = useCompose()
	const { data: boot } = useBootstrap()
	const [now, setNow] = useState(() => Date.now())
	const known = new Set(messages.map(m => m.messageId).filter(Boolean))
	const { data, mutate } = useSWR<{ items: OutboxItem[] }>(`/outbox?thread=${threadId}`, fetcher, {
		// Outbox events refresh it too; polling covers the copy in Sent arriving a bit later
		refreshInterval: d => (d?.items.some(i => i.status !== 'failed') ? 3000 : 0),
	})
	const items = (data?.items ?? []).filter(
		i =>
			!(i.messageId && known.has(i.messageId)) &&
			!(i.status === 'sent' && i.sentAt && now - new Date(i.sentAt).getTime() > SENT_GRACE_MS),
	)
	const waiting = items.some(i => i.status === 'queued')
	useEffect(() => {
		if (!waiting) return
		const timer = setInterval(() => setNow(Date.now()), 1000)
		return () => clearInterval(timer)
	}, [waiting])
	if (!items.length) return null

	const reopen = async (item: OutboxItem) => {
		try {
			await api(`/outbox/${item.id}/cancel`, { method: 'POST' })
			open(draftFromPayload(newDraftId(), item.payload))
		} catch (err) {
			toast.error((err as Error).message)
		}
		void mutate()
	}
	const retry = async (item: OutboxItem) => {
		try {
			await api(`/outbox/${item.id}`, { method: 'PATCH', body: { sendAt: 'now' } })
		} catch (err) {
			toast.error((err as Error).message)
		}
		void mutate()
	}

	return (
		<>
			{items.map(item => {
				const address = boot?.projects.flatMap(p => p.mailboxes).find(m => m.id === item.mailboxId)?.address ?? ''
				const secondsLeft = Math.ceil((new Date(item.sendAt).getTime() - now) / 1000)
				const scheduled = item.status === 'queued' && secondsLeft > 60
				const html =
					item.payload.html ||
					(item.payload.text
						? `<div style="white-space:pre-wrap">${item.payload.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>`
						: '')
				return (
					<article key={item.id} className="py-5" aria-busy={item.status === 'queued' || item.status === 'sending'}>
						<header className="flex items-start gap-3">
							<PersonAvatar who={{ name: '', address }} size={40} />
							<div className="min-w-0 flex-1">
								<div className="text-sm font-medium text-foreground">You</div>
								<div className="truncate text-xs text-muted">{address}</div>
								<div className="truncate text-xs text-muted">
									to {whoLine(item.payload.to, me) || 'undisclosed recipients'}
								</div>
							</div>
							<div className="flex shrink-0 items-center gap-2 text-xs">
								{item.status === 'failed' ? (
									<>
										<span className="inline-flex items-center gap-1 font-medium text-danger">
											<AlertTriangle className="size-3.5" /> Not sent
										</span>
										<Button size="sm" variant="secondary" onPress={() => void retry(item)}>
											<RotateCcw className="size-3.5" /> Retry
										</Button>
										<Button size="sm" variant="ghost" onPress={() => void reopen(item)}>
											Edit
										</Button>
									</>
								) : item.status === 'sent' ? (
									<span className="inline-flex items-center gap-1 text-success">
										<Check className="size-3.5" /> Sent
									</span>
								) : scheduled ? (
									<>
										<span className="inline-flex items-center gap-1 text-muted">
											<Clock className="size-3.5" /> Scheduled for{' '}
											{format(new Date(item.sendAt), "EEE, MMM d 'at' HH:mm")}
										</span>
										<Button size="sm" variant="ghost" onPress={() => void reopen(item)}>
											Cancel
										</Button>
									</>
								) : (
									<>
										<span className="inline-flex items-center gap-1.5 text-muted">
											<Spinner size="sm" />
											{item.status === 'queued' && secondsLeft > 0 ? `Sending in ${secondsLeft}s` : 'Sending'}
										</span>
										{item.status === 'queued' && secondsLeft > 0 && (
											<Button size="sm" variant="ghost" onPress={() => void reopen(item)}>
												Undo
											</Button>
										)}
									</>
								)}
							</div>
						</header>
						{item.error && item.status === 'failed' && (
							<div className="mt-3 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{item.error}</div>
						)}
						<div
							className={`mt-4 transition-opacity ${item.status === 'sent' || item.status === 'failed' ? '' : 'opacity-70'}`}
						>
							<EmailFrame html={html} allowImages />
						</div>
					</article>
				)
			})}
		</>
	)
}
