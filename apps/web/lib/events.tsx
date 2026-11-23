'use client'

import type { ServerEvent } from '@mailroom/shared'
import { useEffect } from 'react'
import { toast } from 'sonner'
import { mutate } from 'swr'
import { refreshBootstrap, refreshLists } from './api'
import { displayName } from './format'

// One EventSource per tab. New mail, flag changes and sync progress revalidate the SWR caches, so every
// list and counter updates without polling. Bursts (a backfill sends many events) are coalesced.

export function useServerEvents(opts: { notifications: boolean }) {
	useEffect(() => {
		let lists: ReturnType<typeof setTimeout> | null = null
		let boot: ReturnType<typeof setTimeout> | null = null
		const soon = (which: 'lists' | 'boot') => {
			if (which === 'lists' && !lists)
				lists = setTimeout(() => {
					lists = null
					refreshLists(true)
				}, 400)
			if (which === 'boot' && !boot)
				boot = setTimeout(() => {
					boot = null
					void refreshBootstrap()
				}, 800)
		}

		const source = new EventSource('/api/events')
		source.onmessage = msg => {
			let event: ServerEvent
			try {
				event = JSON.parse(msg.data)
			} catch {
				return
			}
			switch (event.type) {
				case 'messages':
					soon('lists')
					soon('boot')
					if (
						event.newInbox?.length &&
						opts.notifications &&
						document.hidden &&
						'Notification' in window &&
						Notification.permission === 'granted'
					) {
						for (const m of event.newInbox.slice(0, 3)) {
							const n = new Notification(displayName(m.from), { body: m.subject || '(no subject)', tag: m.messageId })
							n.onclick = () => {
								window.focus()
								n.close()
							}
						}
					}
					break
				case 'mailbox':
				case 'folders':
				case 'access':
					soon('boot')
					break
				case 'branding':
					void mutate('/branding')
					break
				case 'outbox':
					void mutate(key => typeof key === 'string' && key.startsWith('/outbox'))
					soon('boot')
					if (event.status === 'failed')
						toast.error('A message could not be sent', { description: event.error ?? undefined })
					break
			}
		}
		return () => {
			source.close()
			if (lists) clearTimeout(lists)
			if (boot) clearTimeout(boot)
		}
	}, [opts.notifications])
}
