'use client'

import { type ComposePayload, isAdminRole, type OutboxItem, type Template, type Upload } from '@mailroom/shared'
import { Button, Dropdown, Header, Label, ListBox, Modal, Select, Separator, Spinner } from '@heroui/react'
import type { Editor as TiptapEditor } from '@tiptap/react'
import { addDays, format, nextMonday, setHours, setMinutes, startOfDay } from 'date-fns'
import { ChevronDown, Clock, FileText, Maximize2, Minimize2, Minus, Paperclip, Send, Trash2, X } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import useSWR, { mutate } from 'swr'
import { api, fetcher, refreshBootstrap, useBootstrap, useMe } from '@/lib/api'
import { fileSize, isEmail } from '@/lib/format'
import { type ComposeDraft, QUOTE_MARKER, useCompose } from './context'
import { MailEditor } from './Editor'
import { RecipientInput } from './RecipientInput'

type UploadState = Upload & { uploading?: boolean }

function schedulePresets() {
	const now = new Date()
	const at = (d: Date, h: number) => setMinutes(setHours(startOfDay(d), h), 0)
	const list = [
		{ label: 'Tomorrow morning', date: at(addDays(now, 1), 8) },
		{ label: 'Tomorrow afternoon', date: at(addDays(now, 1), 13) },
		{ label: 'Monday morning', date: at(nextMonday(now), 8) },
	]
	if (now.getHours() < 17) list.unshift({ label: 'This evening', date: at(now, 18) })
	return list
}

export function Composer({ draft, index }: { draft: ComposeDraft; index: number }) {
	const { close, open } = useCompose()
	const { data: boot } = useBootstrap()
	const { data: me } = useMe()
	const { data: templates } = useSWR<{ templates: Template[] }>('/templates', fetcher)

	const [state, setState] = useState(draft)
	const [showCc, setShowCc] = useState(draft.cc.length > 0 || draft.bcc.length > 0)
	const [minimized, setMinimized] = useState(false)
	const [maximized, setMaximized] = useState(false)
	const [showQuoted, setShowQuoted] = useState(false)
	const [uploads, setUploads] = useState<UploadState[]>(draft.attachments)
	const [sending, setSending] = useState(false)
	const [customOpen, setCustomOpen] = useState(false)
	const [customAt, setCustomAt] = useState('')
	const [dirty, setDirty] = useState(false)
	const [dragging, setDragging] = useState(false)
	const editorRef = useRef<TiptapEditor | null>(null)
	const fileRef = useRef<HTMLInputElement>(null)

	const mailboxes = useMemo(
		() => boot?.projects.flatMap(p => p.mailboxes.map(m => ({ ...m, project: p }))) ?? [],
		[boot],
	)
	const mailboxId = state.mailboxId ?? mailboxes[0]?.id ?? null
	const mailbox = mailboxes.find(m => m.id === mailboxId)
	const signature = mailbox?.signature ?? ''

	const update = (patch: Partial<ComposeDraft>) => {
		setState(s => ({ ...s, ...patch }))
		setDirty(true)
	}

	const payload = (): ComposePayload => ({
		mailboxId: mailboxId ?? '',
		to: state.to,
		cc: state.cc,
		bcc: state.bcc,
		subject: state.subject,
		html: assembleHtml(),
		replyToMessageId: state.replyToMessageId,
		forwardOfMessageId: state.forwardOfMessageId,
		attachmentIds: uploads.filter(u => !u.uploading).map(u => u.id),
		forwardAttachments: state.forwardAttachments.map(a => a.partId),
	})

	function assembleHtml() {
		const parts = [state.body || '<p></p>']
		if (state.includeSignature && signature.trim())
			parts.push(`<div class="mr-signature" style="margin-top:14px">${signature}</div>`)
		if (state.quoted) parts.push(`<div class="mr-quoted" style="margin-top:18px">${state.quoted}</div>`)
		return parts.join('')
	}

	// Autosave to the server, so the draft follows you to other devices
	useEffect(() => {
		if (!dirty) return
		const timer = setTimeout(() => {
			api(`/drafts/${state.id}`, {
				method: 'PUT',
				body: {
					payload: {
						mailboxId: mailboxId ?? undefined,
						to: state.to,
						cc: state.cc,
						bcc: state.bcc,
						subject: state.subject,
						html: `${state.body}${QUOTE_MARKER}${state.quoted}`,
						replyToMessageId: state.replyToMessageId,
						forwardOfMessageId: state.forwardOfMessageId,
						attachmentIds: uploads.filter(u => !u.uploading).map(u => u.id),
					},
				},
			})
				.then(() => {
					void mutate('/drafts')
					void refreshBootstrap()
				})
				.catch(() => {})
		}, 1500)
		return () => clearTimeout(timer)
	}, [state, uploads, dirty])

	const discard = async () => {
		close(state.id)
		await api(`/drafts/${state.id}`, { method: 'DELETE' }).catch(() => {})
		void mutate('/drafts')
		void refreshBootstrap()
	}

	const upload = async (files: FileList | File[]) => {
		for (const file of [...files]) {
			const temp: UploadState = {
				id: `tmp-${Math.random()}`,
				filename: file.name,
				size: file.size,
				contentType: file.type,
				uploading: true,
			}
			setUploads(u => [...u, temp])
			try {
				const form = new FormData()
				form.append('file', file)
				const { upload } = await api<{ upload: Upload }>('/uploads', { form })
				setUploads(u => u.map(x => (x.id === temp.id ? upload : x)))
				setDirty(true)
			} catch (err) {
				setUploads(u => u.filter(x => x.id !== temp.id))
				toast.error(`Could not attach ${file.name}`, { description: (err as Error).message })
			}
		}
	}

	const send = async (sendAt?: Date) => {
		if (!mailboxId) return toast.error('Connect a mailbox first')
		const all = [...state.to, ...state.cc, ...state.bcc]
		if (!all.length) return toast.error('Add at least one recipient')
		const bad = all.find(a => !isEmail(a.address))
		if (bad) return toast.error(`"${bad.address}" is not a valid address`)
		if (uploads.some(u => u.uploading)) return toast.error('Wait for the attachments to finish uploading')
		if (!state.subject.trim() && !window.confirm('Send without a subject?')) return
		setSending(true)
		try {
			const { item } = await api<{ item: OutboxItem }>('/send', {
				body: { payload: payload(), sendAt: sendAt?.toISOString(), draftId: state.id },
			})
			close(state.id)
			void refreshBootstrap()
			void mutate('/drafts')
			// An open thread shows the reply right away (PendingReplies in ThreadView)
			void mutate(key => typeof key === 'string' && key.startsWith('/outbox'))
			const reopen = async () => {
				try {
					await api(`/outbox/${item.id}/cancel`, { method: 'POST' })
					open({ ...state, id: state.id, attachments: uploads.filter(u => !u.uploading) })
					void refreshBootstrap()
				} catch (err) {
					toast.error((err as Error).message)
				}
			}
			if (sendAt) {
				toast.success(`Scheduled for ${format(sendAt, "EEE, MMM d 'at' HH:mm")}`, {
					action: { label: 'Undo', onClick: reopen },
				})
			} else {
				const undo = me?.user.settings.undoSeconds ?? 10
				// A reply shows in its thread with the countdown and Undo there; a new message gets the toast
				if (!state.replyToMessageId) {
					if (undo > 0) toast('Sending...', { duration: undo * 1000, action: { label: 'Undo', onClick: reopen } })
					else toast.success('Sent')
				}
			}
		} catch (err) {
			toast.error('Could not send', { description: (err as Error).message })
		} finally {
			setSending(false)
		}
	}

	const right = 16 + index * 580
	const frame = maximized
		? 'fixed inset-x-[6vw] inset-y-[5vh] z-40 w-auto'
		: `fixed bottom-0 z-40 w-[min(560px,100vw)] ${minimized ? 'h-12' : 'h-[min(640px,85dvh)]'}`

	return (
		<div
			className={`${frame} flex flex-col overflow-hidden rounded-t-2xl border border-border bg-surface shadow-2xl ${maximized ? 'rounded-2xl' : ''}`}
			style={
				maximized
					? undefined
					: { right: Math.min(right, typeof window !== 'undefined' ? window.innerWidth - 300 : right) }
			}
			onKeyDown={e => {
				if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
					e.preventDefault()
					void send()
				}
			}}
			onDragOver={e => {
				if (e.dataTransfer.types.includes('Files')) {
					e.preventDefault()
					setDragging(true)
				}
			}}
			onDragLeave={() => setDragging(false)}
			onDrop={e => {
				e.preventDefault()
				setDragging(false)
				if (e.dataTransfer.files.length) void upload(e.dataTransfer.files)
			}}
		>
			<div
				className="flex h-12 shrink-0 cursor-default items-center gap-2 bg-surface-secondary px-4"
				onDoubleClick={() => setMinimized(m => !m)}
			>
				<span className="flex-1 truncate text-sm font-medium">{state.subject || state.title}</span>
				<button
					type="button"
					aria-label="Minimize"
					className="rounded p-1 text-muted hover:text-foreground"
					onClick={() => setMinimized(m => !m)}
				>
					<Minus className="size-4" />
				</button>
				<button
					type="button"
					aria-label={maximized ? 'Restore' : 'Full screen'}
					className="rounded p-1 text-muted hover:text-foreground"
					onClick={() => {
						setMaximized(m => !m)
						setMinimized(false)
					}}
				>
					{maximized ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
				</button>
				<button
					type="button"
					aria-label="Close"
					className="rounded p-1 text-muted hover:text-foreground"
					onClick={() => close(state.id)}
				>
					<X className="size-4" />
				</button>
			</div>

			{!minimized && (
				<>
					<div className="flex items-center gap-2 border-b border-separator px-4 py-1">
						<span className="text-sm text-muted">From</span>
						<Select
							aria-label="From"
							className="min-w-0 flex-1"
							variant="secondary"
							value={mailboxId}
							onChange={v => update({ mailboxId: String(v) })}
							placeholder={mailboxes.length ? 'Pick a mailbox' : 'No mailboxes yet'}
						>
							<Select.Trigger className="h-9 border-0 bg-transparent shadow-none">
								<Select.Value className="truncate text-sm" />
								<Select.Indicator />
							</Select.Trigger>
							<Select.Popover className="min-w-[320px]">
								<ListBox>
									{(boot?.projects ?? [])
										.filter(p => p.mailboxes.length)
										.map(p => (
											<ListBox.Section key={p.id}>
												<Header>
													<span className="inline-flex items-center gap-1.5">
														<span className="size-2 rounded-full" style={{ background: p.color }} />
														{p.name}
													</span>
												</Header>
												{p.mailboxes.map(m => (
													<ListBox.Item
														key={m.id}
														id={m.id}
														textValue={m.displayName ? `${m.displayName} <${m.address}>` : m.address}
													>
														<Label>{m.displayName ? `${m.displayName} <${m.address}>` : m.address}</Label>
														<ListBox.ItemIndicator />
													</ListBox.Item>
												))}
											</ListBox.Section>
										))}
								</ListBox>
							</Select.Popover>
						</Select>
					</div>
					{mailbox && !mailbox.displayName.trim() && (
						<div className="flex items-center gap-1.5 border-b border-separator bg-warning/10 px-4 py-1.5 text-xs text-warning">
							<span className="min-w-0 flex-1">
								This mailbox has no sender name, so people see only {mailbox.address}.
							</span>
							{me && isAdminRole(me.user.role) && (
								<Link href={`/admin/projects?id=${mailbox.projectId}`} className="shrink-0 font-medium underline">
									Add a sender name
								</Link>
							)}
						</div>
					)}

					<RecipientInput
						label="To"
						value={state.to}
						onChange={to => update({ to })}
						autoFocus={!state.to.length}
						trailing={
							!showCc && (
								<button
									type="button"
									className="pt-1.5 text-sm text-muted hover:text-foreground"
									onClick={() => setShowCc(true)}
								>
									Cc Bcc
								</button>
							)
						}
					/>
					{showCc && (
						<>
							<RecipientInput label="Cc" value={state.cc} onChange={cc => update({ cc })} />
							<RecipientInput label="Bcc" value={state.bcc} onChange={bcc => update({ bcc })} />
						</>
					)}
					<input
						value={state.subject}
						onChange={e => update({ subject: e.target.value })}
						placeholder="Subject"
						aria-label="Subject"
						className="h-10 shrink-0 border-b border-separator bg-transparent px-4 text-sm outline-none placeholder:text-muted"
					/>

					<div className="relative flex min-h-0 flex-1 flex-col">
						<MailEditor
							value={state.body}
							onChange={body => update({ body })}
							autoFocus={state.to.length > 0}
							onReady={e => {
								editorRef.current = e
							}}
						/>
						{dragging && (
							<div className="pointer-events-none absolute inset-2 flex items-center justify-center rounded-xl border-2 border-dashed border-accent bg-accent/10 text-sm font-medium text-accent">
								Drop files to attach
							</div>
						)}
						<div className="max-h-[40%] shrink-0 overflow-y-auto px-4 pb-2">
							{signature.trim() && (
								<div className="group mt-1 flex items-start gap-2">
									<div
										className={`signature-preview flex-1 text-sm ${state.includeSignature ? 'text-muted' : 'text-muted/40 line-through'}`}
										dangerouslySetInnerHTML={{ __html: signature }}
									/>
									<button
										type="button"
										className="text-xs text-muted opacity-0 hover:text-foreground group-hover:opacity-100"
										onClick={() => update({ includeSignature: !state.includeSignature })}
									>
										{state.includeSignature ? 'Remove signature' : 'Add signature'}
									</button>
								</div>
							)}
							{state.quoted && (
								<div className="mt-2">
									<button
										type="button"
										className="rounded bg-default px-2 text-xs text-muted hover:text-foreground"
										onClick={() => setShowQuoted(s => !s)}
										title="Show quoted text"
									>
										•••
									</button>
									{showQuoted && (
										<div
											className="mt-2 border-l-2 border-separator pl-3 text-sm text-muted [&_img]:max-w-full"
											dangerouslySetInnerHTML={{ __html: state.quoted }}
										/>
									)}
								</div>
							)}
							{(uploads.length > 0 || state.forwardAttachments.length > 0) && (
								<div className="mt-2 flex flex-wrap gap-2">
									{state.forwardAttachments.map(a => (
										<AttachmentChip
											key={a.partId}
											name={a.filename}
											size={a.size}
											onRemove={() =>
												update({ forwardAttachments: state.forwardAttachments.filter(x => x.partId !== a.partId) })
											}
										/>
									))}
									{uploads.map(u => (
										<AttachmentChip
											key={u.id}
											name={u.filename}
											size={u.size}
											pending={u.uploading}
											onRemove={() => {
												setUploads(list => list.filter(x => x.id !== u.id))
												setDirty(true)
												if (!u.uploading) void api(`/uploads/${u.id}`, { method: 'DELETE' }).catch(() => {})
											}}
										/>
									))}
								</div>
							)}
						</div>
					</div>

					<div className="flex shrink-0 items-center gap-1 border-t border-separator px-3 py-2">
						<div className="flex">
							<Button onPress={() => void send()} isPending={sending} className="rounded-r-none">
								<Send className="size-4" /> Send
							</Button>
							<Dropdown>
								<Button
									isIconOnly
									aria-label="Schedule send"
									className="rounded-l-none border-l border-accent-foreground/20"
									isDisabled={sending}
								>
									<ChevronDown className="size-4" />
								</Button>
								<Dropdown.Popover placement="top start">
									<Dropdown.Menu
										onAction={key => {
											if (key === 'custom') {
												setCustomAt(format(addDays(new Date(), 1), "yyyy-MM-dd'T'08:00"))
												setCustomOpen(true)
												return
											}
											const preset = schedulePresets()[Number(key)]
											if (preset) void send(preset.date)
										}}
									>
										<Dropdown.Section>
											<Header>Schedule send</Header>
											{schedulePresets().map((p, i) => (
												<Dropdown.Item key={p.label} id={String(i)} textValue={p.label}>
													<Clock className="size-4 text-muted" />
													<Label>{p.label}</Label>
													<span className="ml-auto pl-4 text-xs text-muted">{format(p.date, 'EEE HH:mm')}</span>
												</Dropdown.Item>
											))}
										</Dropdown.Section>
										<Separator />
										<Dropdown.Item id="custom" textValue="Pick date and time">
											<Label>Pick date and time...</Label>
										</Dropdown.Item>
									</Dropdown.Menu>
								</Dropdown.Popover>
							</Dropdown>
						</div>

						<input
							ref={fileRef}
							type="file"
							multiple
							hidden
							onChange={e => e.target.files && void upload(e.target.files)}
						/>
						<Button isIconOnly variant="ghost" aria-label="Attach files" onPress={() => fileRef.current?.click()}>
							<Paperclip className="size-4" />
						</Button>
						<Dropdown>
							<Button isIconOnly variant="ghost" aria-label="Templates">
								<FileText className="size-4" />
							</Button>
							<Dropdown.Popover placement="top start">
								<Dropdown.Menu
									onAction={key => {
										const t = templates?.templates.find(x => x.id === key)
										if (!t) return
										editorRef.current?.chain().focus().insertContent(t.html).run()
										if (!state.subject && t.subject) update({ subject: t.subject })
									}}
								>
									<Dropdown.Section>
										<Header>Templates</Header>
										{templates?.templates.length ? (
											templates.templates.map(t => (
												<Dropdown.Item key={t.id} id={t.id} textValue={t.name}>
													<Label>{t.name}</Label>
												</Dropdown.Item>
											))
										) : (
											<Dropdown.Item id="none" isDisabled textValue="No templates">
												<Label>No templates yet. Add them in Settings.</Label>
											</Dropdown.Item>
										)}
									</Dropdown.Section>
								</Dropdown.Menu>
							</Dropdown.Popover>
						</Dropdown>
						<span className="flex-1" />
						{dirty && <span className="mr-2 hidden text-xs text-muted sm:inline">Draft saved</span>}
						<Button isIconOnly variant="ghost" aria-label="Discard draft" onPress={() => void discard()}>
							<Trash2 className="size-4" />
						</Button>
					</div>
				</>
			)}

			<Modal.Backdrop isOpen={customOpen} onOpenChange={setCustomOpen}>
				<Modal.Container size="sm">
					<Modal.Dialog>
						<Modal.CloseTrigger />
						<Modal.Header>
							<Modal.Heading>Schedule send</Modal.Heading>
						</Modal.Header>
						<Modal.Body>
							<input
								type="datetime-local"
								value={customAt}
								min={format(new Date(), "yyyy-MM-dd'T'HH:mm")}
								onChange={e => setCustomAt(e.target.value)}
								className="w-full rounded-xl border border-border bg-field px-3 py-2 text-sm text-foreground"
							/>
						</Modal.Body>
						<Modal.Footer>
							<Button slot="close" variant="secondary">
								Cancel
							</Button>
							<Button
								onPress={() => {
									const d = new Date(customAt)
									if (Number.isNaN(d.getTime()) || d.getTime() < Date.now() + 60_000)
										return toast.error('Pick a time in the future')
									setCustomOpen(false)
									void send(d)
								}}
							>
								Schedule
							</Button>
						</Modal.Footer>
					</Modal.Dialog>
				</Modal.Container>
			</Modal.Backdrop>
		</div>
	)
}

function AttachmentChip({
	name,
	size,
	pending,
	onRemove,
}: {
	name: string
	size: number
	pending?: boolean
	onRemove: () => void
}) {
	return (
		<span className="inline-flex max-w-[240px] items-center gap-2 rounded-lg border border-border bg-surface-secondary py-1 pr-1 pl-2.5 text-xs">
			{pending ? <Spinner size="sm" color="current" /> : <Paperclip className="size-3.5 text-muted" />}
			<span className="truncate">{name}</span>
			<span className="shrink-0 text-muted">{fileSize(size)}</span>
			<button
				type="button"
				aria-label={`Remove ${name}`}
				className="rounded p-0.5 text-muted hover:bg-default hover:text-foreground"
				onClick={onRemove}
			>
				<X className="size-3" />
			</button>
		</span>
	)
}

export function ComposerHost() {
	const { drafts } = useCompose()
	return (
		<>
			{drafts.map((d, i) => (
				<Composer key={d.id} draft={d} index={drafts.length - 1 - i} />
			))}
		</>
	)
}
