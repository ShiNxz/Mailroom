import type { LoginResult } from '@mailroom/shared'
import {
	browserSupportsWebAuthn,
	type PublicKeyCredentialCreationOptionsJSON,
	type PublicKeyCredentialRequestOptionsJSON,
	startAuthentication,
	startRegistration,
} from '@simplewebauthn/browser'
import { api } from './api'

export const passkeysSupported = () => typeof window !== 'undefined' && browserSupportsWebAuthn()

/** A name for a new passkey from the device it is made on, like "Chrome on Mac". */
export function deviceName() {
	if (typeof navigator === 'undefined') return 'Passkey'
	const ua = navigator.userAgent
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
						: /Linux/.test(ua)
							? 'Linux'
							: 'this device'
	const browser = /Edg\//.test(ua)
		? 'Edge'
		: /Firefox\//.test(ua)
			? 'Firefox'
			: /Chrome\//.test(ua)
				? 'Chrome'
				: /Safari\//.test(ua)
					? 'Safari'
					: ''
	return browser ? `${browser} on ${os}` : os
}

/** Turns WebAuthn's errors into something to show. Cancelling is common and not really an error. */
export function passkeyError(err: unknown) {
	const name = (err as { name?: string })?.name
	if (name === 'NotAllowedError' || name === 'AbortError') return 'The passkey prompt was closed or timed out.'
	if (name === 'InvalidStateError') return 'This device already has a passkey for your account.'
	if (name === 'SecurityError') return 'Passkeys need the app to be opened on its own address over https.'
	return (err as Error)?.message ?? 'The passkey did not work'
}

export async function addPasskey(name = deviceName()) {
	const optionsJSON = await api<PublicKeyCredentialCreationOptionsJSON>('/auth/passkeys/options', { body: {} })
	const response = await startRegistration({ optionsJSON })
	return api<{ recoveryCodes: string[] | null }>('/auth/passkeys', { body: { response, name } })
}

/** With a ticket it is the second step after the password; without one it is the whole sign-in. */
export async function passkeySignIn(ticket?: string) {
	const { challengeId, options } = await api<{ challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }>(
		'/auth/passkey/options',
		{ body: { ticket } },
	)
	const response = await startAuthentication({ optionsJSON: options })
	return api<LoginResult>('/auth/passkey/verify', { body: { challengeId, response, ticket } })
}
