'use client'

// Pieces the sign-in, the setup screen and Settings share: the 6-digit code input, the authenticator
// app setup (QR code, then a code to confirm) and the recovery codes shown once.

import { Alert, Button, Checkbox, InputOTP, REGEXP_ONLY_DIGITS } from '@heroui/react'
import { Copy, Download } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { copyText } from '@/lib/clipboard'

export function CodeInput({
	value,
	onChange,
	onComplete,
	isInvalid,
	autoFocus = true,
}: {
	value: string
	onChange: (v: string) => void
	onComplete?: (v: string) => void
	isInvalid?: boolean
	autoFocus?: boolean
}) {
	return (
		<InputOTP
			maxLength={6}
			value={value}
			onChange={onChange}
			onComplete={onComplete}
			pattern={REGEXP_ONLY_DIGITS}
			autoFocus={autoFocus}
			isInvalid={isInvalid}
			aria-label="6-digit code"
			autoComplete="one-time-code"
		>
			<InputOTP.Group>
				{[0, 1, 2].map(i => (
					<InputOTP.Slot key={i} index={i} />
				))}
			</InputOTP.Group>
			<InputOTP.Separator />
			<InputOTP.Group>
				{[3, 4, 5].map(i => (
					<InputOTP.Slot key={i} index={i} />
				))}
			</InputOTP.Group>
		</InputOTP>
	)
}

export function ErrorNote({ children }: { children: React.ReactNode }) {
	return (
		<Alert status="danger">
			<Alert.Indicator />
			<Alert.Content>
				<Alert.Description>{children}</Alert.Description>
			</Alert.Content>
		</Alert>
	)
}

/** Authenticator app setup: shows the QR code and secret, then asks for a code to turn it on. */
export function TotpSetup({ onDone }: { onDone: (recoveryCodes: string[] | null) => void }) {
	const [setup, setSetup] = useState<{ qrSvg: string; secret: string } | null>(null)
	const [code, setCode] = useState('')
	const [error, setError] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)

	useEffect(() => {
		api<{ qrSvg: string; secret: string; url: string }>('/auth/totp/setup', { body: {} })
			.then(setSetup)
			.catch(err => setError((err as Error).message))
	}, [])

	const enable = async (value = code) => {
		if (value.length !== 6) return
		setBusy(true)
		setError(null)
		try {
			const r = await api<{ recoveryCodes: string[] | null }>('/auth/totp/enable', { body: { code: value } })
			onDone(r.recoveryCodes)
		} catch (err) {
			setError((err as Error).message)
			setCode('')
		} finally {
			setBusy(false)
		}
	}

	return (
		<div className="flex flex-col items-center gap-4 text-center">
			<p className="text-sm text-muted">
				Scan this with an authenticator app (1Password, Google Authenticator, Authy, Microsoft Authenticator...), then
				type the 6-digit code it shows.
			</p>
			<div className="flex size-44 items-center justify-center rounded-xl bg-white p-2 shadow-sm ring-1 ring-separator">
				{setup ? (
					// The SVG is made by the server from the secret; as an image it can't run anything
					// biome-ignore lint/performance/noImgElement: a data: URL, nothing for next/image to optimize
					<img
						src={`data:image/svg+xml;utf8,${encodeURIComponent(setup.qrSvg)}`}
						alt="QR code for the authenticator app"
						className="size-full"
					/>
				) : (
					<span className="text-xs text-muted">Loading...</span>
				)}
			</div>
			{setup && (
				<details className="w-full text-xs text-muted">
					<summary>Can't scan? Type this key instead</summary>
					<div className="mt-2 flex items-center justify-center gap-2">
						<code className="rounded-md bg-surface-secondary px-2 py-1 font-mono text-foreground select-all">
							{setup.secret}
						</code>
						<Button
							isIconOnly
							size="sm"
							variant="ghost"
							aria-label="Copy the key"
							onPress={async () => {
								if (await copyText(setup.secret.replace(/\s/g, ''))) toast.success('Key copied')
								else toast.error("Couldn't copy. Select the text and copy it instead.")
							}}
						>
							<Copy className="size-3.5" />
						</Button>
					</div>
				</details>
			)}
			<CodeInput value={code} onChange={setCode} onComplete={v => void enable(v)} isInvalid={!!error} />
			{error && <ErrorNote>{error}</ErrorNote>}
			<Button fullWidth onPress={() => void enable()} isPending={busy} isDisabled={code.length !== 6 || !setup}>
				Turn on
			</Button>
		</div>
	)
}

/** Recovery codes, shown once. The person confirms they saved them before going on. */
export function RecoveryCodes({
	codes,
	onDone,
	doneLabel = 'Continue',
}: {
	codes: string[]
	onDone: () => void
	doneLabel?: string
}) {
	const [saved, setSaved] = useState(false)
	const text = `Mailroom recovery codes (each works once)\n\n${codes.join('\n')}\n`
	return (
		<div className="flex flex-col gap-4">
			<p className="text-sm text-muted">
				If you lose your passkey or phone, each of these codes signs you in once. Save them somewhere safe, like your
				password manager. They won't be shown again.
			</p>
			<div className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-xl bg-surface-secondary p-4 font-mono text-sm tabular-nums">
				{codes.map(c => (
					<span key={c} className="select-all">
						{c}
					</span>
				))}
			</div>
			<div className="flex gap-2">
				<Button
					variant="secondary"
					size="sm"
					onPress={async () => {
						if (await copyText(codes.join('\n'))) toast.success('Codes copied')
						else toast.error("Couldn't copy. Select the text and copy it instead.")
					}}
				>
					<Copy className="size-3.5" /> Copy
				</Button>
				<Button
					variant="secondary"
					size="sm"
					onPress={() => {
						const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
						const a = document.createElement('a')
						a.href = url
						a.download = 'mailroom-recovery-codes.txt'
						a.click()
						URL.revokeObjectURL(url)
					}}
				>
					<Download className="size-3.5" /> Download
				</Button>
			</div>
			<Checkbox isSelected={saved} onChange={setSaved}>
				<Checkbox.Content>
					<Checkbox.Control>
						<Checkbox.Indicator />
					</Checkbox.Control>
					<span className="text-sm">I saved these codes</span>
				</Checkbox.Content>
			</Checkbox>
			<Button fullWidth onPress={onDone} isDisabled={!saved}>
				{doneLabel}
			</Button>
		</div>
	)
}
