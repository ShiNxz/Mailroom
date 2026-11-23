import type { Address, Attachment } from '@mailroom/shared'
import type { MessageAddressObject, MessageStructureObject } from 'imapflow'

export interface BodyParts {
	text: { part: string; size: number } | null
	html: { part: string; size: number } | null
	attachments: Attachment[]
}

const lower = (v: string | undefined) => (v ?? '').toLowerCase()

function filenameOf(node: MessageStructureObject): string | null {
	return node.dispositionParameters?.filename ?? node.parameters?.name ?? null
}

/**
 * Walks a BODYSTRUCTURE: finds the text/plain and text/html bodies to show and lists the
 * attachments with the part ids that download them later.
 */
export function walkStructure(root: MessageStructureObject | undefined): BodyParts {
	const out: BodyParts = { text: null, html: null, attachments: [] }
	if (!root) return out

	const visit = (node: MessageStructureObject, inAlternative: boolean) => {
		const type = lower(node.type)
		const part = node.part ?? '1'
		if (node.childNodes?.length) {
			const alt = type === 'multipart/alternative'
			for (const child of node.childNodes) visit(child, alt || inAlternative)
			return
		}
		const disposition = lower(node.disposition)
		const filename = filenameOf(node)
		const isBody = (type === 'text/plain' || type === 'text/html') && disposition !== 'attachment' && !filename
		if (isBody) {
			const slot = type === 'text/html' ? 'html' : 'text'
			// The first body of each kind wins: later ones are usually forwarded or quoted parts
			if (!out[slot]) out[slot] = { part, size: node.size ?? 0 }
			else if (!inAlternative) out.attachments.push(attachmentOf(node, part, filename))
			return
		}
		if (type === 'multipart/related' || type.startsWith('multipart/')) return
		out.attachments.push(attachmentOf(node, part, filename))
	}
	visit(root, false)
	return out
}

function attachmentOf(node: MessageStructureObject, part: string, filename: string | null): Attachment {
	const type = lower(node.type) || 'application/octet-stream'
	const cid = node.id ? node.id.replace(/^<|>$/g, '') : null
	let name = filename
	if (!name && type === 'message/rfc822') name = `${node.envelope?.subject || 'message'}.eml`
	if (!name) name = `${type.split('/')[0] || 'file'}-${part}${extensionFor(type)}`
	return {
		partId: part,
		filename: name,
		contentType: type,
		// Base64 inflates by about a third; BODYSTRUCTURE reports the encoded size
		size: node.encoding?.toLowerCase() === 'base64' ? Math.floor((node.size ?? 0) * 0.75) : (node.size ?? 0),
		cid,
		inline: lower(node.disposition) === 'inline' || (!!cid && type.startsWith('image/')),
	}
}

function extensionFor(type: string) {
	const map: Record<string, string> = {
		'image/png': '.png',
		'image/jpeg': '.jpg',
		'image/gif': '.gif',
		'application/pdf': '.pdf',
		'text/calendar': '.ics',
		'text/plain': '.txt',
		'text/html': '.html',
	}
	return map[type] ?? ''
}

export function addresses(list: MessageAddressObject[] | undefined): Address[] {
	if (!list) return []
	return list
		.filter(a => a.address)
		.map(a => ({ name: (a.name ?? '').trim(), address: (a.address ?? '').trim().toLowerCase() }))
}

/** Parses the few headers we ask for (References, In-Reply-To, List-Unsubscribe) from a raw header block. */
export function parseHeaders(raw: Buffer | undefined) {
	const out: Record<string, string> = {}
	if (!raw) return out
	const unfolded = raw.toString('utf8').replace(/\r?\n[ \t]+/g, ' ')
	for (const line of unfolded.split(/\r?\n/)) {
		const i = line.indexOf(':')
		if (i <= 0) continue
		out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim()
	}
	return out
}

export const messageIdsIn = (value: string | undefined) => (value ? (value.match(/<[^<>\s]+>/g) ?? []) : [])

const ENTITIES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' ',
	zwnj: '',
	'#39': "'",
}

export function decodeEntities(s: string) {
	return s.replace(/&(#x?[0-9a-f]+|[a-z0-9]+);/gi, (m, code: string) => {
		const c = code.toLowerCase()
		if (c in ENTITIES) return ENTITIES[c]!
		if (c.startsWith('#x')) return String.fromCodePoint(Number.parseInt(c.slice(2), 16) || 32)
		if (c.startsWith('#')) return String.fromCodePoint(Number.parseInt(c.slice(1), 10) || 32)
		return m
	})
}

/** Rough HTML to text, for search, snippets and the plain-text alternative of sent mail. */
export function htmlToText(html: string): string {
	return decodeEntities(
		html
			.replace(/<(head|style|script|title)[^>]*>[\s\S]*?<\/\1>/gi, '')
			.replace(/<br\s*\/?>/gi, '\n')
			.replace(/<\/(p|div|tr|li|h[1-6]|blockquote|table)>/gi, '\n')
			.replace(/<li[^>]*>/gi, '- ')
			.replace(/<a [^>]*href="(https?:[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) =>
				label.replace(/<[^>]+>/g, '').trim() === href ? href : `${label} (${href})`,
			)
			.replace(/<[^>]+>/g, ''),
	)
		.replace(/[ \t ]+/g, ' ')
		.replace(/ *\n */g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim()
}

/** First lines of the new text in a message, without quoted replies. */
export function snippetOf(text: string): string {
	const lines: string[] = []
	for (const line of text.split('\n')) {
		const l = line.trim()
		if (/^On .{5,200} wrote:$/.test(l) || /^-{2,}\s*Original Message/i.test(l) || /^-{2,} ?Forwarded message/i.test(l))
			break
		if (l.startsWith('>')) continue
		if (l) lines.push(l)
		if (lines.join(' ').length > 240) break
	}
	return lines.join(' ').replace(/\s+/g, ' ').slice(0, 220)
}

export const escapeHtml = (s: string) =>
	s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Plain text to simple HTML, used when replying to or forwarding a text-only message. */
export function textToHtml(text: string) {
	return escapeHtml(text)
		.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')
		.replace(/\n/g, '<br>')
}

export const normalizeSubject = (s: string) => s.replace(/^((re|fwd?|aw|sv|antw)(\[\d+\])?:\s*)+/i, '').trim()
