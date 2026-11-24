import type { Metadata, Viewport } from 'next'
import { Inter } from 'next/font/google'
import type { ReactNode } from 'react'
import { Toaster } from 'sonner'
import { brandingVersion, serverBranding } from '@/lib/server-branding'
import './globals.css'

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' })

// The tab title and icon, and the installed app's name and home screen icon, come from the branding
// (Settings), so they are right before any script runs
export async function generateMetadata(): Promise<Metadata> {
	const branding = await serverBranding()
	const v = brandingVersion(branding)
	return {
		title: branding.name,
		description: 'Mail for every project',
		robots: { index: false, follow: false },
		manifest: '/manifest.webmanifest',
		applicationName: branding.name,
		appleWebApp: { capable: true, title: branding.name, statusBarStyle: 'default' },
		icons: {
			icon: branding.logoUrl ?? `/pwa/icon-192.png?v=${v}`,
			apple: `/pwa/apple-touch-icon.png?v=${v}`,
		},
	}
}

export const viewport: Viewport = {
	themeColor: [
		{ media: '(prefers-color-scheme: dark)', color: '#16161b' },
		{ media: '(prefers-color-scheme: light)', color: '#f7f7f8' },
	],
	width: 'device-width',
	initialScale: 1,
}

// Sets the theme before paint: the saved choice, else the system one
const themeScript = `(function(){try{var t=localStorage.getItem('mr-theme');if(t!=='light'&&t!=='dark'){t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}var d=document.documentElement;d.classList.toggle('dark',t==='dark');d.dataset.theme=t}catch(e){}})()`

export default function RootLayout({ children }: { children: ReactNode }) {
	return (
		<html lang="en" className={inter.variable} suppressHydrationWarning>
			<head>
				<script dangerouslySetInnerHTML={{ __html: themeScript }} />
			</head>
			<body className="font-sans">
				{children}
				<Toaster
					position="bottom-left"
					toastOptions={{
						classNames: {
							toast: '!bg-surface !text-foreground !border-border !rounded-xl !shadow-lg !font-sans',
							description: '!text-muted',
							actionButton: '!bg-accent !text-accent-foreground',
						},
					}}
				/>
			</body>
		</html>
	)
}
