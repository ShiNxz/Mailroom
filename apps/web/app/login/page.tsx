'use client'

import type { LoginResult, MfaMethod } from '@mailroom/shared'
import { Button, Card, Input, Label, Separator, TextField } from '@heroui/react'
import { ArrowLeft, Fingerprint, KeyRound } from 'lucide-react'
import { useRouter, useSearchParams } from 'next/navigation'
import { type FormEvent, Suspense, useEffect, useState } from 'react'
import { BrandMark, useBranding, useBrandingInDocument } from '@/components/Brand'
import { CodeInput, ErrorNote } from '@/components/security/parts'
import { api } from '@/lib/api'
import { passkeyError, passkeySignIn, passkeysSupported } from '@/lib/webauthn'

// Signing in: email and password, then a passkey or a 6-digit code (or a recovery code). A passkey
// alone also signs in. Accounts without a second factor yet go on to set one up.

function LoginForm() {
	const router = useRouter()
	const params = useSearchParams()
	const branding = useBranding()
	useBrandingInDocument(branding, 'Sign in')
	const [needsSetup, setNeedsSetup] = useState<boolean | null>(null)
	const [tokenRequired, setTokenRequired] = useState(false)
	const [token, setToken] = useState('')
	const [name, setName] = useState('')
	const [email, setEmail] = useState('')
	const [password, setPassword] = useState('')
	const [error, setError] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)
	const [second, setSecond] = useState<{ ticket: string; methods: MfaMethod[] } | null>(null)
	const [code, setCode] = useState('')
	const [useRecovery, setUseRecovery] = useState(false)
	const [canPasskey, setCanPasskey] = useState(false)

	useEffect(() => {
		setCanPasskey(passkeysSupported())
		api<{ needsSetup: boolean; setupTokenRequired: boolean }>('/auth/status')
			.then(s => {
				setNeedsSetup(s.needsSetup)
				setTokenRequired(s.setupTokenRequired)
			})
			.catch(() => setNeedsSetup(false))
	}, [])

	const next = () => {
		const n = params.get('next')
		return n?.startsWith('/') && !n.startsWith('//') ? n : '/mail'
	}

	const after = (r: LoginResult) => {
		if (r.mfa) {
			setSecond(r.mfa)
			setCode('')
			setUseRecovery(!r.mfa.methods.includes('totp') && !r.mfa.methods.includes('passkey'))
			return
		}
		if (r.setupRequired) router.replace(`/security/setup?next=${encodeURIComponent(next())}`)
		else router.replace(next())
	}

	const run = async (fn: () => Promise<void>) => {
		setBusy(true)
		setError(null)
		try {
			await fn()
		} catch (err) {
			// Passkey prompts fail with DOMException names (closed, timed out); server errors carry a message
			setError(passkeyError(err))
		} finally {
			setBusy(false)
		}
	}

	const submit = (e: FormEvent) => {
		e.preventDefault()
		void run(async () => {
			if (needsSetup)
				after(await api<LoginResult>('/auth/setup', { body: { name, email, password, token: token || undefined } }))
			else after(await api<LoginResult>('/auth/login', { body: { email, password } }))
		})
	}

	const submitCode = (value = code) => {
		if (!second || !value.trim()) return
		void run(async () => {
			try {
				after(await api<LoginResult>('/auth/mfa/code', { body: { ticket: second.ticket, code: value } }))
			} catch (err) {
				setCode('')
				// The ticket is used up after a few wrong codes, or after 5 minutes: back to the password
				if ((err as Error).message.includes('Sign in again')) setSecond(null)
				throw err
			}
		})
	}

	const withPasskey = (ticket?: string) => void run(async () => after(await passkeySignIn(ticket)))

	const title = second ? 'Confirm it is you' : needsSetup ? `Set up ${branding.name}` : `Sign in to ${branding.name}`
	const description = second
		? second.methods.includes('passkey') && second.methods.includes('totp')
			? 'Use your passkey, or the code from your authenticator app.'
			: second.methods.includes('passkey')
				? 'Use your passkey to finish signing in.'
				: 'Type the 6-digit code from your authenticator app.'
		: needsSetup
			? 'Create the owner account. You can add people later.'
			: 'Mail for every project, in one place.'

	return (
		<main className="flex min-h-dvh items-center justify-center bg-background p-4">
			<Card className="w-full max-w-sm">
				<Card.Header className="items-center gap-3 text-center">
					<BrandMark branding={branding} size={44} />
					<Card.Title className="text-xl">{title}</Card.Title>
					<Card.Description>{description}</Card.Description>
				</Card.Header>
				<Card.Content>
					{second ? (
						<div className="flex flex-col items-center gap-4">
							{second.methods.includes('passkey') && !useRecovery && (
								<Button fullWidth onPress={() => withPasskey(second.ticket)} isPending={busy} isDisabled={!canPasskey}>
									<Fingerprint className="size-4" /> Use your passkey
								</Button>
							)}
							{second.methods.includes('passkey') && second.methods.includes('totp') && !useRecovery && (
								<div className="flex w-full items-center gap-3 text-xs text-muted">
									<Separator className="flex-1" /> or <Separator className="flex-1" />
								</div>
							)}
							{second.methods.includes('totp') && !useRecovery && (
								<CodeInput
									value={code}
									onChange={setCode}
									onComplete={v => submitCode(v)}
									isInvalid={!!error}
									autoFocus={!second.methods.includes('passkey')}
								/>
							)}
							{useRecovery && (
								<form
									className="flex w-full flex-col gap-3"
									onSubmit={e => {
										e.preventDefault()
										submitCode()
									}}
								>
									<TextField value={code} onChange={setCode} autoFocus>
										<Label>Recovery code</Label>
										<Input placeholder="xxxxx-xxxxx" autoComplete="off" className="font-mono" />
									</TextField>
									<Button type="submit" fullWidth isPending={busy} isDisabled={!code.trim()}>
										Sign in
									</Button>
								</form>
							)}
							{error && <ErrorNote>{error}</ErrorNote>}
							<div className="flex w-full items-center justify-between text-xs">
								<button
									type="button"
									className="inline-flex items-center gap-1 text-muted hover:text-foreground"
									onClick={() => {
										setSecond(null)
										setError(null)
									}}
								>
									<ArrowLeft className="size-3" /> Back
								</button>
								{second.methods.includes('recovery') && (
									<button
										type="button"
										className="text-muted hover:text-foreground"
										onClick={() => {
											setUseRecovery(v => !v)
											setCode('')
											setError(null)
										}}
									>
										{useRecovery ? 'Use your passkey or app' : 'Use a recovery code'}
									</button>
								)}
							</div>
						</div>
					) : (
						<form className="flex flex-col gap-4" onSubmit={submit}>
							{needsSetup && tokenRequired && (
								<TextField value={token} onChange={setToken} isRequired>
									<Label>Setup token</Label>
									<Input placeholder="SETUP_TOKEN from the server settings" autoComplete="off" />
								</TextField>
							)}
							{needsSetup && (
								<TextField value={name} onChange={setName} isRequired autoFocus>
									<Label>Your name</Label>
									<Input placeholder="Amir" />
								</TextField>
							)}
							<TextField value={email} onChange={setEmail} type="email" isRequired autoFocus={!needsSetup}>
								<Label>Email</Label>
								<Input placeholder="you@company.com" autoComplete="username webauthn" />
							</TextField>
							<TextField value={password} onChange={setPassword} type="password" isRequired>
								<Label>Password</Label>
								<Input
									autoComplete={needsSetup ? 'new-password' : 'current-password'}
									placeholder={needsSetup ? 'At least 10 characters' : ''}
								/>
							</TextField>
							{error && <ErrorNote>{error}</ErrorNote>}
							<Button type="submit" fullWidth isPending={busy} isDisabled={needsSetup === null}>
								{needsSetup ? 'Create account' : 'Continue'}
							</Button>
							{needsSetup === false && canPasskey && (
								<>
									<div className="flex items-center gap-3 text-xs text-muted">
										<Separator className="flex-1" /> or <Separator className="flex-1" />
									</div>
									<Button variant="secondary" fullWidth onPress={() => withPasskey()} isDisabled={busy}>
										<KeyRound className="size-4" /> Sign in with a passkey
									</Button>
								</>
							)}
						</form>
					)}
				</Card.Content>
			</Card>
		</main>
	)
}

export default function LoginPage() {
	return (
		<Suspense>
			<LoginForm />
		</Suspense>
	)
}
