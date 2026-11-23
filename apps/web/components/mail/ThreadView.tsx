'use client'

import type { Folder, Message, Thread } from '@mailroom/shared'
import { Button, Dropdown, Header, Label, Modal, Separator } from '@heroui/react'
import { format } from 'date-fns'
import {
	Archive,
	ArrowLeft,
	Clock,
	Download,
	FolderInput,
	Forward,
	ImageOff,
	Inbox,
	MailOpen,
	MoreHorizontal,
	Paperclip,
	Reply,
	ReplyAll,
	ShieldAlert,
	ShieldCheck,
	Star,
	Trash2,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import useSWR from 'swr'
import { useCompose } from '@/components/compose/context'
import { EmptyState, IconButton, Loading, PersonAvatar } from '@/components/ui'
import { REMOVES, replyDraft, snoozeOptions, type ThreadAction, threadAction, whoLine } from '@/lib/actions'
import { fetcher, useBootstrap, useMe } from '@/lib/api'
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

	// Opening a thread marks it read
	useEffect(() => {
		if (!data || data.messages.every(m => m.seen)) return
		const timer = setTimeout(() => void threadAction([threadId], 'read'), 600)
		return () => clearTimeout(timer)
	}, [data?.threadId])

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
				<div className="mx-auto max-w-4xl px-4 py-5 sm:px-6">
					<h1 className="mb-4 text-xl font-semibold leading-snug text-foreground">{data.subject || '(no subject)'}</h1>
					<div className="flex flex-col gap-2">
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
							/>
						))}
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
}: {
	message: Message
	expanded: boolean
	onToggle: () => void
	me: Set<string>
	showImagesByDefault: boolean
	onReply: (kind: 'reply' | 'replyAll' | 'forward') => void
}) {
	const [allowImages, setAllowImages] = useState(showImagesByDefault)
	const unsubscribe = m.listUnsubscribe?.match(/<(https:[^>]+)>/)?.[1]
	const files = m.attachments.filter(
		a => !(a.inline && a.cid && m.html?.includes(`/attachments/${encodeURIComponent(a.partId)}`)),
	)

	if (!expanded)
		return (
			<button
				type="button"
				onClick={onToggle}
				className="flex w-full items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3 text-left hover:bg-surface-secondary"
			>
				<PersonAvatar who={m.from} size={28} />
				<span className={`w-40 shrink-0 truncate text-sm ${m.seen ? '' : 'font-semibold'}`}>{displayName(m.from)}</span>
				<span className="min-w-0 flex-1 truncate text-sm text-muted">{m.snippet}</span>
				<span className="shrink-0 text-xs text-muted">{listDate(m.date)}</span>
			</button>
		)

	return (
		<article className="overflow-hidden rounded-xl border border-border bg-surface">
			<header className="flex items-start gap-3 px-4 pt-4 pb-3">
				<PersonAvatar who={m.from} />
				<button type="button" className="min-w-0 flex-1 text-left" onClick={onToggle}>
					<div className="flex flex-wrap items-baseline gap-x-2">
						<span className="font-semibold text-foreground">{displayName(m.from)}</span>
						<span className="truncate text-xs text-muted">&lt;{m.from.address}&gt;</span>
					</div>
					<div className="truncate text-xs text-muted">
						to {whoLine(m.to, me) || 'undisclosed recipients'}
						{m.cc.length > 0 && `, cc ${whoLine(m.cc, me)}`}
					</div>
				</button>
				<div className="flex shrink-0 items-center gap-1">
					<span className="mr-1 hidden text-xs text-muted sm:inline" title={fullDate(m.date)}>
						{format(new Date(m.date), 'MMM d, HH:mm')}
					</span>
					<IconButton label="Reply" onPress={() => onReply('reply')}>
						<Reply className="size-4" />
					</IconButton>
					<Dropdown>
						<Button isIconOnly variant="ghost" size="sm" aria-label="More">
							<MoreHorizontal className="size-4" />
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
			</header>

			{m.hasRemoteImages && !allowImages && (
				<div className="mx-4 mb-3 flex items-center gap-2 rounded-lg bg-surface-secondary px-3 py-2 text-xs text-muted">
					<ImageOff className="size-3.5 shrink-0" />
					<span className="flex-1">Remote images are hidden, so the sender can't tell you opened this.</span>
					<button type="button" className="font-medium text-accent" onClick={() => setAllowImages(true)}>
						Show images
					</button>
				</div>
			)}

			<div className="px-4 pb-4">
				{m.html ? (
					<EmailFrame html={m.html} allowImages={allowImages} />
				) : (
					<p className="text-sm text-muted">(empty message)</p>
				)}
			</div>

			{files.length > 0 && (
				<div className="flex flex-wrap gap-2 border-t border-separator px-4 py-3">
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
				<div className="border-t border-separator px-4 py-2 text-right">
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
