import { type Branding, DEFAULT_BRANDING } from '@mailroom/shared'
import type { Metadata, Viewport } from 'next'
import { Inter } from 'next/font/google'
import type { ReactNode } from 'react'
import { Toaster } from 'sonner'
import './globals.css'

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' })

const API_URL = (process.env.API_URL ?? 'http://localhost:3001').replace(/\/$/, '')

// The tab title and icon come from the branding (Settings), so they are right before any script runs
export async function generateMetadata(): Promise<Metadata> {
	let branding: Branding = DEFAULT_BRANDING
	try {
		const res = await fetch(`${API_URL}/branding`, { next: { revalidate: 30 }, signal: AbortSignal.timeout(2000) })
		if (res.ok) branding = await res.json()
	} catch {}
	return {
		title: branding.name,
		description: 'Mail for every project',
		robots: { index: false, follow: false },
		...(branding.logoUrl ? { icons: { icon: branding.logoUrl, apple: branding.logoUrl } } : {}),
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
