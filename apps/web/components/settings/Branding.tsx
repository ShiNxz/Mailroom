'use client'

import { type Branding, DEFAULT_BRANDING } from '@mailroom/shared'
import { Button, Description, Input, Label, TextField } from '@heroui/react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { mutate } from 'swr'
import { BrandMark, useBranding } from '@/components/Brand'
import { api } from '@/lib/api'
import { Section } from './Section'

export function BrandingSettings() {
	const current = useBranding()
	const [name, setName] = useState(current.name)
	const [logoUrl, setLogoUrl] = useState(current.logoUrl ?? '')
	const [busy, setBusy] = useState(false)

	// Fill the form once the saved branding has loaded
	useEffect(() => {
		setName(current.name)
		setLogoUrl(current.logoUrl ?? '')
	}, [current.name, current.logoUrl])

	const preview: Branding = { name: name.trim() || DEFAULT_BRANDING.name, logoUrl: logoUrl.trim() || null }
	const changed = preview.name !== current.name || preview.logoUrl !== current.logoUrl

	const save = async (value: Branding) => {
		setBusy(true)
		try {
			const saved = await api<Branding>('/admin/branding', { method: 'PUT', body: value })
			void mutate('/branding', saved, { revalidate: false })
			toast.success('Branding saved for everyone')
		} catch (err) {
			toast.error((err as Error).message)
		} finally {
			setBusy(false)
		}
	}

	return (
		<Section title="Name and logo" description="Shown instead of Mailroom. Leave both empty for the default.">
			<div className="grid gap-3 sm:grid-cols-2">
				<TextField value={name} onChange={setName} maxLength={40}>
					<Label>Name</Label>
					<Input placeholder="Mailroom" />
				</TextField>
				<TextField value={logoUrl} onChange={setLogoUrl}>
					<Label>Logo image URL</Label>
					<Input placeholder="https://example.com/logo.png" inputMode="url" />
					<Description>A square PNG, SVG or JPG works best. Leave empty for the default.</Description>
				</TextField>
			</div>
			<div className="flex items-center gap-3 rounded-xl border border-border bg-surface-secondary px-4 py-3">
				<span className="text-xs text-muted">Preview</span>
				<BrandMark branding={preview} />
				<span className="truncate font-semibold tracking-tight">{preview.name}</span>
			</div>
			<div className="flex gap-2">
				<Button onPress={() => void save(preview)} isPending={busy} isDisabled={!changed}>
					Save
				</Button>
				<Button
					variant="secondary"
					isDisabled={busy || (current.name === DEFAULT_BRANDING.name && !current.logoUrl)}
					onPress={() => void save(DEFAULT_BRANDING)}
				>
					Reset to default
				</Button>
			</div>
		</Section>
	)
}
