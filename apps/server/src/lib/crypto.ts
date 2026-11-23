import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { env } from '../env'

// Mailbox passwords are stored AES-256-GCM encrypted with a key derived from APP_SECRET.
// Format: v1.<iv>.<tag>.<ciphertext>, each part base64url.

const key = Buffer.from(hkdfSync('sha256', env.appSecret, 'mailroom', 'mailbox-secrets', 32))

export function encryptSecret(plain: string): string {
	const iv = randomBytes(12)
	const cipher = createCipheriv('aes-256-gcm', key, iv)
	const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
	return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join(
		'.',
	)
}

export function decryptSecret(stored: string): string {
	const [version, iv, tag, data] = stored.split('.')
	if (version !== 'v1' || !iv || !tag || data === undefined) throw new Error('Unknown secret format')
	const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'))
	decipher.setAuthTag(Buffer.from(tag, 'base64url'))
	return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8')
}
