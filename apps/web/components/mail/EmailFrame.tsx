'use client'

import { MoreHorizontal } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { splitQuote } from '@/lib/quote'

// Renders email HTML in a sandboxed iframe: no scripts at all, links open in a new tab, and a CSP that
// blocks remote content (tracking pixels) until the reader allows images. The HTML is already sanitized
// by the API; this is the second wall.

const PLAIN_MARKER = '<div style="white-space:pre-wrap">'

export function EmailFrame({ html: full, allowImages }: { html: string; allowImages: boolean }) {
	const ref = useRef<HTMLIFrameElement>(null)
	const [height, setHeight] = useState(120)
	// The quoted history of a reply is hidden behind a toggle, so each message shows what it adds
	const split = useMemo(() => splitQuote(full), [full])
	const [showQuote, setShowQuote] = useState(false)
	const html = split && !showQuote ? split.main : full
	const plain = full.startsWith(PLAIN_MARKER)
	const dark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark')

	const img = allowImages ? "'self' data: blob: https: http:" : "'self' data: blob:"
	const style = allowImages ? "'unsafe-inline' https:" : "'unsafe-inline'"
	const font = allowImages ? 'data: https:' : 'data:'
	// Plain text follows the app theme. HTML mail is designed for a white page: in light mode it sits right
	// on the pane (full width, no box); in dark mode it gets a white page of its own.
	const boxed = !plain && dark
	const fg = plain && dark ? '#e7e7ea' : '#1f2328'
	const bg = boxed ? '#ffffff' : 'transparent'

	const doc = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${img}; style-src ${style}; font-src ${font}; media-src ${img}">
<base target="_blank">
<style>
html,body{margin:0;padding:0;background:${bg};color:${fg}}
body{font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif;word-wrap:break-word;overflow-wrap:anywhere;padding:${boxed ? '16px' : '0'}}
img{max-width:100%;height:auto}
table{max-width:100%}
pre{white-space:pre-wrap}
a{color:${plain && dark ? '#a5b4fc' : '#4f46e5'}}
${allowImages ? '' : 'img[src^="http"]{visibility:hidden}'}
blockquote{margin:0 0 0 .6em;padding-left:.8em;border-left:2px solid #d0d7de;color:${plain && dark ? '#a1a1aa' : '#57606a'}}
</style></head><body>${html}</body></html>`

	useEffect(() => {
		const frame = ref.current
		if (!frame) return
		let observer: ResizeObserver | null = null
		const measure = () => {
			const body = frame.contentDocument?.body
			const root = frame.contentDocument?.documentElement
			if (!body || !root) return
			setHeight(Math.max(40, Math.ceil(Math.max(body.scrollHeight, root.scrollHeight))))
		}
		const onLoad = () => {
			measure()
			const body = frame.contentDocument?.body
			if (body) {
				observer = new ResizeObserver(measure)
				observer.observe(body)
			}
			// Images that load later change the height
			for (const im of frame.contentDocument?.images ?? []) im.addEventListener('load', measure)
		}
		frame.addEventListener('load', onLoad)
		return () => {
			frame.removeEventListener('load', onLoad)
			observer?.disconnect()
		}
	}, [doc])

	return (
		<>
			<iframe
				ref={ref}
				title="Message"
				srcDoc={doc}
				// allow-same-origin only lets the parent measure the height; without allow-scripts nothing runs inside
				sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
				referrerPolicy="no-referrer"
				className={`block w-full border-0 ${boxed ? 'rounded-xl' : ''}`}
				style={{ height, colorScheme: plain && dark ? 'dark' : 'light' }}
			/>
			{split && (
				<button
					type="button"
					onClick={() => setShowQuote(v => !v)}
					title={showQuote ? 'Hide the quoted text' : 'Show the quoted text'}
					aria-label={showQuote ? 'Hide the quoted text' : 'Show the quoted text'}
					aria-expanded={showQuote}
					className="mt-2 inline-flex h-5 items-center rounded-full bg-default px-2 text-muted transition-colors hover:bg-default-hover hover:text-foreground"
				>
					<MoreHorizontal className="size-4" />
				</button>
			)}
		</>
	)
}
