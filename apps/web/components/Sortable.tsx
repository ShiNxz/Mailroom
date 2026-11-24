'use client'

// Drag to reorder (from Seylo's sortable.tsx), for the projects and mailboxes in the sidebar. A drag starts
// after the pointer moves 6 px, so a click still opens the link it lands on, and the click that ends a
// drag is swallowed. The keyboard works too: focus the item's grip (Tab), Space to lift, arrows to move,
// Space to drop, Escape to cancel.

import {
	closestCenter,
	DndContext,
	type DragEndEvent,
	KeyboardSensor,
	type Modifier,
	PointerSensor,
	useSensor,
	useSensors,
} from '@dnd-kit/core'
import {
	arrayMove,
	SortableContext,
	sortableKeyboardCoordinates,
	useSortable,
	verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical } from 'lucide-react'
import { type CSSProperties, createContext, type ReactNode, useContext } from 'react'

/** Never 0: performance.now() starts at 0, so the page's first 250 ms would count as right after a drop. */
let dragOn = false
let lastDragEnd = Number.NEGATIVE_INFINITY

// After a drop dnd-kit stops the click from propagating, but the browser would still follow the link
// under the pointer. These run first: the pointerup that ends a drag is noted, and the click right after
// has its default cancelled. Only a pointer's click (detail >= 1): Enter in a form must still submit.
if (typeof window !== 'undefined') {
	window.addEventListener(
		'pointerup',
		() => {
			if (dragOn) lastDragEnd = performance.now()
		},
		true,
	)
	window.addEventListener(
		'click',
		e => {
			if (e.detail > 0 && performance.now() - lastDragEnd < 250) e.preventDefault()
		},
		true,
	)
}

const verticalOnly: Modifier = ({ transform }) => ({ ...transform, x: 0 })

const Enabled = createContext(true)

export function SortableGroup({
	ids,
	onMove,
	disabled = false,
	children,
}: {
	ids: readonly string[]
	/** The whole new order, after a drop that changed it. */
	onMove: (ids: string[]) => void
	disabled?: boolean
	children: ReactNode
}) {
	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
		useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
	)
	const onDragEnd = ({ active, over }: DragEndEvent) => {
		dragOn = false
		lastDragEnd = performance.now()
		if (!over || active.id === over.id) return
		const from = ids.indexOf(String(active.id))
		const to = ids.indexOf(String(over.id))
		if (from < 0 || to < 0) return
		onMove(arrayMove([...ids], from, to))
	}
	return (
		<Enabled.Provider value={!disabled}>
			<DndContext
				sensors={sensors}
				collisionDetection={closestCenter}
				modifiers={[verticalOnly]}
				onDragStart={() => {
					dragOn = true
				}}
				onDragEnd={onDragEnd}
				onDragCancel={() => {
					dragOn = false
					lastDragEnd = performance.now()
				}}
			>
				<SortableContext items={[...ids]} strategy={verticalListSortingStrategy} disabled={disabled}>
					{children}
				</SortableContext>
			</DndContext>
		</Enabled.Provider>
	)
}

export type SortableItem = ReturnType<typeof useSortableItem>

/**
 * One item of a SortableGroup. `handle` goes on the part a pointer drags (a row, not the list under it);
 * `grip` on a SortableGrip, the item's keyboard handle.
 */
export function useSortableItem(id: string) {
	const enabled = useContext(Enabled)
	const sortable = useSortable({ id, disabled: !enabled })
	const { onKeyDown, onPointerDown } = (sortable.listeners ?? {}) as {
		onKeyDown?: (event: React.KeyboardEvent) => void
		onPointerDown?: (event: React.PointerEvent) => void
	}
	const style: CSSProperties = {
		transform: CSS.Translate.toString(sortable.transform),
		transition: sortable.transition,
		...(sortable.isDragging ? { position: 'relative', zIndex: 20 } : {}),
	}
	return {
		ref: sortable.setNodeRef,
		style,
		dragging: sortable.isDragging,
		enabled,
		handle: {
			...(enabled && onPointerDown ? { onPointerDown } : {}),
			onClickCapture: (event: React.MouseEvent) => {
				if (performance.now() - lastDragEnd < 250) {
					event.preventDefault()
					event.stopPropagation()
				}
			},
		},
		grip: {
			ref: sortable.setActivatorNodeRef,
			...sortable.attributes,
			...(enabled && onKeyDown ? { onKeyDown } : {}),
		},
	}
}

/** The keyboard handle: hidden until it has keyboard focus, then Space lifts the item. */
export function SortableGrip({ grip, name }: { grip: SortableItem['grip']; name: string }) {
	return (
		<button
			type="button"
			{...grip}
			aria-label={`Move ${name}`}
			className="sr-only focus-visible:not-sr-only focus-visible:absolute focus-visible:top-1/2 focus-visible:left-0 focus-visible:z-10 focus-visible:flex focus-visible:size-6 focus-visible:-translate-y-1/2 focus-visible:cursor-grab focus-visible:items-center focus-visible:justify-center focus-visible:rounded-md focus-visible:bg-surface focus-visible:text-foreground focus-visible:shadow-sm"
		>
			<GripVertical className="size-3.5" aria-hidden />
		</button>
	)
}

/** The look of an item while it is lifted. */
export const draggingClass = (dragging: boolean) =>
	dragging ? 'cursor-grabbing rounded-lg bg-surface shadow-lg ring-1 ring-separator' : ''
