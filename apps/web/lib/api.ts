import type { Folder, Project, SecurityStatus, User } from '@mailroom/shared'
import { useEffect, useRef } from 'react'
import useSWR, { mutate } from 'swr'

export class ApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly code?: string,
	) {
		super(message)
	}
}

/** JSON request to the API (through the /api proxy). Throws ApiError with the server's message. */
export async function api<T>(
	path: string,
	init: { method?: string; body?: unknown; form?: FormData } = {},
): Promise<T> {
	const res = await fetch(`/api${path}`, {
		method: init.method ?? (init.body !== undefined || init.form ? 'POST' : 'GET'),
		headers: init.form ? undefined : { 'content-type': 'application/json' },
		body: init.form ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
		credentials: 'same-origin',
	})
	const text = await res.text()
	let data: unknown = null
	try {
		data = text ? JSON.parse(text) : null
	} catch {
		data = { error: text }
	}
	if (!res.ok) {
		const body = data as { error?: string; code?: string } | null
		const message = body?.error ?? `Request failed (${res.status})`
		if (typeof window !== 'undefined') {
			const here = encodeURIComponent(window.location.pathname + window.location.search)
			if (res.status === 401 && !path.startsWith('/auth/')) window.location.href = `/login?next=${here}`
			// Signed in, but no passkey or authenticator yet: the only place to go is setting one up
			else if (body?.code === 'mfa_setup_required' && !window.location.pathname.startsWith('/security'))
				window.location.href = `/security/setup?next=${here}`
		}
		throw new ApiError(res.status, message, body?.code)
	}
	return data as T
}

export const fetcher = <T>(path: string) => api<T>(path)

export interface Bootstrap {
	projects: Project[]
	folders: Folder[]
	counts: { drafts: number; scheduled: number; failed: number }
}

export interface Me {
	user: User
	security: SecurityStatus
}

export function useMe() {
	return useSWR<Me>('/auth/me', fetcher, { revalidateOnFocus: false, shouldRetryOnError: false })
}

export function useBootstrap() {
	return useSWR<Bootstrap>('/bootstrap', fetcher, { revalidateOnFocus: true, dedupingInterval: 1000 })
}

// Paged lists (useSWRInfinite) live under "$inf$" keys, which SWR's filter mutate skips on purpose, so
// they register here to hear about refreshes. Without this, a list only refreshed on window focus.
const listRefreshers = new Set<() => void>()

export function useListRefresh(refresh: () => void) {
	const ref = useRef(refresh)
	ref.current = refresh
	useEffect(() => {
		const fn = () => ref.current()
		listRefreshers.add(fn)
		return () => void listRefreshers.delete(fn)
	}, [])
}

/** Revalidates every cached thread list (and optionally open threads). */
export function refreshLists(alsoThreads = false) {
	for (const fn of listRefreshers) fn()
	void mutate(
		key => typeof key === 'string' && (key.startsWith('/threads?') || (alsoThreads && key.startsWith('/threads/'))),
	)
}

export const refreshBootstrap = () => mutate('/bootstrap')
