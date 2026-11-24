import { createHmac, randomBytes } from 'node:crypto'
import QRCode from 'qrcode'
import { redis } from '../lib/redis'

// RFC 6238 time-based codes (Google Authenticator, 1Password, Authy...): 6 digits, 30 seconds, SHA-1.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(buf: Buffer) {
	let bits = 0
	let value = 0
	let out = ''
	for (const byte of buf) {
		value = (value << 8) | byte
		bits += 8
		while (bits >= 5) {
			out += ALPHABET[(value >>> (bits - 5)) & 31]
			bits -= 5
		}
	}
	if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
	return out
}

export function base32Decode(input: string) {
	const clean = input.replace(/[\s=-]/g, '').toUpperCase()
	let bits = 0
	let value = 0
	const out: number[] = []
	for (const ch of clean) {
		const i = ALPHABET.indexOf(ch)
		if (i < 0) throw new Error('Bad base32')
		value = (value << 5) | i
		bits += 5
		if (bits >= 8) {
			out.push((value >>> (bits - 8)) & 255)
			bits -= 8
		}
	}
	return Buffer.from(out)
}

export const newTotpSecret = () => base32Encode(randomBytes(20))

export function totpAt(secret: string, step: number) {
	const counter = Buffer.alloc(8)
	counter.writeBigUInt64BE(BigInt(step))
	const hmac = createHmac('sha1', base32Decode(secret)).update(counter).digest()
	const offset = hmac[hmac.length - 1]! & 15
	const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000
	return String(code).padStart(6, '0')
}

const stepNow = () => Math.floor(Date.now() / 30_000)

/**
 * Checks a code against the current step and one on each side (clock drift). A code that
 * worked once can't be used again: the last accepted step is remembered per user.
 */
export async function verifyTotp(userId: string, secret: string, code: string) {
	const clean = code.replace(/\s/g, '')
	if (!/^\d{6}$/.test(clean)) return false
	const now = stepNow()
	const lastKey = `totp:last:${userId}`
	const last = Number((await redis.get(lastKey)) ?? 0)
	for (const step of [now - 1, now, now + 1]) {
		if (step <= last) continue
		if (totpAt(secret, step) === clean) {
			await redis.set(lastKey, String(step), 'EX', 120)
			return true
		}
	}
	return false
}

export async function totpEnrollment(secret: string, account: string, issuer: string) {
	const label = encodeURIComponent(`${issuer}:${account}`)
	const url = `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`
	const qrSvg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })
	return { url, qrSvg, secret: secret.replace(/(.{4})/g, '$1 ').trim() }
}
