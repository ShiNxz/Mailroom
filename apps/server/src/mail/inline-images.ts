import { randomToken } from '../lib/ids'

export interface InlineImage {
	filename: string
	content: Buffer
	contentType: string
	cid: string
	contentDisposition: 'inline'
}

const EXT: Record<string, string> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/gif': 'gif',
	'image/webp': 'webp',
	'image/bmp': 'bmp',
	'image/svg+xml': 'svg',
}

// <img ... src="data:image/png;base64,...">. The bounded runs keep one tag from scanning into the next.
const DATA_IMG =
	/(<img\b[^<>]{0,2048}?\ssrc\s{0,20}=\s{0,20}["']?)data:(image\/[a-z0-9.+-]{1,60});base64,([a-z0-9+/=\s]+)/gi

/**
 * Moves data: images (pasted into the composer, or in a signature) out of the html into inline attachments
 * that the html points at with cid:. Gmail and Outlook don't show data: images at all. nodemailer's
 * attachDataUrls does this only inside its transport, not in MailComposer, which is what we send with.
 * The same image used twice goes out once.
 */
export function inlineDataImages(html: string): { html: string; images: InlineImage[] } {
	const images: InlineImage[] = []
	const seen = new Map<string, string>()
	const out = html.replace(DATA_IMG, (match, prefix: string, type: string, data: string) => {
		const b64 = data.replace(/\s/g, '')
		const key = `${type}:${b64}`
		let cid = seen.get(key)
		if (!cid) {
			const content = Buffer.from(b64, 'base64')
			if (!content.length) return match
			cid = `${randomToken(12)}@mailroom`
			seen.set(key, cid)
			const contentType = type.toLowerCase()
			images.push({
				filename: `image-${images.length + 1}.${EXT[contentType] ?? 'bin'}`,
				content,
				contentType,
				cid,
				contentDisposition: 'inline',
			})
		}
		return `${prefix}cid:${cid}`
	})
	return { html: out, images }
}
