'use client'

import { Alert, Button, Card, Input, Label, TextField } from '@heroui/react'
import { useRouter, useSearchParams } from 'next/navigation'
import { type FormEvent, Suspense, useEffect, useState } from 'react'
import { BrandMark, useBranding, useBrandingInDocument } from '@/components/Brand'
import { api } from '@/lib/api'

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

	useEffect(() => {
		api<{ needsSetup: boolean; setupTokenRequired: boolean }>('/auth/status')
			.then(s => {
				setNeedsSetup(s.needsSetup)
				setTokenRequired(s.setupTokenRequired)
			})
			.catch(() => setNeedsSetup(false))
	}, [])

	const submit = async (e: FormEvent) => {
		e.preventDefault()
		setBusy(true)
		setError(null)
		try {
			if (needsSetup) await api('/auth/setup', { body: { name, email, password, token: token || undefined } })
			else await api('/auth/login', { body: { email, password } })
			const next = params.get('next')
			router.replace(next?.startsWith('/') ? next : '/mail')
		} catch (err) {
			setError((err as Error).message)
		} finally {
			setBusy(false)
		}
	}

	return (
		<main className="flex min-h-dvh items-center justify-center bg-background p-4">
			<Card className="w-full max-w-sm">
				<Card.Header className="items-center gap-3 text-center">
					<BrandMark branding={branding} size={44} />
					<Card.Title className="text-xl">
						{needsSetup ? `Set up ${branding.name}` : `Sign in to ${branding.name}`}
					</Card.Title>
					<Card.Description>
						{needsSetup
							? 'Create the owner account. You can add people later.'
							: 'Mail for every project, in one place.'}
					</Card.Description>
				</Card.Header>
				<Card.Content>
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
							<Input placeholder="you@company.com" autoComplete="username" />
						</TextField>
						<TextField value={password} onChange={setPassword} type="password" isRequired>
							<Label>Password</Label>
							<Input
								autoComplete={needsSetup ? 'new-password' : 'current-password'}
								placeholder={needsSetup ? 'At least 10 characters' : ''}
							/>
						</TextField>
						{error && (
							<Alert status="danger">
								<Alert.Indicator />
								<Alert.Content>
									<Alert.Description>{error}</Alert.Description>
								</Alert.Content>
							</Alert>
						)}
						<Button type="submit" fullWidth isPending={busy} isDisabled={needsSetup === null}>
							{needsSetup ? 'Create account' : 'Sign in'}
						</Button>
					</form>
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
