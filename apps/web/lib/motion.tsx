'use client'

// Motion for the app, the way Seylo does it: one provider at the root and a few shared pieces.
// Components use m.* from "motion/react" (never motion.*): LazyMotion keeps the animation code out of the
// first bundle. reducedMotion="user" turns movement off for people who ask their system for less motion.

import { domMax, LazyMotion, MotionConfig, m, type Transition, useReducedMotionConfig } from 'motion/react'
import { type ReactNode, useState } from 'react'

export function MotionProvider({ children }: { children: ReactNode }) {
	return (
		<LazyMotion features={domMax} strict>
			<MotionConfig reducedMotion="user">{children}</MotionConfig>
		</LazyMotion>
	)
}

/** How a selection background slides to the clicked item: quick, with no overshoot. */
export const slideTransition: Transition = { type: 'spring', bounce: 0, visualDuration: 0.2 }

let indicatorMounts = 0

/**
 * The background of the selected row. Render it inside the selected row only; rows sharing a layoutId
 * form one group and the background slides between them. The row needs `relative isolate`.
 * Each indicator gets its own layoutDependency so it only animates when the selection moves, not when
 * content above it loads and shifts it.
 */
export function ActiveIndicator({ layoutId, className = '' }: { layoutId: string; className?: string }) {
	const [mounted] = useState(() => ++indicatorMounts)
	return (
		<m.span
			aria-hidden
			layoutId={layoutId}
			layoutDependency={mounted}
			transition={slideTransition}
			className={`pointer-events-none absolute inset-0 -z-10 ${className}`}
		/>
	)
}

/**
 * Content that fades in with a small rise whenever `motionKey` changes (another mailbox, project or
 * folder). Enter only: the old content goes at once, so switching never waits. The first render and
 * reduced motion do not animate.
 */
export function EnterOnChange({
	motionKey,
	className,
	children,
}: {
	motionKey: string
	className?: string
	children: ReactNode
}) {
	const reduced = useReducedMotionConfig()
	const [seen, setSeen] = useState({ key: motionKey, changed: false })
	if (seen.key !== motionKey) setSeen({ key: motionKey, changed: true })
	const enter = seen.changed && !reduced
	return (
		<m.div
			key={motionKey}
			// From 40% opacity, not 0: readable on its first frame and still eases in
			initial={enter ? { opacity: 0.4, y: 5 } : false}
			animate={{ opacity: 1, y: 0 }}
			transition={{ duration: 0.16, ease: 'easeOut' }}
			className={className}
		>
			{children}
		</m.div>
	)
}
