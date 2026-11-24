'use client'

// Right-click menus: opened at the pointer, kept inside the window, closed by a click elsewhere,
// Escape, scrolling or resizing. Arrow keys move between items, Enter picks one.

import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface MenuItem {
	id: string
	label: string
	icon?: ReactNode
	danger?: boolean
	disabled?: boolean
	/** A line above this item */
	separator?: boolean
	onSelect: () => void
}

interface MenuState {
	x: number
	y: number
	title?: string
	items: MenuItem[]
}

export function useContextMenu() {
	const [menu, setMenu] = useState<MenuState | null>(null)
	const open = useCallback((e: React.MouseEvent, items: MenuItem[], title?: string) => {
		e.preventDefault()
		e.stopPropagation()
		setMenu({ x: e.clientX, y: e.clientY, items, title })
	}, [])
	const close = useCallback(() => setMenu(null), [])
	return { open, close, element: menu ? <ContextMenu {...menu} onClose={close} /> : null }
}

function ContextMenu({ x, y, title, items, onClose }: MenuState & { onClose: () => void }) {
	const ref = useRef<HTMLDivElement>(null)
	const [pos, setPos] = useState({ left: x, top: y })

	// Keep it inside the window: open to the left or upwards when there is no room
	useLayoutEffect(() => {
		const el = ref.current
		if (!el) return
		const { width, height } = el.getBoundingClientRect()
		const margin = 8
		setPos({
			left: x + width + margin > window.innerWidth ? Math.max(margin, x - width) : x,
			top: y + height + margin > window.innerHeight ? Math.max(margin, y - height) : y,
		})
		el.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
	}, [x, y])

	useEffect(() => {
		const onDown = (e: PointerEvent) => {
			if (!ref.current?.contains(e.target as Node)) onClose()
		}
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') onClose()
		}
		window.addEventListener('pointerdown', onDown, true)
		window.addEventListener('keydown', onKey)
		window.addEventListener('resize', onClose)
		window.addEventListener('scroll', onClose, true)
		window.addEventListener('blur', onClose)
		return () => {
			window.removeEventListener('pointerdown', onDown, true)
			window.removeEventListener('keydown', onKey)
			window.removeEventListener('resize', onClose)
			window.removeEventListener('scroll', onClose, true)
			window.removeEventListener('blur', onClose)
		}
	}, [onClose])

	const move = (e: React.KeyboardEvent) => {
		if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
		e.preventDefault()
		const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
		const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
		const next = e.key === 'ArrowDown' ? (at + 1) % buttons.length : (at - 1 + buttons.length) % buttons.length
		buttons[next]?.focus()
	}

	return createPortal(
		<div
			ref={ref}
			role="menu"
			aria-label={title ?? 'Actions'}
			onKeyDown={move}
			onContextMenu={e => e.preventDefault()}
			className="fixed z-[100] min-w-52 rounded-xl border border-separator bg-surface p-1 shadow-xl"
			style={pos}
		>
			{title && <div className="truncate px-2 pt-1 pb-1.5 text-xs font-medium text-muted">{title}</div>}
			{items.map(item => (
				<div key={item.id}>
					{item.separator && <div className="my-1 h-px bg-separator" />}
					<button
						type="button"
						role="menuitem"
						disabled={item.disabled}
						onClick={() => {
							onClose()
							item.onSelect()
						}}
						className={`flex h-8 w-full items-center gap-2.5 rounded-lg px-2 text-left text-sm outline-none transition-colors disabled:opacity-40 [&_svg]:size-4 [&_svg]:shrink-0 ${
							item.danger
								? 'text-danger hover:bg-danger/10 focus-visible:bg-danger/10'
								: 'text-foreground hover:bg-default focus-visible:bg-default'
						}`}
					>
						<span className={item.danger ? '' : 'text-muted'}>{item.icon}</span>
						{item.label}
					</button>
				</div>
			))}
		</div>,
		document.body,
	)
}
