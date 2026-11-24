'use client'

// Light, dark or the system's. Stored per browser (mr-theme); app/layout.tsx applies it before the first paint.

import { useEffect, useState } from 'react'

export type ThemeChoice = 'light' | 'dark' | 'system'

const EVENT = 'mr-theme'

export function themeChoice(): ThemeChoice {
	try {
		const t = localStorage.getItem('mr-theme')
		return t === 'light' || t === 'dark' ? t : 'system'
	} catch {
		return 'system'
	}
}

export function setTheme(choice: ThemeChoice) {
	try {
		if (choice === 'system') localStorage.removeItem('mr-theme')
		else localStorage.setItem('mr-theme', choice)
	} catch {}
	const dark = choice === 'system' ? matchMedia('(prefers-color-scheme: dark)').matches : choice === 'dark'
	const root = document.documentElement
	root.classList.toggle('dark', dark)
	root.dataset.theme = dark ? 'dark' : 'light'
	window.dispatchEvent(new Event(EVENT))
}

/** The sidebar's sun/moon button: the other one of light and dark. */
export function toggleTheme() {
	setTheme(document.documentElement.classList.contains('dark') ? 'light' : 'dark')
}

/** The current choice, following changes made anywhere in the app. */
export function useThemeChoice() {
	const [choice, setChoice] = useState<ThemeChoice>('system')
	useEffect(() => {
		const read = () => setChoice(themeChoice())
		read()
		window.addEventListener(EVENT, read)
		return () => window.removeEventListener(EVENT, read)
	}, [])
	return choice
}
