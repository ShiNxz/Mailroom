'use client'

import type { Template } from '@mailroom/shared'
import { Button, Input, Label, ListBox, Modal, Select, TextField } from '@heroui/react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import useSWR from 'swr'
import { MailEditor } from '@/components/compose/Editor'
import { IconButton } from '@/components/ui'
import { api, fetcher, useBootstrap } from '@/lib/api'
import { Section } from './Section'

export function Templates() {
	const { data, mutate } = useSWR<{ templates: Template[] }>('/templates', fetcher)
	const { data: boot } = useBootstrap()
	const [open, setOpen] = useState(false)
	const [edit, setEdit] = useState<Template | null>(null)
	const [name, setName] = useState('')
	const [subject, setSubject] = useState('')
	const [html, setHtml] = useState('')
	const [scope, setScope] = useState('personal')

	useEffect(() => {
		if (!open) return
		setName(edit?.name ?? '')
		setSubject(edit?.subject ?? '')
		setHtml(edit?.html ?? '')
		setScope(edit?.projectId ?? 'personal')
	}, [open, edit])

	const save = async () => {
		if (!name.trim() || !html.trim()) return toast.error('Give it a name and some text')
		try {
			if (edit) await api(`/templates/${edit.id}`, { method: 'PUT', body: { name, subject, html } })
			else await api('/templates', { body: { name, subject, html, projectId: scope === 'personal' ? null : scope } })
			void mutate()
			setOpen(false)
		} catch (err) {
			toast.error((err as Error).message)
		}
	}

	return (
		<Section
			title="Saved replies"
			action={
				<Button
					variant="secondary"
					size="sm"
					onPress={() => {
						setEdit(null)
						setOpen(true)
					}}
				>
					<Plus className="size-3.5" /> New template
				</Button>
			}
		>
			{data && !data.templates.length && (
				<p className="text-sm text-muted">No templates yet. Make one for the replies you send often.</p>
			)}
			{data?.templates.map(t => (
				<div key={t.id} className="flex items-center gap-2">
					<div className="min-w-0 flex-1">
						<div className="truncate text-sm font-medium">{t.name}</div>
						<div className="truncate text-xs text-muted">
							{t.projectId ? (boot?.projects.find(p => p.id === t.projectId)?.name ?? 'Project') : 'Personal'}
							{t.subject && ` · ${t.subject}`}
						</div>
					</div>
					<IconButton
						label="Edit"
						onPress={() => {
							setEdit(t)
							setOpen(true)
						}}
					>
						<Pencil className="size-4" />
					</IconButton>
					<IconButton
						label="Delete"
						onPress={async () => {
							await api(`/templates/${t.id}`, { method: 'DELETE' }).catch(err => toast.error(err.message))
							void mutate()
						}}
					>
						<Trash2 className="size-4" />
					</IconButton>
				</div>
			))}
			<Modal.Backdrop isOpen={open} onOpenChange={setOpen}>
				<Modal.Container size="lg">
					<Modal.Dialog>
						<Modal.CloseTrigger />
						<Modal.Header>
							<Modal.Heading>{edit ? 'Edit template' : 'New template'}</Modal.Heading>
						</Modal.Header>
						<Modal.Body className="flex flex-col gap-3">
							<div className="grid gap-3 sm:grid-cols-2">
								<TextField value={name} onChange={setName} autoFocus>
									<Label>Name</Label>
									<Input placeholder="Pricing reply" />
								</TextField>
								{!edit && (
									<Select value={scope} onChange={v => setScope(String(v))}>
										<Label>Who can use it</Label>
										<Select.Trigger>
											<Select.Value />
											<Select.Indicator />
										</Select.Trigger>
										<Select.Popover>
											<ListBox>
												<ListBox.Item id="personal" textValue="Only me">
													Only me
													<ListBox.ItemIndicator />
												</ListBox.Item>
												{boot?.projects.map(p => (
													<ListBox.Item key={p.id} id={p.id} textValue={p.name}>
														Everyone on {p.name}
														<ListBox.ItemIndicator />
													</ListBox.Item>
												))}
											</ListBox>
										</Select.Popover>
									</Select>
								)}
							</div>
							<TextField value={subject} onChange={setSubject}>
								<Label>Subject (optional)</Label>
								<Input />
							</TextField>
							<div className="overflow-hidden rounded-xl border border-border bg-field">
								<MailEditor value={html} onChange={setHtml} minHeight={160} />
							</div>
						</Modal.Body>
						<Modal.Footer>
							<Button slot="close" variant="secondary">
								Cancel
							</Button>
							<Button onPress={() => void save()}>Save</Button>
						</Modal.Footer>
					</Modal.Dialog>
				</Modal.Container>
			</Modal.Backdrop>
		</Section>
	)
}
