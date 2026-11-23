'use client'

import type { Address, Contact } from '@mailroom/shared'
import { X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { displayName, isEmail, parseAddressList } from '@/lib/format'

/** Recipients as chips, with autocomplete from people you have mailed with. */
export function RecipientInput({
	label,
	value,
	onChange,
	autoFocus,
	trailing,
}: {
	label: string
	value: Address[]
	onChange: (v: Address[]) => void
	autoFocus?: boolean
	trailing?: React.ReactNode
}) {
	const [text, setText] = useState('')
	const [suggestions, setSuggestions] = useState<Contact[]>([])
	const [active, setActive] = useState(0)
	const inputRef = useRef<HTMLInputElement>(null)

	useEffect(() => {
		const q = text.trim()
		if (q.length < 2) {
			setSuggestions([])
			return
		}
		const timer = setTimeout(() => {
			api<{ contacts: Contact[] }>(`/contacts?q=${encodeURIComponent(q)}`)
				.then(r => {
					setSuggestions(r.contacts.filter(c => !value.some(v => v.address === c.address)))
					setActive(0)
				})
				.catch(() => setSuggestions([]))
		}, 150)
		return () => clearTimeout(timer)
	}, [text])

	const add = (list: Address[]) => {
		const next = [...value]
		for (const a of list) if (a.address && !next.some(v => v.address === a.address)) next.push(a)
		onChange(next)
		setText('')
		setSuggestions([])
	}

	const commitText = () => {
		const parsed = parseAddressList(text)
		if (parsed.length) add(parsed)
	}

	return (
		<div className="relative flex min-h-10 items-start gap-2 border-b border-separator px-4 py-1.5">
			<span className="pt-1.5 text-sm text-muted">{label}</span>
			<div className="flex min-w-0 flex-1 flex-wrap items-center gap-1" onClick={() => inputRef.current?.focus()}>
				{value.map(a => (
					<span
						key={a.address}
						title={a.address}
						className={`inline-flex max-w-full items-center gap-1 rounded-full py-0.5 pr-1 pl-2.5 text-sm ${isEmail(a.address) ? 'bg-default text-foreground' : 'bg-danger-soft text-danger'}`}
					>
						<span className="truncate">{a.name ? displayName(a) : a.address}</span>
						<button
							type="button"
							aria-label={`Remove ${a.address}`}
							className="rounded-full p-0.5 text-muted hover:bg-surface hover:text-foreground"
							onClick={e => {
								e.stopPropagation()
								onChange(value.filter(v => v.address !== a.address))
							}}
						>
							<X className="size-3" />
						</button>
					</span>
				))}
				<input
					ref={inputRef}
					value={text}
					autoFocus={autoFocus}
					onChange={e => {
						const v = e.target.value
						if (/[,;]\s*$/.test(v)) {
							const parsed = parseAddressList(v)
							if (parsed.length) return add(parsed)
						}
						setText(v)
					}}
					onKeyDown={e => {
						if (suggestions.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
							e.preventDefault()
							setActive(i => (i + (e.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length)
						} else if (e.key === 'Enter' || e.key === 'Tab') {
							const pick = suggestions[active]
							if (pick) {
								e.preventDefault()
								add([{ name: pick.name, address: pick.address }])
							} else if (text.trim()) {
								e.preventDefault()
								commitText()
							}
						} else if (e.key === 'Backspace' && !text && value.length) {
							onChange(value.slice(0, -1))
						} else if (e.key === 'Escape') setSuggestions([])
					}}
					onBlur={() => setTimeout(commitText, 150)}
					onPaste={e => {
						const pasted = e.clipboardData.getData('text')
						if (/[,;\n]/.test(pasted)) {
							e.preventDefault()
							add(parseAddressList(pasted))
						}
					}}
					className="min-w-[140px] flex-1 bg-transparent py-1 text-sm outline-none"
					aria-label={label}
				/>
			</div>
			{trailing}
			{suggestions.length > 0 && (
				<div className="absolute top-full left-12 z-30 mt-1 w-80 overflow-hidden rounded-xl border border-border bg-overlay shadow-lg">
					{suggestions.map((c, i) => (
						<button
							key={c.address}
							type="button"
							onMouseDown={e => {
								e.preventDefault()
								add([{ name: c.name, address: c.address }])
							}}
							className={`flex w-full flex-col items-start px-3 py-2 text-left ${i === active ? 'bg-default' : ''}`}
						>
							<span className="text-sm text-foreground">{c.name || c.address}</span>
							{c.name && <span className="text-xs text-muted">{c.address}</span>}
						</button>
					))}
				</div>
			)}
		</div>
	)
}
