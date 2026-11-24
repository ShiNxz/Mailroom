'use client'

import type { User, UserSettings } from '@mailroom/shared'
import {
	Button,
	Description,
	Input,
	Label,
	ListBox,
	Select,
	Switch,
	TextField,
	ToggleButton,
	ToggleButtonGroup,
} from '@heroui/react'
import { Monitor, Moon, Sun } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { PersonAvatar } from '@/components/ui'
import { api, useMe } from '@/lib/api'
import { setTheme, type ThemeChoice, useThemeChoice } from '@/lib/theme'
import { Section } from './Section'

/** Saves the person's name or settings and updates the cached account. */
export function useSaveSettings() {
	const { mutate } = useMe()
	return async (patch: { name?: string; settings?: Partial<UserSettings> }) => {
		try {
			const r = await api<{ user: User }>('/auth/me', { method: 'PATCH', body: patch })
			void mutate(prev => (prev ? { ...prev, user: { ...prev.user, ...r.user } } : prev), { revalidate: false })
			return true
		} catch (err) {
			toast.error((err as Error).message)
			return false
		}
	}
}

function Profile() {
	const { data: me } = useMe()
	const save = useSaveSettings()
	const [name, setName] = useState(me?.user.name ?? '')
	useEffect(() => setName(me?.user.name ?? ''), [me?.user.name])
	if (!me) return null
	const changed = name.trim() !== me.user.name && name.trim().length > 0

	return (
		<Section title="Profile">
			<div className="flex items-center gap-3">
				<PersonAvatar who={{ name: me.user.name, address: me.user.email }} size={44} />
				<div className="min-w-0">
					<div className="truncate text-sm font-medium">{me.user.name}</div>
					<div className="truncate text-xs text-muted">{me.user.email}</div>
				</div>
			</div>
			<form
				className="flex items-end gap-2"
				onSubmit={async e => {
					e.preventDefault()
					if (changed && (await save({ name: name.trim() }))) toast.success('Name saved')
				}}
			>
				<TextField value={name} onChange={setName} className="flex-1" maxLength={80}>
					<Label>Name</Label>
					<Input />
				</TextField>
				<Button type="submit" variant="secondary" isDisabled={!changed}>
					Save
				</Button>
			</form>
		</Section>
	)
}

const THEMES: { id: ThemeChoice; label: string; icon: typeof Sun }[] = [
	{ id: 'light', label: 'Light', icon: Sun },
	{ id: 'dark', label: 'Dark', icon: Moon },
	{ id: 'system', label: 'System', icon: Monitor },
]

function Appearance() {
	const choice = useThemeChoice()
	return (
		<Section title="Appearance">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div>
					<div className="text-sm font-medium">Theme</div>
					<div className="text-xs text-muted">For this browser. System follows your device.</div>
				</div>
				<ToggleButtonGroup
					aria-label="Theme"
					size="sm"
					selectionMode="single"
					disallowEmptySelection
					selectedKeys={[choice]}
					onSelectionChange={keys => {
						const next = [...keys][0]
						if (next) setTheme(next as ThemeChoice)
					}}
				>
					{THEMES.map(t => (
						<ToggleButton key={t.id} id={t.id}>
							<t.icon className="size-3.5" /> {t.label}
						</ToggleButton>
					))}
				</ToggleButtonGroup>
			</div>
		</Section>
	)
}

function ReadingAndSending() {
	const { data: me } = useMe()
	const save = useSaveSettings()
	const settings = me?.user.settings ?? {}

	return (
		<Section title="Reading and sending">
			<Select
				value={String(settings.undoSeconds ?? 10)}
				onChange={v => void save({ settings: { undoSeconds: Number(v) } })}
				className="max-w-xs"
			>
				<Label>Undo send</Label>
				<Select.Trigger>
					<Select.Value />
					<Select.Indicator />
				</Select.Trigger>
				<Select.Popover>
					<ListBox>
						{[0, 5, 10, 20, 30].map(s => (
							<ListBox.Item key={s} id={String(s)} textValue={s ? `${s} seconds` : 'Off'}>
								{s ? `${s} seconds` : 'Off'}
								<ListBox.ItemIndicator />
							</ListBox.Item>
						))}
					</ListBox>
				</Select.Popover>
				<Description>How long a sent message waits so you can take it back.</Description>
			</Select>
			<Switch isSelected={settings.showImages ?? false} onChange={on => void save({ settings: { showImages: on } })}>
				<Switch.Content>
					<Switch.Control>
						<Switch.Thumb />
					</Switch.Control>
					<div className="flex flex-col gap-0.5">
						<Label>Always show remote images</Label>
						<Description>Off keeps tracking pixels from telling senders you opened their mail.</Description>
					</div>
				</Switch.Content>
			</Switch>
		</Section>
	)
}

export function GeneralSettings() {
	return (
		<>
			<Profile />
			<Appearance />
			<ReadingAndSending />
		</>
	)
}
