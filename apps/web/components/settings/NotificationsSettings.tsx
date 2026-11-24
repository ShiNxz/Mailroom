'use client'

import type { User } from '@mailroom/shared'
import { Alert, Button, Chip, Description, Label, Switch } from '@heroui/react'
import { formatDistanceToNow } from 'date-fns'
import { BellRing, Download, Smartphone, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import useSWR from 'swr'
import { useBranding } from '@/components/Brand'
import type { PushState } from '@/components/PwaBridge'
import { IconButton } from '@/components/ui'
import { api, fetcher, useBootstrap, useMe } from '@/lib/api'
import {
	canPromptInstall,
	canPush,
	currentSubscription,
	endpointHashOf,
	markPushHere,
	onInstallChange,
	PushDenied,
	promptInstall,
	pushSupport,
	subscribeThisBrowser,
	unsubscribeThisBrowser,
} from '@/lib/pwa'
import { useSaveSettings } from './General'
import { Section } from './Section'

export function NotificationsSettings() {
	return (
		<>
			<PushNotifications />
			<NotifyMailboxes />
			<TabNotifications />
		</>
	)
}

function PushNotifications() {
	const branding = useBranding()
	const { data, mutate } = useSWR<PushState>('/push', fetcher)
	const [hereHash, setHereHash] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)
	const [support, setSupport] = useState<ReturnType<typeof pushSupport> | null>(null)
	const [installable, setInstallable] = useState(false)

	useEffect(() => {
		setSupport(pushSupport())
		setInstallable(canPromptInstall())
		void currentSubscription().then(async s => setHereHash(s ? await endpointHashOf(s.endpoint) : null))
		return onInstallChange(() => setInstallable(canPromptInstall()))
	}, [])

	const here = data?.devices.find(d => d.endpointHash === hereHash)
	const others = data?.devices.filter(d => d !== here) ?? []
	const pushable = support ? canPush(support) : false
	const iosNeedsInstall = support?.ios && !support.standalone
	// Blocked in the browser's own settings: asking again does nothing until the person allows it there
	const blocked = pushable && typeof Notification !== 'undefined' && Notification.permission === 'denied'

	const turnOn = async () => {
		if (!data) return
		setBusy(true)
		try {
			const sub = await subscribeThisBrowser(data.publicKey)
			await api('/push/devices', { body: sub })
			setHereHash(await endpointHashOf(sub.endpoint))
			markPushHere(true)
			await mutate()
			toast.success('Notifications are on for this device')
		} catch (err) {
			toast.error(
				err instanceof PushDenied
					? 'Notifications are blocked for this site. Allow them in the browser settings, then try again.'
					: (err as Error).message,
			)
		} finally {
			setBusy(false)
		}
	}

	const turnOff = async () => {
		setBusy(true)
		try {
			if (here) await api(`/push/devices/${here.id}`, { method: 'DELETE' })
			await unsubscribeThisBrowser()
			setHereHash(null)
			await mutate()
		} catch (err) {
			toast.error((err as Error).message)
		} finally {
			setBusy(false)
		}
	}

	const test = async (id: string) => {
		try {
			await api(`/push/devices/${id}/test`, { body: {} })
			toast.success('Sent. It should show up in a few seconds.')
		} catch (err) {
			toast.error((err as Error).message)
			void mutate()
		}
	}

	return (
		<Section title="Push notifications" description="A notification for each new email, even with the app closed.">
			{(installable || iosNeedsInstall) && (
				<div className="flex items-center gap-3 rounded-xl bg-surface-secondary p-3">
					<Smartphone className="size-5 shrink-0 text-muted" />
					<div className="min-w-0 flex-1 text-sm">
						<div className="font-medium">Install {branding.name}</div>
						<div className="text-xs text-muted">
							{iosNeedsInstall
								? 'On iPhone and iPad, tap Share, then Add to Home Screen. Open it from there to turn on notifications.'
								: 'Get it on your home screen or dock, in its own window.'}
						</div>
					</div>
					{installable && (
						<Button size="sm" variant="secondary" onPress={() => void promptInstall()}>
							<Download className="size-3.5" /> Install
						</Button>
					)}
				</div>
			)}

			<div className="flex items-center justify-between gap-3">
				<div className="min-w-0">
					<h3 className="flex items-center gap-2 text-sm font-medium">
						<BellRing className="size-4 text-muted" /> This device
						{here && (
							<Chip size="sm" color="success" variant="soft">
								On
							</Chip>
						)}
					</h3>
					<p className="text-xs text-muted">
						{!support
							? ''
							: here
								? `${here.label}${here.failing ? ` · last try failed: ${here.lastError ?? ''}` : ''}`
								: blocked
									? "Notifications are blocked for this site. Allow them in the browser's site settings, then come back."
									: pushable
										? 'Off. Turn it on to get a notification for each new email.'
										: iosNeedsInstall
											? 'Add the app to your Home Screen first.'
											: support.secure
												? "This browser can't show push notifications."
												: 'Notifications need the app on https.'}
					</p>
				</div>
				<div className="flex shrink-0 gap-2">
					{here && (
						<Button size="sm" variant="ghost" onPress={() => void test(here.id)}>
							Send a test
						</Button>
					)}
					{here ? (
						<Button size="sm" variant="secondary" onPress={() => void turnOff()} isPending={busy}>
							Turn off
						</Button>
					) : (
						<Button size="sm" onPress={() => void turnOn()} isPending={busy} isDisabled={!pushable || blocked || !data}>
							Turn on
						</Button>
					)}
				</div>
			</div>

			{others.length > 0 && (
				<div className="flex flex-col gap-2 border-t border-separator pt-4">
					<h3 className="text-sm font-medium">Your other devices</h3>
					{others.map(d => (
						<div key={d.id} className="flex items-center gap-3">
							<Smartphone className="size-4 shrink-0 text-muted" />
							<div className="min-w-0 flex-1">
								<div className="truncate text-sm">{d.label}</div>
								<div className="text-xs text-muted">
									{d.lastSentAt
										? `Last notified ${formatDistanceToNow(new Date(d.lastSentAt), { addSuffix: true })}`
										: 'Nothing sent yet'}
									{d.failing && <span className="text-danger"> · failing</span>}
								</div>
							</div>
							<IconButton label="Send a test" onPress={() => void test(d.id)}>
								<BellRing className="size-4" />
							</IconButton>
							<IconButton
								label="Stop notifications there"
								onPress={async () => {
									await api(`/push/devices/${d.id}`, { method: 'DELETE' }).catch(err => toast.error(err.message))
									void mutate()
								}}
							>
								<Trash2 className="size-4" />
							</IconButton>
						</div>
					))}
				</div>
			)}

			{here?.failing && (
				<Alert status="warning">
					<Alert.Indicator />
					<Alert.Content>
						<Alert.Description>
							The last notification to this device didn't go through. Send a test, or turn it off and on again.
						</Alert.Description>
					</Alert.Content>
				</Alert>
			)}
		</Section>
	)
}

/**
 * Which mailboxes send a notification, for all of the person's devices. Only mailboxes they can open are
 * listed; a mailbox they get later notifies until they turn it off.
 */
function NotifyMailboxes() {
	const { data: boot } = useBootstrap()
	const { data: me, mutate } = useMe()
	const projects = (boot?.projects ?? []).filter(p => p.mailboxes.length > 0)
	if (!me || !projects.length) return null
	const muted = new Set(me.user.settings.notifyMuted ?? [])
	const total = projects.reduce((n, p) => n + p.mailboxes.length, 0)
	const on = total - projects.reduce((n, p) => n + p.mailboxes.filter(m => muted.has(m.id)).length, 0)

	const save = async (next: Set<string>) => {
		const notifyMuted = [...next]
		void mutate(
			prev => (prev ? { ...prev, user: { ...prev.user, settings: { ...prev.user.settings, notifyMuted } } } : prev),
			{ revalidate: false },
		)
		try {
			const r = await api<{ user: User }>('/push/muted', { method: 'PUT', body: { muted: notifyMuted } })
			void mutate(prev => (prev ? { ...prev, user: r.user } : prev), { revalidate: false })
		} catch (err) {
			toast.error((err as Error).message)
			void mutate()
		}
	}
	const setMailbox = (id: string, notify: boolean) => {
		const next = new Set(muted)
		if (notify) next.delete(id)
		else next.add(id)
		void save(next)
	}
	const setProject = (ids: string[], notify: boolean) => {
		const next = new Set(muted)
		for (const id of ids) notify ? next.delete(id) : next.add(id)
		void save(next)
	}

	return (
		<Section
			title="Mailboxes"
			description={`${
				on === total
					? 'Every mailbox you can open notifies.'
					: on === 0
						? 'Nothing notifies: every mailbox is off.'
						: `${on} of ${total} mailboxes notify.`
			} Applies to all your devices.`}
		>
			<div className="flex flex-col gap-3">
				{projects.map(p => {
					const ids = p.mailboxes.map(m => m.id)
					const allOn = ids.every(id => !muted.has(id))
					const someOn = ids.some(id => !muted.has(id))
					return (
						<div key={p.id} className="flex flex-col gap-1 rounded-xl border border-separator p-2">
							<NotifySwitch
								label={
									<span className="inline-flex items-center gap-2 font-medium">
										<span className="size-2.5 rounded-[4px]" style={{ background: p.color }} />
										{p.name}
										{someOn && !allOn && <span className="text-xs font-normal text-muted">some</span>}
									</span>
								}
								on={someOn}
								onChange={notify => setProject(ids, notify)}
							/>
							{p.mailboxes.length > 1 &&
								p.mailboxes.map(m => (
									<div key={m.id} className="pl-5">
										<NotifySwitch
											label={<span className="text-foreground/85">{m.address}</span>}
											on={!muted.has(m.id)}
											onChange={notify => setMailbox(m.id, notify)}
										/>
									</div>
								))}
						</div>
					)
				})}
			</div>
		</Section>
	)
}

/** The page's own notification while it is open in a tab (the older, simpler kind). */
function TabNotifications() {
	const { data: me } = useMe()
	const save = useSaveSettings()
	return (
		<Section title="While the app is open">
			<Switch
				isSelected={me?.user.settings.notifications ?? false}
				onChange={async on => {
					if (on && 'Notification' in window && Notification.permission !== 'granted') {
						const p = await Notification.requestPermission()
						if (p !== 'granted') return toast.error('The browser blocked notifications for this site')
					}
					void save({ settings: { notifications: on } })
				}}
			>
				<Switch.Content>
					<Switch.Control>
						<Switch.Thumb />
					</Switch.Control>
					<div className="flex flex-col gap-0.5">
						<Label>Notify from the open tab</Label>
						<Description>For browsers without push. Skipped on a device that already gets push.</Description>
					</div>
				</Switch.Content>
			</Switch>
		</Section>
	)
}

function NotifySwitch({
	label,
	on,
	onChange,
}: {
	label: React.ReactNode
	on: boolean
	onChange: (on: boolean) => void
}) {
	return (
		<Switch isSelected={on} onChange={onChange} className="w-full">
			{/* Content is the clickable part (HeroUI 3.2): the label and the knob both go inside it */}
			<Switch.Content className="flex w-full flex-row items-center justify-between gap-3 px-1 py-1">
				<Label className="text-sm">{label}</Label>
				<Switch.Control>
					<Switch.Thumb />
				</Switch.Control>
			</Switch.Content>
		</Switch>
	)
}
