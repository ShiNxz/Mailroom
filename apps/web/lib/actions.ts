import type { Address, Message } from '@mailroom/shared'
import { addDays, addHours, format, nextMonday, nextSaturday, setHours, setMinutes, startOfDay } from 'date-fns'
import { toast } from 'sonner'
import type { ComposeDraft } from '@/components/compose/context'
import { api, refreshBootstrap, refreshLists } from './api'
import { displayName, fullDate } from './format'

export type ThreadAction =
	| 'read'
	| 'unread'
	| 'star'
	| 'unstar'
	| 'archive'
	| 'trash'
	| 'spam'
	| 'notspam'
	| 'inbox'
	| 'move'
	| 'snooze'
	| 'unsnooze'
	| 'delete'

const DONE: Partial<Record<ThreadAction, string>> = {
	archive: 'Archived',
	trash: 'Moved to Trash',
	spam: 'Marked as spam',
	notspam: 'Moved to Inbox',
	inbox: 'Moved to Inbox',
	move: 'Moved',
	snooze: 'Snoozed',
	delete: 'Deleted forever',
}

/** Actions that take the thread out of the list it is in. */
export const REMOVES: ThreadAction[] = [
	'archive',
	'trash',
	'spam',
	'notspam',
	'inbox',
	'move',
	'snooze',
	'delete',
	'unsnooze',
]

export async function threadAction(
	threadIds: string[],
	action: ThreadAction,
	extra: { folderId?: string; until?: Date } = {},
) {
	try {
		await api('/threads/actions', {
			body: { threadIds, action, folderId: extra.folderId, until: extra.until?.toISOString() },
		})
		const msg = DONE[action]
		if (msg) {
			const undo =
				action === 'archive' || action === 'trash' || action === 'spam'
					? () => void threadAction(threadIds, 'inbox')
					: action === 'snooze'
						? () => void threadAction(threadIds, 'unsnooze')
						: undefined
			toast(
				`${msg}${threadIds.length > 1 ? ` (${threadIds.length})` : ''}${action === 'snooze' && extra.until ? ` until ${format(extra.until, "EEE 'at' HH:mm")}` : ''}`,
				undo ? { action: { label: 'Undo', onClick: undo } } : undefined,
			)
		}
	} catch (err) {
		toast.error((err as Error).message)
	} finally {
		refreshLists(true)
		void refreshBootstrap()
	}
}

export function snoozeOptions() {
	const now = new Date()
	const at = (d: Date, h: number) => setMinutes(setHours(startOfDay(d), h), 0)
	const list = [
		{ id: 'tomorrow', label: 'Tomorrow', date: at(addDays(now, 1), 8) },
		{ id: 'weekend', label: 'This weekend', date: at(nextSaturday(now), 9) },
		{ id: 'week', label: 'Next week', date: at(nextMonday(now), 8) },
	]
	if (now.getHours() < 18) list.unshift({ id: 'later', label: 'Later today', date: setMinutes(addHours(now, 3), 0) })
	return list
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const addr = (a: Address) => (a.name ? `${esc(a.name)} &lt;${esc(a.address)}&gt;` : esc(a.address))

/** Composer prefill for reply, reply all and forward. */
export function replyDraft(
	kind: 'reply' | 'replyAll' | 'forward',
	m: Message,
	myAddresses: Set<string>,
): Partial<ComposeDraft> {
	const subject = m.subject || ''
	if (kind === 'forward') {
		const header = [
			'---------- Forwarded message ---------',
			`From: ${addr(m.from)}`,
			`Date: ${esc(fullDate(m.date))}`,
			`Subject: ${esc(subject)}`,
			`To: ${m.to.map(addr).join(', ')}`,
			...(m.cc.length ? [`Cc: ${m.cc.map(addr).join(', ')}`] : []),
		].join('<br>')
		return {
			title: 'Forward',
			mailboxId: m.mailboxId,
			subject: /^fwd?:/i.test(subject) ? subject : `Fwd: ${subject}`,
			quoted: `<div>${header}<br><br>${m.html ?? ''}</div>`,
			forwardOfMessageId: m.id,
			forwardAttachments: m.attachments.filter(a => !a.inline),
		}
	}
	const fromMe = myAddresses.has(m.from.address)
	const primary = fromMe ? m.to : m.replyTo.length ? m.replyTo : [m.from]
	let to = primary
	let cc: Address[] = []
	if (kind === 'replyAll') {
		const seen = new Set<string>(primary.map(a => a.address))
		const notMe = (a: Address) => {
			if (myAddresses.has(a.address) || seen.has(a.address)) return false
			seen.add(a.address)
			return true
		}
		to = [...primary, ...(fromMe ? [] : m.to.filter(notMe))]
		cc = m.cc.filter(notMe)
	}
	return {
		title: kind === 'replyAll' ? 'Reply all' : 'Reply',
		mailboxId: m.mailboxId,
		to,
		cc,
		subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
		// Gmail's own quote markup, so Gmail (and Mailroom) fold the history away in the reply
		quoted: `<div class="gmail_quote"><div class="gmail_attr">On ${esc(fullDate(m.date))}, ${addr(m.from)} wrote:</div><blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${m.html ?? ''}</blockquote></div>`,
		replyToMessageId: m.id,
	}
}

export const whoLine = (list: Address[], me: Set<string>) =>
	list.map(a => (me.has(a.address) ? 'me' : displayName(a))).join(', ')
