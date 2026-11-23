'use client'

import { useEffect, useRef, useState } from 'react'

// Renders email HTML in a sandboxed iframe: no scripts at all, links open in a new tab, and a CSP that
// blocks remote content (tracking pixels) until the reader allows images. The HTML is already sanitized
// by the API; this is the second wall.

const PLAIN_MARKER = '<div style="white-space:pre-wrap">'

export function EmailFrame({ html, allowImages }: { html: string; allowImages: boolean }) {
	const ref = useRef<HTMLIFrameElement>(null)
	const [height, setHeight] = useState(120)
	const plain = html.startsWith(PLAIN_MARKER)
	const dark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark')

	const img = allowImages ? "'self' data: blob: https: http:" : "'self' data: blob:"
	const style = allowImages ? "'unsafe-inline' https:" : "'unsafe-inline'"
	const font = allowImages ? 'data: https:' : 'data:'
	// Plain text follows the app theme; HTML mail is designed for a white page, so it gets one
	const fg = plain && dark ? '#e7e7ea' : '#1f2328'
	const bg = plain ? 'transparent' : '#ffffff'

	const doc = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${img}; style-src ${style}; font-src ${font}; media-src ${img}">
<base target="_blank">
<style>
html,body{margin:0;padding:0;background:${bg};color:${fg}}
body{font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif;word-wrap:break-word;overflow-wrap:anywhere;padding:${plain ? '0' : '16px'}}
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
		<iframe
			ref={ref}
			title="Message"
			srcDoc={doc}
			// allow-same-origin only lets the parent measure the height; without allow-scripts nothing runs inside
			sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
			referrerPolicy="no-referrer"
			className={`block w-full border-0 ${plain ? '' : 'rounded-xl'}`}
			style={{ height, colorScheme: plain && dark ? 'dark' : 'light' }}
		/>
	)
}
