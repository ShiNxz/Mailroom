'use client'

import { Button, Card, Chip } from '@heroui/react'
import { ArrowLeft, ChevronRight, Fingerprint, Smartphone } from 'lucide-react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Suspense, useEffect, useState } from 'react'
import { BrandMark, useBranding, useBrandingInDocument } from '@/components/Brand'
import { ErrorNote, RecoveryCodes, TotpSetup } from '@/components/security/parts'
import { Loading } from '@/components/ui'
import { api, useMe } from '@/lib/api'
import { addPasskey, passkeyError, passkeysSupported } from '@/lib/webauthn'

// Every account needs a passkey or an authenticator app. A signed-in session without one lands here and
// can't reach anything else until it adds one; then it gets recovery codes and goes on.

function Option({
	icon,
	title,
	text,
	badge,
	onPress,
	disabled,
}: {
	icon: React.ReactNode
	title: string
	text: string
	badge?: string
	onPress: () => void
	disabled?: boolean
}) {
	return (
		<button
			type="button"
			onClick={onPress}
			disabled={disabled}
			className="flex w-full items-center gap-3 rounded-xl border border-border bg-surface p-4 text-left transition-colors hover:border-accent hover:bg-accent/5 disabled:cursor-not-allowed disabled:opacity-50"
		>
			<span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent [&_svg]:size-5">
				{icon}
			</span>
			<span className="min-w-0 flex-1">
				<span className="flex items-center gap-2 text-sm font-medium text-foreground">
					{title}
					{badge && (
						<Chip size="sm" color="accent" variant="soft">
							{badge}
						</Chip>
					)}
				</span>
				<span className="block text-xs text-muted">{text}</span>
			</span>
			<ChevronRight className="size-4 shrink-0 text-muted" />
		</button>
	)
}

function Setup() {
	const router = useRouter()
	const params = useSearchParams()
	const branding = useBranding()
	useBrandingInDocument(branding, 'Protect your account')
	const { data: me, error: meError, mutate } = useMe()
	const [step, setStep] = useState<'choose' | 'totp' | 'codes'>('choose')
	const [codes, setCodes] = useState<string[]>([])
	const [error, setError] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)
	const [canPasskey, setCanPasskey] = useState(true)
	const next = (() => {
		const n = params.get('next')
		return n?.startsWith('/') && !n.startsWith('//') && !n.startsWith('/security') ? n : '/mail'
	})()

	useEffect(() => setCanPasskey(passkeysSupported()), [])
	useEffect(() => {
		if (meError) router.replace(`/login?next=${encodeURIComponent(next)}`)
	}, [meError])
	// Already set up and verified (and not looking at fresh recovery codes): nothing to do here
	useEffect(() => {
		if (me?.security.verified && step === 'choose') router.replace(next)
	}, [me?.security.verified, step])

	const done = (recoveryCodes: string[] | null) => {
		if (recoveryCodes?.length) {
			setCodes(recoveryCodes)
			setStep('codes')
		} else void finish()
	}
	const finish = async () => {
		await mutate()
		router.replace(next)
	}
	const passkey = async () => {
		setBusy(true)
		setError(null)
		try {
			done((await addPasskey()).recoveryCodes)
		} catch (err) {
			setError(passkeyError(err))
		} finally {
			setBusy(false)
		}
	}
	const signOut = async () => {
		await api('/auth/logout', { method: 'POST' }).catch(() => {})
		window.location.href = '/login'
	}

	if (!me) return <Loading />

	// Has a factor but this session never passed it (shouldn't happen, sign-in asks for it): sign in again
	const stuck = me.security.hasFactor && !me.security.verified

	return (
		<main className="flex min-h-dvh items-center justify-center bg-background p-4">
			<Card className="w-full max-w-md">
				<Card.Header className="items-center gap-3 text-center">
					<BrandMark branding={branding} size={44} />
					<Card.Title className="text-xl">
						{step === 'codes' ? 'Save your recovery codes' : 'Protect your account'}
					</Card.Title>
					{step === 'choose' && (
						<Card.Description>
							Everyone who signs in to {branding.name} needs a second step besides the password. Pick one, you can add
							more later in Settings.
						</Card.Description>
					)}
				</Card.Header>
				<Card.Content className="flex flex-col gap-3">
					{stuck ? (
						<>
							<p className="text-sm text-muted">Sign in again with your passkey or authenticator code.</p>
							<Button fullWidth onPress={() => void signOut()}>
								Sign in again
							</Button>
						</>
					) : step === 'choose' ? (
						<>
							<Option
								icon={<Fingerprint />}
								title="Use a passkey"
								badge="Recommended"
								text={
									canPasskey
										? 'Touch ID, Face ID, Windows Hello or a security key. Fastest, and phishing can’t steal it.'
										: 'This browser does not support passkeys.'
								}
								onPress={() => void passkey()}
								disabled={!canPasskey || busy}
							/>
							<Option
								icon={<Smartphone />}
								title="Use an authenticator app"
								text="A 6-digit code from 1Password, Google Authenticator, Authy and others."
								onPress={() => {
									setError(null)
									setStep('totp')
								}}
								disabled={busy}
							/>
							{error && <ErrorNote>{error}</ErrorNote>}
							<button
								type="button"
								onClick={() => void signOut()}
								className="mt-1 text-xs text-muted hover:text-foreground"
							>
								Sign out ({me.user.email})
							</button>
						</>
					) : step === 'totp' ? (
						<>
							<TotpSetup onDone={done} />
							<button
								type="button"
								onClick={() => setStep('choose')}
								className="inline-flex items-center justify-center gap-1 text-xs text-muted hover:text-foreground"
							>
								<ArrowLeft className="size-3" /> Other options
							</button>
						</>
					) : (
						<RecoveryCodes codes={codes} onDone={() => void finish()} />
					)}
				</Card.Content>
			</Card>
		</main>
	)
}

export default function SecuritySetupPage() {
	return (
		<Suspense>
			<Setup />
		</Suspense>
	)
}
