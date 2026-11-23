import type { Address } from '@mailroom/shared'
import { format, isThisYear, isToday, isYesterday } from 'date-fns'

export function listDate(iso: string) {
	const d = new Date(iso)
	if (isToday(d)) return format(d, 'HH:mm')
	if (isYesterday(d)) return 'Yesterday'
	if (isThisYear(d)) return format(d, 'MMM d')
	return format(d, 'dd/MM/yy')
}

export const fullDate = (iso: string) => format(new Date(iso), "EEE, MMM d, yyyy 'at' HH:mm")

export const displayName = (a: Address) => a.name || a.address.split('@')[0] || a.address

export function initials(a: Address) {
	const source = a.name || a.address
	const parts = source
		.replace(/[^\p{L}\p{N} ]/gu, ' ')
		.trim()
		.split(/\s+/)
	return ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '')).toUpperCase()
}

/** A stable color per address, for avatars. */
export function colorFor(value: string) {
	let h = 0
	for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) >>> 0
	return `oklch(0.62 0.13 ${h % 360})`
}

export function fileSize(bytes: number) {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function parseAddressList(input: string): Address[] {
	return input
		.split(/[,;\n]+/)
		.map(s => s.trim())
		.filter(Boolean)
		.map(s => {
			const m = s.match(/^(.*)<([^>]+)>$/)
			if (m) return { name: m[1]!.trim().replace(/^"|"$/g, ''), address: m[2]!.trim().toLowerCase() }
			return { name: '', address: s.toLowerCase() }
		})
}

export const isEmail = (s: string) => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(s)
