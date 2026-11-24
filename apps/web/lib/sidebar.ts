'use client'

// The person's own sidebar: their order of projects and of each project's mailboxes, and what they
// hid. Changes show at once (the cached /auth/me is patched) and are saved to /me/sidebar, so they
// follow the person to every browser. A failed save refetches, so the screen matches the server again.

import type { SidebarPrefs, User } from '@mailroom/shared'
import { toast } from 'sonner'
import { api, useMe } from './api'

/** `list` in `order` (by id); ids not in it keep their place after the known ones. */
export function ordered<T extends { id: string }>(list: readonly T[], order: readonly string[] | undefined): T[] {
	if (!order?.length) return [...list]
	const rank = new Map(order.map((id, i) => [id, i]))
	return list
		.map((item, i) => ({ item, i }))
		.sort((a, b) => (rank.get(a.item.id) ?? order.length + a.i) - (rank.get(b.item.id) ?? order.length + b.i))
		.map(x => x.item)
}

export function useSidebarPrefs() {
	const { data: me, mutate } = useMe()
	const prefs: SidebarPrefs = me?.user.settings.sidebar ?? {}

	const save = async (patch: SidebarPrefs) => {
		void mutate(
			prev =>
				prev
					? {
							...prev,
							user: {
								...prev.user,
								settings: { ...prev.user.settings, sidebar: { ...prev.user.settings.sidebar, ...patch } },
							},
						}
					: prev,
			{ revalidate: false },
		)
		try {
			const r = await api<{ user: User }>('/me/sidebar', { method: 'PUT', body: patch })
			void mutate(prev => (prev ? { ...prev, user: r.user } : prev), { revalidate: false })
		} catch (err) {
			toast.error(`Could not save the sidebar: ${(err as Error).message}`)
			void mutate()
		}
	}

	const toggle = (list: string[] | undefined, id: string, on: boolean) => {
		const set = new Set(list ?? [])
		if (on) set.add(id)
		else set.delete(id)
		return [...set]
	}

	return {
		prefs,
		hiddenProjects: new Set(prefs.hiddenProjects ?? []),
		hiddenMailboxes: new Set(prefs.hiddenMailboxes ?? []),
		/** The projects on screen in their new order; hidden ones keep their places after them. */
		setProjectOrder: (ids: string[], all: string[]) => {
			const shown = new Set(ids)
			void save({ projectOrder: [...ids, ...all.filter(id => !shown.has(id))] })
		},
		setMailboxOrder: (projectId: string, ids: string[], all: string[]) => {
			const shown = new Set(ids)
			void save({ mailboxOrder: { [projectId]: [...ids, ...all.filter(id => !shown.has(id))] } })
		},
		setProjectHidden: (id: string, hide: boolean) =>
			void save({ hiddenProjects: toggle(prefs.hiddenProjects, id, hide) }),
		setMailboxHidden: (id: string, hide: boolean) =>
			void save({ hiddenMailboxes: toggle(prefs.hiddenMailboxes, id, hide) }),
	}
}
