import { resolveMx, resolveSrv } from 'node:dns/promises'
import type { AutoconfigResult, Security } from '@mailroom/shared'
import { providerForMx } from './providers'

// Guesses IMAP/SMTP settings for an address, the way mail apps do: a known provider from the MX
// records, then Thunderbird's ISPDB, the domain's own autoconfig file, SRV records, and finally mail.<domain>.

interface ServerGuess {
	host: string
	port: number
	security: Security
}

const securityOf = (socketType: string | undefined, port: number): Security => {
	const t = (socketType ?? '').toUpperCase()
	if (t === 'SSL') return 'tls'
	if (t === 'STARTTLS') return 'starttls'
	if (t === 'PLAIN') return 'none'
	return port === 993 || port === 465 ? 'tls' : 'starttls'
}

function parseAutoconfigXml(xml: string, address: string) {
	const [local, domain] = address.split('@') as [string, string]
	const fill = (v: string) =>
		v
			.replace(/%EMAILADDRESS%/g, address)
			.replace(/%EMAILLOCALPART%/g, local)
			.replace(/%EMAILDOMAIN%/g, domain)
	const server = (kind: 'incomingServer' | 'outgoingServer', type: string) => {
		const re = new RegExp(`<${kind}[^>]*type="${type}"[^>]*>([\\s\\S]*?)</${kind}>`, 'gi')
		for (const m of xml.matchAll(re)) {
			const body = m[1] ?? ''
			const tag = (t: string) => body.match(new RegExp(`<${t}>([^<]*)</${t}>`, 'i'))?.[1]?.trim()
			const host = tag('hostname')
			const port = Number(tag('port'))
			if (!host || !port) continue
			return {
				host: fill(host),
				port,
				security: securityOf(tag('socketType'), port),
				username: fill(tag('username') ?? '%EMAILADDRESS%'),
			}
		}
		return null
	}
	const imap = server('incomingServer', 'imap')
	const smtp = server('outgoingServer', 'smtp')
	return imap && smtp ? { imap, smtp } : null
}

async function fetchText(url: string) {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'follow' })
		return res.ok ? await res.text() : null
	} catch {
		return null
	}
}

async function srv(name: string): Promise<ServerGuess | null> {
	try {
		const [record] = (await resolveSrv(name)).sort((a, b) => a.priority - b.priority)
		if (!record || record.name === '.' || !record.name) return null
		return { host: record.name, port: record.port, security: 'tls' }
	} catch {
		return null
	}
}

export async function autoconfigure(addressInput: string): Promise<AutoconfigResult> {
	const address = addressInput.trim().toLowerCase()
	const domain = address.split('@')[1] ?? ''
	const mx = await resolveMx(domain).catch(() => [])
	const mxHosts = mx.map(m => m.exchange)
	const provider = providerForMx(mxHosts)

	if (provider?.id === 'zoho') {
		const tld = mxHosts.map(h => h.match(/zoho(?:mail)?\.([a-z.]+)$/i)?.[1]).find(Boolean) ?? 'com'
		return {
			source: 'provider',
			provider: provider.name,
			imapHost: `imappro.zoho.${tld}`,
			imapPort: 993,
			imapSecurity: 'tls',
			smtpHost: `smtppro.zoho.${tld}`,
			smtpPort: 465,
			smtpSecurity: 'tls',
			username: address,
			saveSent: true,
			note: provider.note,
		}
	}
	if (provider?.imap && provider.smtp) {
		return {
			source: 'provider',
			provider: provider.name,
			imapHost: provider.imap.host,
			imapPort: provider.imap.port,
			imapSecurity: provider.imap.security,
			smtpHost: provider.smtp.host,
			smtpPort: provider.smtp.port,
			smtpSecurity: provider.smtp.security,
			username: address,
			saveSent: !provider.savesSent,
			note: provider.note,
		}
	}

	for (const [source, url] of [
		['autoconfig', `https://autoconfig.${domain}/mail/config-v1.1.xml?emailaddress=${encodeURIComponent(address)}`],
		['ispdb', `https://autoconfig.thunderbird.net/v1.1/${domain}`],
	] as const) {
		const xml = await fetchText(url)
		const parsed = xml ? parseAutoconfigXml(xml, address) : null
		if (parsed)
			return {
				source,
				provider: provider?.name ?? null,
				imapHost: parsed.imap.host,
				imapPort: parsed.imap.port,
				imapSecurity: parsed.imap.security,
				smtpHost: parsed.smtp.host,
				smtpPort: parsed.smtp.port,
				smtpSecurity: parsed.smtp.security,
				username: parsed.imap.username,
				saveSent: true,
				note: provider?.note,
			}
	}

	const [imapsSrv, submissionsSrv, submissionSrv] = await Promise.all([
		srv(`_imaps._tcp.${domain}`),
		srv(`_submissions._tcp.${domain}`),
		srv(`_submission._tcp.${domain}`),
	])
	const smtpSrv = submissionsSrv ?? (submissionSrv ? { ...submissionSrv, security: 'starttls' as const } : null)
	if (imapsSrv && smtpSrv)
		return {
			source: 'srv',
			provider: provider?.name ?? null,
			imapHost: imapsSrv.host,
			imapPort: imapsSrv.port,
			imapSecurity: 'tls',
			smtpHost: smtpSrv.host,
			smtpPort: smtpSrv.port,
			smtpSecurity: smtpSrv.security,
			username: address,
			saveSent: true,
			note: provider?.note,
		}

	// cPanel, Plesk, DirectAdmin and most shared hosting answer on mail.<domain>
	const host = mxHosts[0] && !provider ? mxHosts[0].replace(/\.$/, '') : `mail.${domain}`
	return {
		source: 'guess',
		provider: provider?.name ?? null,
		imapHost: host,
		imapPort: 993,
		imapSecurity: 'tls',
		smtpHost: host,
		smtpPort: 465,
		smtpSecurity: 'tls',
		username: address,
		saveSent: true,
		note:
			provider?.note ?? "These are guesses based on the MX record. Check them against your host's mail settings page.",
	}
}
