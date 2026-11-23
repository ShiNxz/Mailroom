import { createHash, randomBytes } from 'node:crypto'

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

/** 16 character lowercase id, like Seylo's. */
export function newId(size = 16): string {
	const bytes = randomBytes(size)
	let out = ''
	for (let i = 0; i < size; i++) out += ALPHABET[bytes[i]! % ALPHABET.length]
	return out
}

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url')

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

/** Short stable hash, for thread ids built from Message-ID headers. */
export const shortHash = (value: string) => createHash('sha256').update(value).digest('base64url').slice(0, 22)
