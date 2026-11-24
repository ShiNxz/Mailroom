'use client'

// The installable app and push notifications in the browser (the same approach as Seylo's panel). The
// service worker (public/sw.js) only shows pushes and opens their conversation; it caches nothing.
// A device is added only when the person turns notifications on in Settings; a subscription this browser
// still holds but the server no longer knows (signed out, removed elsewhere) is dropped, never re-added.

export interface PushSupport {
	secure: boolean
	serviceWorker: boolean
	pushManager: boolean
	notifications: boolean
	/** Opened as the installed app, not a browser tab */
	standalone: boolean
	/** iPhone or iPad: push only works in the installed app there (iOS 16.4+) */
	ios: boolean
}

export function pushSupport(): PushSupport {
	const nav = navigator as Navigator & { standalone?: boolean }
	const ios = /iPhone|iPad|iPod/.test(nav.userAgent) || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1)
	return {
		secure: window.isSecureContext,
		serviceWorker: 'serviceWorker' in navigator,
		pushManager: 'PushManager' in window,
		notifications: 'Notification' in window,
		standalone: window.matchMedia?.('(display-mode: standalone)').matches === true || nav.standalone === true,
		ios,
	}
}

export const canPush = (s: PushSupport = pushSupport()) =>
	s.secure && s.serviceWorker && s.pushManager && s.notifications

export async function workerRegistration(register: boolean): Promise<ServiceWorkerRegistration | null> {
	if (!('serviceWorker' in navigator)) return null
	const existing = await navigator.serviceWorker.getRegistration('/')
	if (existing || !register) return existing ?? null
	return navigator.serviceWorker.register('/sw.js', { scope: '/' })
}

export async function currentSubscription(): Promise<PushSubscription | null> {
	const registration = await workerRegistration(false)
	return (await registration?.pushManager.getSubscription()) ?? null
}

/** SHA-256 of the endpoint, hex: how the server's list names this browser. */
export async function endpointHashOf(endpoint: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint))
	return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
	const base64 = text
		.replace(/-/g, '+')
		.replace(/_/g, '/')
		.padEnd(Math.ceil(text.length / 4) * 4, '=')
	const raw = atob(base64)
	const bytes = new Uint8Array(new ArrayBuffer(raw.length))
	for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
	return bytes
}

function toBase64Url(buffer: ArrayBuffer | null): string {
	if (!buffer) return ''
	return btoa(String.fromCharCode(...new Uint8Array(buffer)))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '')
}

const madeWith = (s: PushSubscription, publicKey: string) => toBase64Url(s.options.applicationServerKey) === publicKey

/** "Chrome on Mac", "Safari on iPhone"... the name this device gets in the list. */
export function deviceLabel(ua = navigator.userAgent) {
	const os = /iPhone/.test(ua)
		? 'iPhone'
		: /iPad/.test(ua)
			? 'iPad'
			: /Android/.test(ua)
				? 'Android'
				: /Mac OS X/.test(ua)
					? 'Mac'
					: /Windows/.test(ua)
						? 'Windows'
						: 'Linux'
	const browser = /Edg\//.test(ua)
		? 'Edge'
		: /Firefox\//.test(ua)
			? 'Firefox'
			: /Chrome\//.test(ua)
				? 'Chrome'
				: 'Safari'
	const app = pushSupport().standalone ? 'App' : browser
	return `${app} on ${os}`
}

export class PushDenied extends Error {}

/** Asks for permission (call it from a click) and subscribes this browser with the server's key. */
export async function subscribeThisBrowser(publicKey: string) {
	const permission = await Notification.requestPermission()
	if (permission !== 'granted') throw new PushDenied(permission)
	const registration = await workerRegistration(true)
	if (!registration) throw new Error('This browser has no service workers.')
	await navigator.serviceWorker.ready
	const old = await registration.pushManager.getSubscription()
	if (old && !madeWith(old, publicKey)) await old.unsubscribe()
	const subscription =
		(old && madeWith(old, publicKey) ? old : null) ??
		(await registration.pushManager.subscribe({
			userVisibleOnly: true,
			applicationServerKey: fromBase64Url(publicKey),
		}))
	return {
		endpoint: subscription.endpoint,
		p256dh: toBase64Url(subscription.getKey('p256dh')),
		auth: toBase64Url(subscription.getKey('auth')),
		label: deviceLabel(),
	}
}

export async function unsubscribeThisBrowser() {
	await (await currentSubscription())?.unsubscribe()
	markPushHere(false)
}

/** Remembered per browser so the open tab doesn't also show its own notification for the same mail. */
export function markPushHere(on: boolean) {
	try {
		if (on) localStorage.setItem('mr-push', '1')
		else localStorage.removeItem('mr-push')
	} catch {}
}
export function pushIsOnHere() {
	try {
		return localStorage.getItem('mr-push') === '1'
	} catch {
		return false
	}
}

/**
 * Brings this browser in line with the server: drops a subscription it no longer knows (signed out,
 * removed on another device, a new key). Returns whether this browser gets pushes.
 */
export async function syncThisBrowser(devices: { endpointHash: string }[], publicKey: string): Promise<boolean> {
	if (!canPush()) return false
	const subscription = await currentSubscription()
	if (!subscription) {
		markPushHere(false)
		return false
	}
	const hash = await endpointHashOf(subscription.endpoint)
	if (!devices.some(d => d.endpointHash === hash) || !madeWith(subscription, publicKey)) {
		await subscription.unsubscribe().catch(() => false)
		markPushHere(false)
		return false
	}
	markPushHere(true)
	return true
}

// --- Install prompt (Chrome, Edge, Android) ------------------------------------------------------

type InstallPrompt = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }
let installPrompt: InstallPrompt | null = null
const installListeners = new Set<() => void>()

if (typeof window !== 'undefined') {
	window.addEventListener('beforeinstallprompt', event => {
		event.preventDefault()
		installPrompt = event as InstallPrompt
		for (const l of installListeners) l()
	})
	window.addEventListener('appinstalled', () => {
		installPrompt = null
		for (const l of installListeners) l()
	})
}

export const canPromptInstall = () => installPrompt !== null
export function onInstallChange(listener: () => void) {
	installListeners.add(listener)
	return () => void installListeners.delete(listener)
}
export async function promptInstall() {
	if (!installPrompt) return false
	await installPrompt.prompt()
	const { outcome } = await installPrompt.userChoice
	installPrompt = null
	for (const l of installListeners) l()
	return outcome === 'accepted'
}
