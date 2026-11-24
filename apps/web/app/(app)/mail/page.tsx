'use client'

import type { ThreadRow, View } from '@mailroom/shared'
import { SearchField } from '@heroui/react'
import { Archive, Inbox, MailOpen, RefreshCw, Search, Trash2, X } from 'lucide-react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import useSWRInfinite from 'swr/infinite'
import { DraftsList, OutboxList } from '@/components/mail/OutboxList'
import { ThreadList } from '@/components/mail/ThreadList'
import { ThreadView } from '@/components/mail/ThreadView'
import { EmptyState, IconButton, Loading, StatusDot } from '@/components/ui'
import { threadAction } from '@/lib/actions'
import { fetcher, refreshBootstrap, useBootstrap, useListRefresh } from '@/lib/api'
import { EnterOnChange } from '@/lib/motion'

const VIEW_TITLES: Record<string, string> = {
	inbox: 'Inbox',
	unread: 'Unread',
	starred: 'Starred',
	snoozed: 'Snoozed',
	scheduled: 'Scheduled',
	drafts: 'Drafts',
	sent: 'Sent',
	archive: 'Archive',
	junk: 'Spam',
	trash: 'Trash',
	all: 'All mail',
}

type Page = { threads: ThreadRow[]; next: string | null }

function MailPage() {
	const params = useSearchParams()
	const router = useRouter()
	const pathname = usePathname()
	const { data: boot } = useBootstrap()

	const view = (params.get('view') ?? 'inbox') as View
	const projectId = params.get('p')
	const mailboxId = params.get('m')
	const folderId = params.get('f')
	const threadId = params.get('t')
	const q = params.get('q') ?? ''
	const [search, setSearch] = useState(q)
	const [checked, setChecked] = useState<Set<string>>(new Set())
	const [hidden, setHidden] = useState<Set<string>>(new Set())
	const searchRef = useRef<HTMLInputElement>(null)

	useEffect(() => setSearch(q), [q])
	useEffect(() => {
		setChecked(new Set())
		setHidden(new Set())
	}, [view, projectId, mailboxId, folderId, q])

	const setParams = useCallback(
		(patch: Record<string, string | null>) => {
			const next = new URLSearchParams(params.toString())
			for (const [k, v] of Object.entries(patch)) {
				if (v === null || v === '') next.delete(k)
				else next.set(k, v)
			}
			router.replace(`${pathname}?${next.toString()}`, { scroll: false })
		},
		[params, pathname, router],
	)

	const special = view === 'scheduled' || view === 'drafts'
	const baseQuery = useMemo(() => {
		const s = new URLSearchParams()
		if (folderId) s.set('folderId', folderId)
		else s.set('view', q && view === 'inbox' ? 'all' : view)
		if (mailboxId) s.set('mailboxId', mailboxId)
		else if (projectId) s.set('projectId', projectId)
		if (q) s.set('q', q)
		s.set('limit', '50')
		return s.toString()
	}, [view, projectId, mailboxId, folderId, q])

	const { data, size, setSize, isLoading, isValidating, mutate } = useSWRInfinite<Page>(
		(index, prev) => {
			if (special) return null
			if (index === 0) return `/threads?${baseQuery}`
			if (!prev?.next) return null
			return `/threads?${baseQuery}&cursor=${prev.next}`
		},
		fetcher,
		{ revalidateFirstPage: true, revalidateOnFocus: true },
	)
	useListRefresh(() => void mutate())
	const threads = useMemo(
		() => (data ?? []).flatMap(p => p.threads).filter(t => !hidden.has(t.threadId)),
		[data, hidden],
	)
	const hasMore = !!data?.[data.length - 1]?.next
	const loadingMore = size > (data?.length ?? 0)

	const mailboxes = useMemo(
		() => boot?.projects.flatMap(p => p.mailboxes.map(m => ({ mailbox: m, project: p }))) ?? [],
		[boot],
	)
	const projectOf = useCallback(
		(id: string) => {
			const hit = mailboxes.find(x => x.mailbox.id === id)
			return hit ? { project: hit.project, address: hit.mailbox.address } : null
		},
		[mailboxes],
	)
	const project = boot?.projects.find(p => p.id === projectId)
	const mailbox = mailboxes.find(x => x.mailbox.id === mailboxId)?.mailbox
	const folder = boot?.folders.find(f => f.id === folderId)
	const title = folder ? folder.name : (VIEW_TITLES[view] ?? 'Mail')
	const scopeLabel = folder
		? mailboxes.find(x => x.mailbox.id === folder.mailboxId)?.mailbox.address
		: mailbox
			? mailbox.address
			: project?.name
	const showMailbox = !mailboxId && !folderId && mailboxes.length > 1

	const openThread = (t: ThreadRow | null) => setParams({ t: t?.threadId ?? null })

	/** After archive/delete/snooze: hide the thread right away and move to the next one, like Gmail. */
	const removed = (id: string) => {
		setHidden(h => new Set(h).add(id))
		if (threadId === id) {
			const i = threads.findIndex(t => t.threadId === id)
			const next = threads[i + 1] ?? threads[i - 1] ?? null
			openThread(next && next.threadId !== id ? next : null)
		}
	}

	// j / k to move, / to search, Esc to close, x to select
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const t = e.target as HTMLElement
			if (t.closest('input, textarea, [contenteditable="true"], [role="dialog"]') || e.metaKey || e.ctrlKey || e.altKey)
				return
			const i = threads.findIndex(x => x.threadId === threadId)
			if (e.key === 'j' || e.key === 'k') {
				const next = threads[e.key === 'j' ? i + 1 : Math.max(0, i - 1)] ?? threads[0]
				if (next) {
					openThread(next)
					document.querySelector(`[data-thread="${next.threadId}"]`)?.scrollIntoView({ block: 'nearest' })
				}
			} else if (e.key === '/') searchRef.current?.focus()
			else if (e.key === 'Escape') openThread(null)
			else if (e.key === 'x' && threadId)
				setChecked(c => {
					const n = new Set(c)
					n.has(threadId) ? n.delete(threadId) : n.add(threadId)
					return n
				})
			else return
			e.preventDefault()
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	})

	const bulk = async (action: 'archive' | 'trash' | 'read' | 'unread') => {
		const ids = [...checked]
		if (action === 'archive' || action === 'trash') for (const id of ids) removed(id)
		setChecked(new Set())
		await threadAction(ids, action)
	}

	const statusLine = mailbox && mailbox.status !== 'idle' && (
		<div className="flex items-center gap-2 border-b border-separator bg-surface-secondary/60 px-4 py-1.5 text-xs text-muted">
			<StatusDot status={mailbox.status} />
			{mailbox.status === 'syncing' && mailbox.totalCount > 0
				? `Syncing history: ${mailbox.syncedCount.toLocaleString()} of ${mailbox.totalCount.toLocaleString()} messages`
				: mailbox.status === 'error'
					? `Can't connect: ${mailbox.statusMessage}`
					: mailbox.status === 'paused'
						? 'Sync is paused for this mailbox'
						: 'Connecting...'}
		</div>
	)

	return (
		<div className="flex h-full min-h-0">
			<section
				className={`flex min-h-0 w-full flex-col border-r border-separator xl:w-[420px] xl:shrink-0 ${threadId ? 'hidden xl:flex' : 'flex'}`}
			>
				<div className="flex h-14 shrink-0 items-center gap-2 border-b border-separator pr-2 pl-14 lg:pl-4">
					{checked.size > 0 ? (
						<>
							<IconButton label="Clear selection" onPress={() => setChecked(new Set())}>
								<X className="size-4" />
							</IconButton>
							<span className="flex-1 text-sm font-medium">{checked.size} selected</span>
							<IconButton label="Archive" onPress={() => void bulk('archive')}>
								<Archive className="size-4" />
							</IconButton>
							<IconButton label="Delete" onPress={() => void bulk('trash')}>
								<Trash2 className="size-4" />
							</IconButton>
							<IconButton label="Mark read" onPress={() => void bulk('read')}>
								<MailOpen className="size-4" />
							</IconButton>
						</>
					) : (
						<>
							<div className="min-w-0 flex-1">
								<div className="truncate font-semibold leading-tight">{q ? `Search: ${q}` : title}</div>
								{scopeLabel && <div className="truncate text-xs text-muted">{scopeLabel}</div>}
							</div>
							<IconButton
								label="Refresh"
								onPress={() => {
									void mutate()
									void refreshBootstrap()
								}}
							>
								<RefreshCw className={`size-4 ${isValidating ? 'animate-spin' : ''}`} />
							</IconButton>
						</>
					)}
				</div>
				{!special && (
					<form
						className="shrink-0 border-b border-separator px-3 py-2"
						onSubmit={e => {
							e.preventDefault()
							setParams({ q: search.trim() || null, t: null })
						}}
					>
						<SearchField
							aria-label="Search mail"
							value={search}
							onChange={setSearch}
							onClear={() => setParams({ q: null })}
							fullWidth
						>
							<SearchField.Group>
								<SearchField.SearchIcon>
									<Search className="size-4" />
								</SearchField.SearchIcon>
								<SearchField.Input ref={searchRef} placeholder={`Search ${scopeLabel ?? 'all mail'}  ( / )`} />
								<SearchField.ClearButton />
							</SearchField.Group>
						</SearchField>
					</form>
				)}
				{statusLine}
				{/* Switching mailbox, project, folder or view fades the list in with a small rise (Seylo's EnterOnChange) */}
				<EnterOnChange motionKey={baseQuery} className="pane-scroll min-h-0 flex-1">
					{view === 'scheduled' && !folderId ? (
						<OutboxList />
					) : view === 'drafts' && !folderId ? (
						<DraftsList />
					) : isLoading ? (
						<Loading />
					) : threads.length === 0 ? (
						<EmptyState icon={<Inbox />} title={q ? 'No matches' : view === 'inbox' ? 'Inbox zero' : 'Nothing here'}>
							{q
								? 'Try other words. Search looks at the subject, sender and text.'
								: !mailboxes.length
									? 'Connect a mailbox in Projects & domains to start.'
									: undefined}
						</EmptyState>
					) : (
						<ThreadList
							threads={threads}
							selectedId={threadId}
							checked={checked}
							onCheck={(id, on) =>
								setChecked(c => {
									const n = new Set(c)
									on ? n.add(id) : n.delete(id)
									return n
								})
							}
							onCheckMany={(ids, on) =>
								setChecked(c => {
									const n = new Set(c)
									for (const id of ids) on ? n.add(id) : n.delete(id)
									return n
								})
							}
							onOpen={openThread}
							onLoadMore={() => void setSize(size + 1)}
							hasMore={hasMore}
							loadingMore={loadingMore}
							projectOf={projectOf}
							showMailbox={showMailbox}
							onRemoved={removed}
						/>
					)}
				</EnterOnChange>
			</section>
			<section className={`min-h-0 min-w-0 flex-1 ${threadId ? 'block' : 'hidden xl:block'}`}>
				{threadId ? (
					<ThreadView
						key={threadId}
						threadId={threadId}
						onClose={() => openThread(null)}
						onRemoved={() => removed(threadId)}
					/>
				) : (
					<EmptyState icon={<MailOpenIcon />} title="No conversation selected">
						<span>
							Press <kbd className="rounded bg-default px-1">c</kbd> to compose,{' '}
							<kbd className="rounded bg-default px-1">j</kbd>/<kbd className="rounded bg-default px-1">k</kbd> to move.
						</span>
					</EmptyState>
				)}
			</section>
		</div>
	)
}

const MailOpenIcon = () => <MailOpen />

export default function Page() {
	return (
		<Suspense fallback={<Loading />}>
			<MailPage />
		</Suspense>
	)
}
