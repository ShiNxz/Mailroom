'use client'

import { Button } from '@heroui/react'
import { Pencil } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { MailEditor } from '@/components/compose/Editor'
import { api, refreshBootstrap, useBootstrap } from '@/lib/api'
import { Section } from './Section'

export function Signatures() {
	const { data: boot } = useBootstrap()
	const [editing, setEditing] = useState<string | null>(null)
	const [html, setHtml] = useState('')
	const projects = (boot?.projects ?? []).filter(p => p.mailboxes.length > 0)

	const save = async (mailboxId: string, value: string | null) => {
		try {
			await api(`/mailboxes/${mailboxId}/signature`, { method: 'PUT', body: { html: value } })
			void refreshBootstrap()
			setEditing(null)
			toast.success(value === null ? 'Using the mailbox default' : 'Signature saved')
		} catch (err) {
			toast.error((err as Error).message)
		}
	}

	return (
		<>
			{boot && projects.length === 0 && (
				<Section title="No mailboxes yet">
					<p className="text-sm text-muted">Signatures show up here once you can open a mailbox.</p>
				</Section>
			)}
			{projects.map(p => (
				<Section
					key={p.id}
					title={
						<span className="flex items-center gap-2">
							<span className="size-2.5 rounded-[4px]" style={{ background: p.color }} />
							{p.name}
						</span>
					}
				>
					{p.mailboxes.map(m => (
						<div key={m.id} className="flex flex-col gap-2 border-b border-separator pb-4 last:border-0 last:pb-0">
							<div className="flex items-center gap-2">
								<span className="flex-1 truncate text-sm font-medium">{m.address}</span>
								{editing !== m.id && (
									<Button
										size="sm"
										variant="ghost"
										onPress={() => {
											setHtml(m.signature)
											setEditing(m.id)
										}}
									>
										<Pencil className="size-3.5" /> Edit
									</Button>
								)}
							</div>
							{editing === m.id ? (
								<>
									<div className="overflow-hidden rounded-xl border border-border bg-field">
										<MailEditor value={html} onChange={setHtml} placeholder="Your name, title, phone" minHeight={80} />
									</div>
									<div className="flex gap-2">
										<Button size="sm" onPress={() => void save(m.id, html)}>
											Save
										</Button>
										<Button size="sm" variant="secondary" onPress={() => void save(m.id, null)}>
											Use mailbox default
										</Button>
										<Button size="sm" variant="ghost" onPress={() => setEditing(null)}>
											Cancel
										</Button>
									</div>
								</>
							) : m.signature ? (
								<div
									className="signature-preview rounded-lg bg-surface-secondary px-3 py-2 text-sm text-muted"
									dangerouslySetInnerHTML={{ __html: m.signature }}
								/>
							) : (
								<p className="text-xs text-muted">No signature</p>
							)}
						</div>
					))}
				</Section>
			))}
		</>
	)
}
