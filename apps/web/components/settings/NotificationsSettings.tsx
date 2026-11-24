'use client'

import { Alert, Button, Chip } from '@heroui/react'
import { formatDistanceToNow } from 'date-fns'
import { BellRing, Download, Smartphone, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import useSWR from 'swr'
import { useBranding } from '@/components/Brand'
import type { PushState } from '@/components/PwaBridge'
import { IconButton } from '@/components/ui'
import { api, fetcher } from '@/lib/api'
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
import { Section } from './Section'

export function NotificationsSettings() {
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
		<Section
			title="Notifications"
			description="New mail on your phone and computer, even with the app closed. Only for mailboxes you can open."
		>
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
