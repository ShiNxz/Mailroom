import sanitizeHtml from 'sanitize-html'

// Email HTML is shown in a sandboxed iframe without scripts, and on top of that it is cleaned here:
// no scripts, forms, iframes or event handlers; links open in a new tab; cid: images point at the
// attachment endpoint; remote images are kept but marked so the client's CSP can block them.

const ALLOWED_TAGS = [
	...sanitizeHtml.defaults.allowedTags,
	'img',
	'font',
	'center',
	'span',
	'div',
	'table',
	'thead',
	'tbody',
	'tfoot',
	'tr',
	'td',
	'th',
	'colgroup',
	'col',
	'caption',
	'style',
	'u',
	's',
	'strike',
	'del',
	'ins',
	'sub',
	'sup',
	'small',
	'big',
	'hr',
	'h1',
	'h2',
	'h3',
	'h4',
	'h5',
	'h6',
	'picture',
	'source',
]

const COMMON_ATTRS = [
	'style',
	'class',
	'id',
	'align',
	'valign',
	'width',
	'height',
	'bgcolor',
	'color',
	'dir',
	'lang',
	'title',
	'border',
]

export function sanitizeEmailHtml(html: string, cidUrl: (cid: string) => string | null) {
	let hasRemoteImages = false
	const clean = sanitizeHtml(html, {
		allowedTags: ALLOWED_TAGS,
		allowVulnerableTags: true, // <style> inside the sandboxed iframe only styles the email
		allowedAttributes: {
			'*': COMMON_ATTRS,
			a: ['href', 'name', 'target', 'rel', ...COMMON_ATTRS],
			img: ['src', 'alt', 'srcset', ...COMMON_ATTRS],
			font: ['face', 'size', 'color', ...COMMON_ATTRS],
			table: ['cellpadding', 'cellspacing', 'background', ...COMMON_ATTRS],
			td: ['colspan', 'rowspan', 'background', 'nowrap', ...COMMON_ATTRS],
			th: ['colspan', 'rowspan', 'background', 'nowrap', ...COMMON_ATTRS],
			col: ['span', ...COMMON_ATTRS],
			source: ['srcset', 'media', 'type'],
		},
		allowedSchemes: ['http', 'https', 'mailto', 'tel', 'cid', 'data'],
		allowedSchemesByTag: { img: ['http', 'https', 'cid', 'data'], a: ['http', 'https', 'mailto', 'tel'] },
		allowProtocolRelative: false,
		transformTags: {
			a: (tagName, attribs) => ({
				tagName,
				attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer nofollow' },
			}),
			img: (tagName, attribs) => {
				const src = attribs.src ?? ''
				if (src.toLowerCase().startsWith('cid:')) {
					const url = cidUrl(src.slice(4).replace(/^<|>$/g, ''))
					return { tagName, attribs: { ...attribs, src: url ?? '' } }
				}
				if (/^https?:/i.test(src)) hasRemoteImages = true
				return { tagName, attribs }
			},
		},
		// <head> is unwrapped so its <style> survives; <title> text is dropped
		nonTextTags: ['script', 'textarea', 'option', 'noscript', 'title'],
	})
	// background images in inline styles and <style> also count as remote content
	if (!hasRemoteImages && /url\(\s*['"]?https?:/i.test(clean)) hasRemoteImages = true
	return { html: clean, hasRemoteImages }
}

/** Cleans HTML written in our own composer before it is sent. */
export function sanitizeComposerHtml(html: string) {
	return sanitizeHtml(html, {
		allowedTags: [...sanitizeHtml.defaults.allowedTags, 'img', 'span', 'u', 's', 'h1', 'h2', 'h3', 'font', 'hr'],
		allowedAttributes: {
			'*': ['style', 'dir'],
			a: ['href', 'target', 'rel', 'style'],
			img: ['src', 'alt', 'width', 'height', 'style'],
			font: ['color', 'face', 'size'],
		},
		// Quote markers other clients recognise, so they fold the quoted history too
		allowedClasses: { div: ['gmail_quote', 'gmail_attr'], blockquote: ['gmail_quote'] },
		allowedSchemes: ['http', 'https', 'mailto', 'tel', 'data', 'cid'],
	})
}
