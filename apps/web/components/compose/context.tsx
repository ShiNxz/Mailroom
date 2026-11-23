'use client'

import type { Address, Attachment, ComposePayload } from '@mailroom/shared'
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react'

export interface ComposeDraft {
	/** Server draft id (16 chars), also used as the composer key. */
	id: string
	title: string
	mailboxId: string | null
	to: Address[]
	cc: Address[]
	bcc: Address[]
	subject: string
	/** What the user writes (the editor content). */
	body: string
	/** The quoted original for replies and forwards, appended under the signature. */
	quoted: string
	replyToMessageId: string | null
	forwardOfMessageId: string | null
	/** Attachments of the forwarded message that go along. */
	forwardAttachments: Attachment[]
	attachments: { id: string; filename: string; size: number; contentType: string }[]
	includeSignature: boolean
}

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'
export const newDraftId = () => {
	const bytes = crypto.getRandomValues(new Uint8Array(16))
	return Array.from(bytes, b => ALPHABET[b % ALPHABET.length]).join('')
}

export const emptyDraft = (over: Partial<ComposeDraft> = {}): ComposeDraft => ({
	title: 'New message',
	mailboxId: null,
	to: [],
	cc: [],
	bcc: [],
	subject: '',
	body: '',
	quoted: '',
	replyToMessageId: null,
	forwardOfMessageId: null,
	forwardAttachments: [],
	attachments: [],
	includeSignature: true,
	...over,
	id: over.id ?? newDraftId(),
})

/** Server draft payload -> composer state. Quoted text is kept inside html after a marker. */
export const QUOTE_MARKER = '<!--mr-quote-->'
export function draftFromPayload(id: string, p: Partial<ComposePayload>): ComposeDraft {
	const html = p.html ?? ''
	const at = html.indexOf(QUOTE_MARKER)
	return emptyDraft({
		id,
		title: 'Draft',
		mailboxId: p.mailboxId ?? null,
		to: p.to ?? [],
		cc: p.cc ?? [],
		bcc: p.bcc ?? [],
		subject: p.subject ?? '',
		body: at >= 0 ? html.slice(0, at) : html,
		quoted: at >= 0 ? html.slice(at + QUOTE_MARKER.length) : '',
		replyToMessageId: p.replyToMessageId ?? null,
		forwardOfMessageId: p.forwardOfMessageId ?? null,
		includeSignature: false,
	})
}

interface ComposeContextValue {
	drafts: ComposeDraft[]
	open: (draft?: Partial<ComposeDraft>) => void
	close: (id: string) => void
	focusedId: string | null
}

const ComposeContext = createContext<ComposeContextValue | null>(null)

export function ComposeProvider({ children }: { children: ReactNode }) {
	const [drafts, setDrafts] = useState<ComposeDraft[]>([])
	const [focusedId, setFocusedId] = useState<string | null>(null)

	const open = useCallback((over: Partial<ComposeDraft> = {}) => {
		setDrafts(current => {
			if (over.id && current.some(d => d.id === over.id)) return current
			const draft = emptyDraft(over)
			setFocusedId(draft.id)
			// At most three open at once: the oldest makes room
			return [...current.slice(-2), draft]
		})
	}, [])

	const close = useCallback((id: string) => setDrafts(current => current.filter(d => d.id !== id)), [])

	const value = useMemo(() => ({ drafts, open, close, focusedId }), [drafts, open, close, focusedId])
	return <ComposeContext.Provider value={value}>{children}</ComposeContext.Provider>
}

export function useCompose() {
	const ctx = useContext(ComposeContext)
	if (!ctx) throw new Error('useCompose outside ComposeProvider')
	return ctx
}
