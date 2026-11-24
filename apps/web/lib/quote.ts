// Finds the quoted history at the end of a reply ("On ... wrote:" and the quote under it) so the
// thread can show only what is new, with a toggle for the rest, the way Gmail does.

const QUOTE_SELECTORS = [
	'.gmail_quote', // Gmail, and our own replies
	'.yahoo_quoted',
	'blockquote[type="cite"]', // Apple Mail, Thunderbird
	'#appendonsend', // Outlook: everything after this marker is the quote
	'#divRplyFwdMsg',
	'.moz-cite-prefix',
	'#mail-editor-reference-message-container', // Outlook web
	'.protonmail_quote',
].join(',')

// "On Tue, Nov 24, 2026 at 09:00, Dana <dana@x.com> wrote:" and the usual translations
const ATTRIBUTION =
	/(wrote|écrit|schrieb|escribió|scrisse|написал|כתב|כתבה|כתב\/ה|كتب)\s*:?\s*$|^\s*(בתאריך|on|le|am|el|il)\b.{5,300}:\s*$/i

const PLAIN_MARKER = '<div style="white-space:pre-wrap">'

export interface SplitQuote {
	main: string
	quote: string
}

const BIDI = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g
const isAttribution = (text: string | null | undefined) =>
	!!text && text.length < 400 && ATTRIBUTION.test(text.replace(BIDI, '').trim())

const hasText = (html: string) => html.replace(/<[^>]*>/g, '').replace(/&nbsp;|\s/g, '').length > 0

function splitPlain(html: string): SplitQuote | null {
	const inner = html.slice(PLAIN_MARKER.length, html.lastIndexOf('</div>'))
	const lines = inner.split('\n')
	// The quote is a run of ">" lines at the end, maybe after an attribution line
	let start = lines.length
	while (start > 0 && /^\s*(&gt;|>)/.test(lines[start - 1]!)) start--
	while (start > 0 && start < lines.length && !lines[start - 1]!.trim()) start--
	if (start === lines.length) return null
	if (start > 0 && isAttribution(lines[start - 1])) start--
	const main = lines.slice(0, start).join('\n').replace(/\s+$/, '')
	if (!hasText(main)) return null
	return { main: `${PLAIN_MARKER}${main}</div>`, quote: `${PLAIN_MARKER}${lines.slice(start).join('\n')}</div>` }
}

/** null when there is no quote, or when the quote is all there is (a forward without a note). */
export function splitQuote(html: string): SplitQuote | null {
	if (typeof DOMParser === 'undefined' || !html) return null
	if (html.startsWith(PLAIN_MARKER)) return splitPlain(html)
	const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
	let node: Element | null = doc.body.querySelector(QUOTE_SELECTORS)
	if (!node) {
		// A top-level blockquote right after an "... wrote:" line
		for (const bq of doc.body.querySelectorAll('blockquote')) {
			const prev = bq.previousElementSibling
			if (prev && isAttribution(prev.textContent)) {
				node = prev
				break
			}
		}
	}
	if (!node) return null
	// The attribution line just before the quote goes with it
	const before = node.previousElementSibling
	if (before && isAttribution(before.textContent)) node = before
	// The quote and everything after it at that level
	const quoteParts: string[] = []
	let cur: ChildNode | null = node
	while (cur) {
		const next: ChildNode | null = cur.nextSibling
		quoteParts.push(cur.nodeType === 1 ? (cur as Element).outerHTML : (cur.textContent ?? ''))
		cur.remove()
		cur = next
	}
	const main = doc.body.innerHTML
	if (!hasText(main)) return null
	return { main, quote: quoteParts.join('') }
}
