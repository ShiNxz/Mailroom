import type { Security } from '@mailroom/shared'
import { ImapFlow } from 'imapflow'
import nodemailer from 'nodemailer'
import type { schema } from '../db'
import { decryptSecret } from '../lib/crypto'
import { log, safeJson } from '../lib/log'

export type MailboxRow = typeof schema.mailboxes.$inferSelect

export interface ConnectionSettings {
	username: string
	password: string
	imapHost: string
	imapPort: number
	imapSecurity: Security
	smtpHost: string
	smtpPort: number
	smtpSecurity: Security
}

export const settingsOf = (m: MailboxRow): ConnectionSettings => ({
	username: m.username,
	password: decryptSecret(m.secret),
	imapHost: m.imapHost,
	imapPort: m.imapPort,
	imapSecurity: m.imapSecurity,
	smtpHost: m.smtpHost,
	smtpPort: m.smtpPort,
	smtpSecurity: m.smtpSecurity,
})

// Self-signed certificates are only accepted for hosts that are clearly local test servers.
const isLocalHost = (host: string) => host === 'localhost' || host === '127.0.0.1' || host.endsWith('.test')

const imapLogger = (tag: string) => {
	const l = log.child({ imap: tag })
	return {
		debug: () => {},
		info: () => {},
		// imapflow logs the raw socket error. A TLS error holds the peer certificate, which can be circular,
		// and a throw here (inside the socket's error handler) took the whole process down.
		warn: (o: object) => l.warn('imap', { detail: safeJson(o).slice(0, 500) }),
		error: (o: object) => l.error('imap', { detail: safeJson(o).slice(0, 500) }),
	}
}

export function imapClient(s: ConnectionSettings, tag: string) {
	return new ImapFlow({
		host: s.imapHost,
		port: s.imapPort,
		secure: s.imapSecurity === 'tls',
		doSTARTTLS: s.imapSecurity === 'starttls' ? true : s.imapSecurity === 'none' ? false : undefined,
		auth: { user: s.username, pass: s.password },
		tls: { rejectUnauthorized: !isLocalHost(s.imapHost), minVersion: 'TLSv1.2' },
		logger: imapLogger(tag),
		clientInfo: { name: 'Mailroom', version: '1.0' },
		connectionTimeout: 30_000,
		greetingTimeout: 20_000,
		socketTimeout: 10 * 60_000,
		// Breaks and restarts IDLE every 20 minutes: some servers drop IDLE after 30 without telling
		maxIdleTime: 20 * 60_000,
		qresync: false,
	})
}

export function smtpTransport(s: ConnectionSettings) {
	return nodemailer.createTransport({
		host: s.smtpHost,
		port: s.smtpPort,
		secure: s.smtpSecurity === 'tls',
		requireTLS: s.smtpSecurity === 'starttls',
		ignoreTLS: s.smtpSecurity === 'none',
		auth: { user: s.username, pass: s.password },
		tls: { rejectUnauthorized: !isLocalHost(s.smtpHost), minVersion: 'TLSv1.2' },
		connectionTimeout: 30_000,
		greetingTimeout: 20_000,
		socketTimeout: 120_000,
	})
}

/**
 * nodemailer reports every socket and TLS failure as ESOCKET (a certificate for another host included),
 * so the real cause is read from the message.
 */
function socketCode(message: string) {
	if (/altnames/i.test(message)) return 'ERR_TLS_CERT_ALTNAME_INVALID'
	if (/self[- ]signed/i.test(message)) return 'DEPTH_ZERO_SELF_SIGNED_CERT'
	if (/certificate has expired/i.test(message)) return 'CERT_HAS_EXPIRED'
	if (/ECONNREFUSED/.test(message)) return 'ECONNREFUSED'
	if (/ENOTFOUND|getaddrinfo/.test(message)) return 'ENOTFOUND'
	if (/ETIMEDOUT|timed? ?out/i.test(message)) return 'ETIMEDOUT'
	return 'ESOCKET'
}

/** Turns an IMAP/SMTP error into something a person can act on. */
export function describeConnectionError(err: unknown): string {
	const e = err as {
		message?: string
		code?: string
		responseText?: string
		authenticationFailed?: boolean
		response?: string
	}
	if (
		e?.authenticationFailed ||
		/auth|credentials|login|535|password/i.test(`${e?.responseText ?? ''} ${e?.response ?? ''} ${e?.message ?? ''}`)
	)
		return `Sign-in was rejected${e.responseText ? `: ${e.responseText}` : ''}. Check the username and password (some providers need an app password).`
	switch (e?.code === 'ESOCKET' ? socketCode(e.message ?? '') : e?.code) {
		case 'ENOTFOUND':
		case 'EAI_AGAIN':
		case 'EDNS':
			return 'The server name could not be found. Check the host.'
		case 'ECONNREFUSED':
			return 'The server refused the connection. Check the port.'
		case 'ETIMEDOUT':
		case 'CONNECT_TIMEOUT':
			return 'The server did not answer in time. Check the host, port and security setting.'
		case 'CERT_HAS_EXPIRED':
			return 'The server certificate has expired.'
		case 'ERR_TLS_CERT_ALTNAME_INVALID': {
			// "DNS:mail.example.com, DNS:*.example.com": say which names would work
			const names = ((err as { cert?: { subjectaltname?: string } }).cert?.subjectaltname ?? '')
				.split(',')
				.map(n => n.trim().replace(/^(DNS|IP Address):/, ''))
				.filter(Boolean)
				.slice(0, 4)
			return names.length
				? `The server's certificate is for ${names.join(', ')}, not this host name. Use one of those as the host.`
				: 'The server certificate does not match this host name. Use the host name the certificate was issued for.'
		}
		case 'DEPTH_ZERO_SELF_SIGNED_CERT':
		case 'SELF_SIGNED_CERT_IN_CHAIN':
			return 'The server uses a self-signed certificate.'
	}
	if (/wrong version number|ssl3_get_record|packet length too long/i.test(e?.message ?? ''))
		return 'TLS failed. The port probably expects a different security setting (993/465 use TLS, 143/587 use STARTTLS).'
	return e?.responseText || e?.message || 'Unknown error'
}

export async function testImap(s: ConnectionSettings) {
	const client = imapClient(s, `test:${s.username}`)
	try {
		await client.connect()
		const list = await client.list()
		return { ok: true as const, folders: list.length }
	} catch (err) {
		return { ok: false as const, error: describeConnectionError(err) }
	} finally {
		await client.logout().catch(() => client.close())
	}
}

export async function testSmtp(s: ConnectionSettings) {
	const transport = smtpTransport(s)
	try {
		await transport.verify()
		return { ok: true as const }
	} catch (err) {
		return { ok: false as const, error: describeConnectionError(err) }
	} finally {
		transport.close()
	}
}
