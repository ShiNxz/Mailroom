'use client'

import type { Project, ThreadRow } from '@mailroom/shared'
import { Checkbox } from '@heroui/react'
import { Archive, Clock, MailOpen, Paperclip, Star, Trash2 } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { snoozeOptions, threadAction } from '@/lib/actions'
import { PersonAvatar } from '@/components/ui'
import { displayName, listDate } from '@/lib/format'

export function ThreadList({
	threads,
	selectedId,
	checked,
	onCheck,
	onOpen,
	onLoadMore,
	hasMore,
	loadingMore,
	projectOf,
	showMailbox,
	onRemoved,
}: {
	threads: ThreadRow[]
	selectedId: string | null
	checked: Set<string>
	onCheck: (id: string, on: boolean) => void
	onOpen: (t: ThreadRow) => void
	onLoadMore: () => void
	hasMore: boolean
	loadingMore: boolean
	projectOf: (mailboxId: string) => { project: Project; address: string } | null
	showMailbox: boolean
	onRemoved: (id: string) => void
}) {
	const sentinel = useRef<HTMLDivElement>(null)
	const selecting = checked.size > 0

	useEffect(() => {
		const el = sentinel.current
		if (!el || !hasMore) return
		const io = new IntersectionObserver(entries => {
			if (entries.some(e => e.isIntersecting) && !loadingMore) onLoadMore()
		})
		io.observe(el)
		return () => io.disconnect()
	}, [hasMore, loadingMore, threads.length])

	return (
		<ul className="flex flex-col">
			{threads.map(t => {
				const selected = t.threadId === selectedId
				const owner = showMailbox ? projectOf(t.mailboxId) : null
				const isChecked = checked.has(t.threadId)
				return (
					<li key={t.threadId}>
						<div
							role="button"
							tabIndex={0}
							onClick={() => onOpen(t)}
							onKeyDown={e => e.key === 'Enter' && onOpen(t)}
							data-thread={t.threadId}
							className={`group relative flex cursor-pointer gap-3 border-b border-separator px-4 py-3 outline-none transition-colors ${
								selected ? 'bg-accent/10' : isChecked ? 'bg-default/60' : 'hover:bg-default/50'
							}`}
						>
							<PersonAvatar who={t.from} size={40} />
							<div className="min-w-0 flex-1">
								<div className="flex items-center gap-2">
									<span
										className={`min-w-0 flex-1 truncate text-[15px] leading-5 ${t.unread ? 'font-semibold text-foreground' : 'text-foreground'}`}
									>
										{participantsLine(t)}
										{t.count > 1 && <span className="ml-1.5 text-xs font-normal text-muted">{t.count}</span>}
									</span>
									<span
										className={`shrink-0 text-xs tabular-nums group-hover:invisible ${selecting ? 'invisible' : ''} ${t.unread ? 'font-semibold text-foreground' : 'text-muted'}`}
									>
										{t.snoozedUntil ? (
											<span className="inline-flex items-center gap-1 text-warning">
												<Clock className="size-3" />
												{listDate(t.snoozedUntil)}
											</span>
										) : (
											listDate(t.date)
										)}
									</span>
									<span
										className={`size-2 shrink-0 rounded-full ${t.unread ? 'bg-accent' : 'bg-transparent'} group-hover:invisible ${selecting ? 'invisible' : ''}`}
									>
										{t.unread && <span className="sr-only">Unread</span>}
									</span>
									{/* While picking several, each row shows its checkbox where the date was */}
									{selecting && (
										<span
											className="absolute top-2.5 right-3 z-10 flex items-center p-1 group-hover:hidden"
											onClick={e => e.stopPropagation()}
										>
											<RowCheckbox checked={isChecked} onChange={on => onCheck(t.threadId, on)} />
										</span>
									)}
									{/* Floats over the date so hovering never changes the row height */}
									<span
										className="absolute top-2 right-3 z-10 hidden items-center gap-0.5 rounded-lg border border-separator bg-surface/95 p-0.5 shadow-sm backdrop-blur group-hover:flex"
										onClick={e => e.stopPropagation()}
									>
										<span className="flex items-center px-1">
											<RowCheckbox checked={isChecked} onChange={on => onCheck(t.threadId, on)} />
										</span>
										<HoverAction
											label="Archive"
											onClick={() => {
												onRemoved(t.threadId)
												void threadAction([t.threadId], 'archive')
											}}
										>
											<Archive />
										</HoverAction>
										<HoverAction
											label="Delete"
											onClick={() => {
												onRemoved(t.threadId)
												void threadAction([t.threadId], 'trash')
											}}
										>
											<Trash2 />
										</HoverAction>
										<HoverAction
											label={t.unread ? 'Mark read' : 'Mark unread'}
											onClick={() => void threadAction([t.threadId], t.unread ? 'read' : 'unread')}
										>
											<MailOpen />
										</HoverAction>
										<HoverAction
											label="Snooze until tomorrow"
											onClick={() => {
												const o = snoozeOptions().find(x => x.id === 'tomorrow')
												if (!o) return
												onRemoved(t.threadId)
												void threadAction([t.threadId], 'snooze', { until: o.date })
											}}
										>
											<Clock />
										</HoverAction>
									</span>
								</div>
								<div
									className={`truncate text-sm leading-5 ${t.unread ? 'font-medium text-foreground' : 'text-muted'}`}
								>
									{t.subject || '(no subject)'}
								</div>
								<div className="flex items-center gap-1.5">
									<span className="min-w-0 flex-1 truncate text-sm leading-5 text-muted">{t.snippet}</span>
									{t.hasAttachments && <Paperclip className="size-3.5 shrink-0 text-muted" />}
									{owner && (
										<span
											className="inline-flex max-w-[45%] shrink-0 items-center gap-1 truncate rounded-md bg-default px-1.5 py-px text-[10px] text-muted"
											title={owner.address}
										>
											<span className="size-1.5 shrink-0 rounded-full" style={{ background: owner.project.color }} />
											<span className="truncate">{owner.address.split('@')[1]}</span>
										</span>
									)}
									<button
										type="button"
										aria-label={t.starred ? 'Unstar' : 'Star'}
										onClick={e => {
											e.stopPropagation()
											void threadAction([t.threadId], t.starred ? 'unstar' : 'star')
										}}
										className={`-mr-0.5 shrink-0 rounded p-0.5 transition-colors ${t.starred ? 'text-warning' : 'text-muted/60 hover:text-foreground'}`}
									>
										<Star className={`size-4 ${t.starred ? 'fill-warning' : ''}`} />
									</button>
								</div>
							</div>
						</div>
					</li>
				)
			})}
			<div ref={sentinel} className="h-8">
				{loadingMore && <p className="py-2 text-center text-xs text-muted">Loading more...</p>}
			</div>
		</ul>
	)
}

function RowCheckbox({ checked, onChange }: { checked: boolean; onChange: (on: boolean) => void }) {
	return (
		<Checkbox aria-label="Select" isSelected={checked} onChange={onChange}>
			{/* Content is the clickable part (a label around a hidden input); the control alone does nothing */}
			<Checkbox.Content>
				{/* An outline so it reads on the white toolbar */}
				<Checkbox.Control className="size-4 ring-1 ring-border">
					<Checkbox.Indicator />
				</Checkbox.Control>
			</Checkbox.Content>
		</Checkbox>
	)
}

function HoverAction({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
	return (
		<button
			type="button"
			title={label}
			aria-label={label}
			onClick={onClick}
			className="rounded-md p-1 text-muted transition-colors hover:bg-default hover:text-foreground [&_svg]:size-3.5"
		>
			{children}
		</button>
	)
}

function participantsLine(t: ThreadRow) {
	const names = t.participants.length ? t.participants.map(displayName) : [displayName(t.from)]
	const unique = [...new Set(names)]
	if (unique.length <= 2) return unique.join(', ')
	return `${unique[0]}, ${unique[1]} +${unique.length - 2}`
}
