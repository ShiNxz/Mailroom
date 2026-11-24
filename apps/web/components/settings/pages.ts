import {
	Bell,
	FileText,
	KeyRound,
	type LucideIcon,
	Palette,
	PenLine,
	ShieldCheck,
	SlidersHorizontal,
} from 'lucide-react'

// The settings pages, in the order the settings sidebar lists them. The layout takes each page's title and
// description from here, so a page only renders its sections.

export interface SettingsPage {
	href: string
	label: string
	icon: LucideIcon
	description: string
}

export interface SettingsGroup {
	label: string
	/** Only admins see the group */
	admin?: boolean
	pages: SettingsPage[]
}

export const SETTINGS_GROUPS: SettingsGroup[] = [
	{
		label: 'Account',
		pages: [
			{
				href: '/settings',
				label: 'General',
				icon: SlidersHorizontal,
				description: 'Your name, how the app looks, and how sending and reading work.',
			},
			{
				href: '/settings/notifications',
				label: 'Notifications',
				icon: Bell,
				description: 'New mail on your phone and computer. Only for mailboxes you can open.',
			},
			{
				href: '/settings/security',
				label: 'Security',
				icon: ShieldCheck,
				description: "Your password, passkeys and authenticator, and where you're signed in.",
			},
		],
	},
	{
		label: 'Mail',
		pages: [
			{
				href: '/settings/signatures',
				label: 'Signatures',
				icon: PenLine,
				description: 'Your own signature for each mailbox. Without one you get the default an admin set.',
			},
			{
				href: '/settings/templates',
				label: 'Templates',
				icon: FileText,
				description: 'Saved replies you insert from the composer. Project templates are shared with the whole project.',
			},
		],
	},
	{
		label: 'Developers',
		pages: [
			{
				href: '/settings/api',
				label: 'API tokens',
				icon: KeyRound,
				description:
					'Let your apps send and receive mail through the API instead of SMTP. A token reaches only what you can, narrowed to the mailboxes you pick.',
			},
		],
	},
	{
		label: 'Workspace',
		admin: true,
		pages: [
			{
				href: '/settings/branding',
				label: 'Branding',
				icon: Palette,
				description: 'The name and logo everyone sees: sidebar, sign-in page, browser tab and the installed app.',
			},
		],
	},
]
