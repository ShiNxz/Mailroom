'use client'

// Images put into a message or signature travel inside the HTML (as data: URLs, sent as embedded
// attachments), so they are shrunk first: a 3000px photo or logo would otherwise make every mail heavy.

/** Biggest image file we take at all */
export const MAX_IMAGE_FILE = 15 * 1024 * 1024
/** Kept as-is when it already fits and is at most this big */
const KEEP_AS_IS = 400 * 1024
/** Above this a re-encoded PNG goes to JPEG instead (photos compress badly as PNG) */
const PNG_LIMIT = 900 * 1024

export interface MailImage {
	src: string
	width: number
	height: number
}

const readAsDataUrl = (blob: Blob) =>
	new Promise<string>((resolve, reject) => {
		const reader = new FileReader()
		reader.onload = () => resolve(reader.result as string)
		reader.onerror = () => reject(reader.error)
		reader.readAsDataURL(blob)
	})

const load = (src: string) =>
	new Promise<HTMLImageElement>((resolve, reject) => {
		const img = new Image()
		img.onload = () => resolve(img)
		img.onerror = () => reject(new Error("Couldn't read that image"))
		img.src = src
	})

const encode = (canvas: HTMLCanvasElement, type: string, quality?: number) =>
	new Promise<Blob>((resolve, reject) =>
		canvas.toBlob(b => (b ? resolve(b) : reject(new Error("Couldn't shrink that image"))), type, quality),
	)

/**
 * Reads an image file for mail, shrunk so its longest side is at most `maxSide` pixels. PNG, JPEG and GIF
 * files that already fit are kept untouched (a GIF keeps its animation). Anything else, WebP and SVG
 * included, becomes PNG or JPEG, which every mail app shows.
 */
export async function imageForMail(file: File, maxSide: number): Promise<MailImage> {
	if (file.size > MAX_IMAGE_FILE) throw new Error('That image is over 15 MB')
	const url = URL.createObjectURL(file)
	try {
		const img = await load(url)
		const w = img.naturalWidth || 300
		const h = img.naturalHeight || 150
		const scale = Math.min(1, maxSide / Math.max(w, h))
		const keep = /^image\/(png|jpeg|gif)$/.test(file.type) && scale === 1 && file.size <= KEEP_AS_IS
		if (keep || (file.type === 'image/gif' && file.size <= KEEP_AS_IS * 2))
			return { src: await readAsDataUrl(file), width: w, height: h }

		const width = Math.max(1, Math.round(w * scale))
		const height = Math.max(1, Math.round(h * scale))
		const canvas = document.createElement('canvas')
		canvas.width = width
		canvas.height = height
		const ctx = canvas.getContext('2d')
		if (!ctx) throw new Error("Couldn't shrink that image")
		ctx.imageSmoothingQuality = 'high'
		const photo = file.type === 'image/jpeg'
		if (photo) {
			ctx.fillStyle = '#fff'
			ctx.fillRect(0, 0, width, height)
		}
		ctx.drawImage(img, 0, 0, width, height)
		let blob = await encode(canvas, photo ? 'image/jpeg' : 'image/png', photo ? 0.88 : undefined)
		if (!photo && blob.size > PNG_LIMIT) {
			// Too big for PNG: a photo, most likely. JPEG has no transparency, so it goes on white.
			ctx.globalCompositeOperation = 'destination-over'
			ctx.fillStyle = '#fff'
			ctx.fillRect(0, 0, width, height)
			blob = await encode(canvas, 'image/jpeg', 0.85)
		}
		return { src: await readAsDataUrl(blob), width, height }
	} finally {
		URL.revokeObjectURL(url)
	}
}
