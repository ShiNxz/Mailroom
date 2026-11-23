import type { Security } from '@mailroom/shared'

// Mail providers recognised from a domain's MX records: their IMAP/SMTP settings for the mailbox
// form, and what their SPF include and DKIM selectors look like for the domain health check.

export interface Provider {
	id: string
	name: string
	mx: RegExp
	imap?: { host: string; port: number; security: Security }
	smtp?: { host: string; port: number; security: Security }
	/** Provider saves sent mail to Sent itself, so the app must not append a second copy. */
	savesSent?: boolean
	spfInclude?: string
	dkimSelectors?: string[]
	dkimHelp?: string
	note?: string
	/** Big shared infrastructure: reverse DNS and blocklists are the provider's job. */
	managed?: boolean
	/** The MX only forwards mail; there is no mailbox to connect. */
	forwardOnly?: boolean
}

export const PROVIDERS: Provider[] = [
	{
		id: 'google',
		name: 'Google Workspace',
		mx: /(^|\.)(google\.com|googlemail\.com)$/i,
		imap: { host: 'imap.gmail.com', port: 993, security: 'tls' },
		smtp: { host: 'smtp.gmail.com', port: 465, security: 'tls' },
		savesSent: true,
		spfInclude: '_spf.google.com',
		dkimSelectors: ['google'],
		dkimHelp:
			'Google Admin > Apps > Google Workspace > Gmail > Authenticate email: generate a key and add the TXT record it shows.',
		note: 'Use an app password (Google Account > Security > 2-Step Verification > App passwords) and make sure IMAP is on.',
		managed: true,
	},
	{
		id: 'microsoft',
		name: 'Microsoft 365',
		mx: /\.mail\.protection\.outlook\.com$/i,
		imap: { host: 'outlook.office365.com', port: 993, security: 'tls' },
		smtp: { host: 'smtp.office365.com', port: 587, security: 'starttls' },
		savesSent: true,
		spfInclude: 'spf.protection.outlook.com',
		dkimSelectors: ['selector1', 'selector2'],
		dkimHelp:
			'Microsoft Defender portal > Email authentication settings > DKIM: add the two CNAME records and turn signing on.',
		note: 'Microsoft 365 turned off password sign-in for IMAP and SMTP for most tenants. It only works where an admin allows basic auth or SMTP AUTH for this mailbox.',
		managed: true,
	},
	{
		id: 'zoho',
		name: 'Zoho Mail',
		mx: /(^|\.)zoho(mail)?\.(com|eu|in|com\.au|jp|com\.cn|sa)$/i,
		spfInclude: 'zoho.com',
		dkimSelectors: ['zmail', 'zoho', 'default'],
		dkimHelp: 'Zoho Mail Admin Console > Domains > Email configuration > DKIM.',
		note: 'Turn on IMAP access in Zoho Mail settings. Accounts with 2FA need an application-specific password.',
		managed: true,
	},
	{
		id: 'fastmail',
		name: 'Fastmail',
		mx: /(^|\.)messagingengine\.com$/i,
		imap: { host: 'imap.fastmail.com', port: 993, security: 'tls' },
		smtp: { host: 'smtp.fastmail.com', port: 465, security: 'tls' },
		spfInclude: 'spf.messagingengine.com',
		dkimSelectors: ['fm1', 'fm2', 'fm3'],
		note: 'Use an app password from Fastmail Settings > Privacy & Security.',
		managed: true,
	},
	{
		id: 'migadu',
		name: 'Migadu',
		mx: /(^|\.)migadu\.com$/i,
		imap: { host: 'imap.migadu.com', port: 993, security: 'tls' },
		smtp: { host: 'smtp.migadu.com', port: 465, security: 'tls' },
		spfInclude: 'spf.migadu.com',
		dkimSelectors: ['key1', 'key2', 'key3'],
		managed: true,
	},
	{
		id: 'icloud',
		name: 'iCloud Mail',
		mx: /(^|\.)mail\.icloud\.com$/i,
		imap: { host: 'imap.mail.me.com', port: 993, security: 'tls' },
		smtp: { host: 'smtp.mail.me.com', port: 587, security: 'starttls' },
		spfInclude: 'icloud.com',
		dkimSelectors: ['sig1'],
		note: 'Use an app-specific password from appleid.apple.com.',
		managed: true,
	},
	{
		id: 'hostinger',
		name: 'Hostinger',
		mx: /(^|\.)hostinger\.(com|io)$/i,
		imap: { host: 'imap.hostinger.com', port: 993, security: 'tls' },
		smtp: { host: 'smtp.hostinger.com', port: 465, security: 'tls' },
		spfInclude: '_spf.mail.hostinger.com',
		dkimSelectors: ['hostingermail1', 'hostingermail2', 'hostingermail3'],
		dkimHelp: 'hPanel > Emails > your domain > DNS settings: turn on DKIM.',
		managed: true,
	},
	{
		id: 'privateemail',
		name: 'Namecheap Private Email',
		mx: /(^|\.)privateemail\.com$/i,
		imap: { host: 'mail.privateemail.com', port: 993, security: 'tls' },
		smtp: { host: 'mail.privateemail.com', port: 465, security: 'tls' },
		spfInclude: 'spf.privateemail.com',
		dkimSelectors: ['default'],
		managed: true,
	},
	{
		id: 'titan',
		name: 'Titan',
		mx: /(^|\.)titan\.email$/i,
		imap: { host: 'imap.titan.email', port: 993, security: 'tls' },
		smtp: { host: 'smtp.titan.email', port: 465, security: 'tls' },
		spfInclude: 'spf.titan.email',
		dkimSelectors: ['titan1'],
		managed: true,
	},
	{
		id: 'purelymail',
		name: 'Purelymail',
		mx: /(^|\.)purelymail\.com$/i,
		imap: { host: 'imap.purelymail.com', port: 993, security: 'tls' },
		smtp: { host: 'smtp.purelymail.com', port: 465, security: 'tls' },
		spfInclude: '_spf.purelymail.com',
		dkimSelectors: ['purelymail1', 'purelymail2', 'purelymail3'],
		managed: true,
	},
	{
		id: 'yandex',
		name: 'Yandex 360',
		mx: /(^|\.)yandex\.(net|ru)$/i,
		imap: { host: 'imap.yandex.com', port: 993, security: 'tls' },
		smtp: { host: 'smtp.yandex.com', port: 465, security: 'tls' },
		spfInclude: '_spf.yandex.net',
		dkimSelectors: ['mail'],
		managed: true,
	},
	{
		id: 'ovh',
		name: 'OVH',
		mx: /(^|\.)mail\.ovh\.net$/i,
		imap: { host: 'ssl0.ovh.net', port: 993, security: 'tls' },
		smtp: { host: 'ssl0.ovh.net', port: 465, security: 'tls' },
		spfInclude: 'mx.ovh.com',
		managed: true,
	},
	{
		id: 'gandi',
		name: 'Gandi',
		mx: /(^|\.)gandi\.net$/i,
		imap: { host: 'mail.gandi.net', port: 993, security: 'tls' },
		smtp: { host: 'mail.gandi.net', port: 465, security: 'tls' },
		spfInclude: '_mailcust.gandi.net',
		dkimSelectors: ['gm1', 'gm2', 'gm3'],
		managed: true,
	},
	{
		id: 'ionos',
		name: 'IONOS',
		mx: /(^|\.)(ionos\.(com|de|co\.uk|es|fr)|kundenserver\.de|perfora\.net)$/i,
		imap: { host: 'imap.ionos.com', port: 993, security: 'tls' },
		smtp: { host: 'smtp.ionos.com', port: 465, security: 'tls' },
		spfInclude: '_spf-us.ionos.com',
		managed: true,
	},
	{
		id: 'proton',
		name: 'Proton Mail',
		mx: /(^|\.)protonmail\.ch$/i,
		spfInclude: '_spf.protonmail.ch',
		dkimSelectors: ['protonmail', 'protonmail2', 'protonmail3'],
		note: 'Proton Mail has no direct IMAP. It works through Proton Mail Bridge running on a machine this server can reach.',
		managed: true,
	},
	{
		id: 'cloudflare',
		name: 'Cloudflare Email Routing',
		mx: /(^|\.)mx\.cloudflare\.net$/i,
		spfInclude: '_spf.mx.cloudflare.net',
		note: 'Cloudflare Email Routing only forwards mail, so there is no mailbox to connect here. Connect the mailbox it forwards to, and send through a provider that has SMTP.',
		managed: true,
		forwardOnly: true,
	},
	{
		id: 'improvmx',
		name: 'ImprovMX',
		mx: /(^|\.)improvmx\.com$/i,
		spfInclude: 'spf.improvmx.com',
		note: 'ImprovMX forwards mail. Connect the mailbox it forwards to; for sending, use ImprovMX SMTP (paid plans) or another provider.',
		managed: true,
		forwardOnly: true,
	},
]

export const providerForMx = (mxHosts: string[]) =>
	PROVIDERS.find(p => mxHosts.some(h => p.mx.test(h.replace(/\.$/, '')))) ?? null

export const COMMON_DKIM_SELECTORS = [
	'default',
	'dkim',
	'mail',
	'selector1',
	'selector2',
	'google',
	'k1',
	'k2',
	's1',
	's2',
	'key1',
	'sig1',
	'fm1',
	'zmail',
	'mx',
	'smtp',
	'email',
	'x',
	'hostingermail1',
	'resend',
	'mandrill',
]
