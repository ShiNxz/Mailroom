'use client'

import { Button, Card, Input, Label, TextField } from '@heroui/react'
import { CheckCircle2, Laptop, XCircle } from 'lucide-react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Suspense, useEffect, useState } from 'react'
import { BrandMark, useBranding, useBrandingInDocument } from '@/components/Brand'
import { ErrorNote } from '@/components/security/parts'
import { Loading } from '@/components/ui'
import { api, useMe } from '@/lib/api'

// The Mac app signs in through the browser: it shows a code and opens this page. Someone signed in here
// (with their passkey or code) checks the code matches and approves, and the app gets its own session.

function DeviceApproval() {
	const router = useRouter()
	const params = useSearchParams()
	const branding = useBranding()
	useBrandingInDocument(branding, 'Sign in a device')
	const { data: me, error: meError } = useMe()
	const [code, setCode] = useState(params.get('code') ?? '')
	const [request, setRequest] = useState<{ device: string; status: string } | null>(null)
	const [answer, setAnswer] = useState<'approved' | 'denied' | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)
	const here = `/device${code ? `?code=${encodeURIComponent(code)}` : ''}`

	useEffect(() => {
		if (meError) router.replace(`/login?next=${encodeURIComponent(here)}`)
		else if (me && !me.security.verified) router.replace(`/security/setup?next=${encodeURIComponent(here)}`)
	}, [me, meError])

	const look = async (value = code) => {
		if (!value.trim()) return
		setBusy(true)
		setError(null)
		try {
			setRequest(await api<{ device: string; status: string }>(`/auth/device/${encodeURIComponent(value.trim())}`))
		} catch (err) {
			setRequest(null)
			setError((err as Error).message)
		} finally {
			setBusy(false)
		}
	}
	useEffect(() => {
		if (me?.security.verified && params.get('code')) void look(params.get('code')!)
	}, [me?.security.verified])

	const respond = async (approve: boolean) => {
		setBusy(true)
		setError(null)
		try {
			await api(`/auth/device/${encodeURIComponent(code.trim())}`, { body: { approve } })
			setAnswer(approve ? 'approved' : 'denied')
		} catch (err) {
			setError((err as Error).message)
		} finally {
			setBusy(false)
		}
	}

	if (!me?.security.verified) return <Loading />

	return (
		<main className="flex min-h-dvh items-center justify-center bg-background p-4">
			<Card className="w-full max-w-sm">
				<Card.Header className="items-center gap-3 text-center">
					<BrandMark branding={branding} size={44} />
					<Card.Title className="text-xl">Sign in a device</Card.Title>
					<Card.Description>Signed in as {me.user.email}</Card.Description>
				</Card.Header>
				<Card.Content className="flex flex-col gap-4">
					{answer === 'approved' ? (
						<div className="flex flex-col items-center gap-2 text-center">
							<CheckCircle2 className="size-10 text-success" />
							<p className="text-sm">Done. {request?.device ?? 'The app'} is signing in, you can go back to it.</p>
						</div>
					) : answer === 'denied' ? (
						<div className="flex flex-col items-center gap-2 text-center">
							<XCircle className="size-10 text-danger" />
							<p className="text-sm">Refused. Nothing was signed in.</p>
						</div>
					) : request ? (
						<>
							<div className="flex items-center gap-3 rounded-xl bg-surface-secondary p-3">
								<Laptop className="size-6 shrink-0 text-muted" />
								<div className="min-w-0">
									<div className="truncate text-sm font-medium">{request.device}</div>
									<div className="text-xs text-muted">wants to sign in to your account</div>
								</div>
							</div>
							<p className="text-center text-sm">
								Check that the app shows this code:
								<span className="mt-1 block font-mono text-2xl font-semibold tracking-widest">
									{code.toUpperCase()}
								</span>
							</p>
							<p className="text-center text-xs text-muted">
								Only approve if you started this sign-in yourself. If someone sent you this link, refuse it.
							</p>
							{error && <ErrorNote>{error}</ErrorNote>}
							<div className="flex gap-2">
								<Button variant="secondary" className="flex-1" onPress={() => void respond(false)} isDisabled={busy}>
									Refuse
								</Button>
								<Button className="flex-1" onPress={() => void respond(true)} isPending={busy}>
									Approve
								</Button>
							</div>
						</>
					) : (
						<form
							className="flex flex-col gap-3"
							onSubmit={e => {
								e.preventDefault()
								void look()
							}}
						>
							<TextField value={code} onChange={setCode} autoFocus>
								<Label>Code shown in the app</Label>
								<Input placeholder="XXXX-XXXX" className="font-mono uppercase" autoComplete="off" />
							</TextField>
							{error && <ErrorNote>{error}</ErrorNote>}
							<Button type="submit" fullWidth isPending={busy} isDisabled={!code.trim()}>
								Continue
							</Button>
						</form>
					)}
				</Card.Content>
			</Card>
		</main>
	)
}

export default function DevicePage() {
	return (
		<Suspense>
			<DeviceApproval />
		</Suspense>
	)
}
