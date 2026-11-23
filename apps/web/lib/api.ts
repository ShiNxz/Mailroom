import type { Folder, Project, User } from '@mailroom/shared'
import useSWR, { mutate } from 'swr'

export class ApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
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
		const message = (data as { error?: string } | null)?.error ?? `Request failed (${res.status})`
		if (res.status === 401 && typeof window !== 'undefined' && !path.startsWith('/auth/')) {
			window.location.href = `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`
		}
		throw new ApiError(res.status, message)
	}
	return data as T
}

export const fetcher = <T>(path: string) => api<T>(path)

export interface Bootstrap {
	projects: Project[]
	folders: Folder[]
	counts: { drafts: number; scheduled: number; failed: number }
}

export function useMe() {
	return useSWR<{ user: User }>('/auth/me', fetcher, { revalidateOnFocus: false, shouldRetryOnError: false })
}

export function useBootstrap() {
	return useSWR<Bootstrap>('/bootstrap', fetcher, { revalidateOnFocus: true, dedupingInterval: 1000 })
}

/** Revalidates every cached thread list (and optionally open threads). */
export function refreshLists(alsoThreads = false) {
	void mutate(
		key => typeof key === 'string' && (key.startsWith('/threads?') || (alsoThreads && key.startsWith('/threads/'))),
	)
}

export const refreshBootstrap = () => mutate('/bootstrap')
