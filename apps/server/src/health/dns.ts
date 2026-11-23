import { isIP } from 'node:net'
import type { CheckStatus, DomainHealth, HealthCheck } from '@mailroom/shared'
import { COMMON_DKIM_SELECTORS, type Provider, providerForMx } from '../mail/providers'

// Domain health: everything a domain needs to receive mail and to land in the inbox when it sends.
// Lookups go over DNS-over-HTTPS to public resolvers, so the answer matches what other mail servers
// see (not a local cache), and long TXT records come back whole: Bun's resolveTxt splits a record's
// 255-byte strings into separate records, which breaks SPF and DKIM parsing.

const DOH = ['https://cloudflare-dns.com/dns-query', 'https://dns.google/resolve']
const TYPES = { A: 1, CNAME: 5, MX: 15, TXT: 16, AAAA: 28, PTR: 12 } as const

interface DohAnswer {
	type: number
	data: string
}

/** Answers of one type, [] when the name or type doesn't exist, null when no resolver answered. */
async function doh(name: string, type: keyof typeof TYPES): Promise<string[] | null> {
	if (!name) return []
	for (const base of DOH) {
		try {
			const res = await fetch(`${base}?name=${encodeURIComponent(name)}&type=${type}`, {
				headers: { accept: 'application/dns-json' },
				signal: AbortSignal.timeout(5000),
			})
			if (!res.ok) continue
			const body = (await res.json()) as { Status: number; Answer?: DohAnswer[] }
			if (body.Status === 3) return [] // NXDOMAIN
			if (body.Status !== 0) continue // SERVFAIL and friends: try the next resolver
			return (body.Answer ?? []).filter(a => a.type === TYPES[type]).map(a => a.data)
		} catch {}
	}
	return null
}

/** TXT data is a list of quoted strings that make up one record. */
function joinTxt(data: string) {
	if (!data.startsWith('"')) return data
	return (data.match(/"((?:[^"\\]|\\.)*)"/g) ?? []).map(s => s.slice(1, -1).replace(/\\(.)/g, '$1')).join('')
}

const notFound = () => Object.assign(new Error('not found'), { code: 'ENODATA' })

const resolver = {
	async resolve4(host: string) {
		const r = await doh(host, 'A')
		if (!r?.length) throw notFound()
		return r
	},
	async resolve6(host: string) {
		const r = await doh(host, 'AAAA')
		if (!r?.length) throw notFound()
		return r
	},
	async resolveMx(host: string) {
		const r = await doh(host, 'MX')
		if (r === null) throw Object.assign(new Error('lookup failed'), { code: 'ESERVFAIL' })
		if (!r.length) throw notFound()
		return r.map(d => {
			const [priority, exchange] = d.split(/\s+/)
			return { priority: Number(priority), exchange: (exchange ?? '').replace(/\.$/, '') }
		})
	},
	async reverse(ip: string) {
		const name = `${ip.split('.').reverse().join('.')}.in-addr.arpa`
		const r = await doh(name, 'PTR')
		if (!r?.length) throw notFound()
		return r.map(d => d.replace(/\.$/, ''))
	},
}

const NOT_FOUND = new Set(['ENOTFOUND', 'ENODATA', 'ENONAME', 'NXDOMAIN'])

async function txt(name: string): Promise<string[] | null> {
	const r = await doh(name, 'TXT')
	return r === null ? null : r.map(joinTxt)
}

async function ips(host: string): Promise<string[]> {
	const [v4, v6] = await Promise.all([
		resolver.resolve4(host).catch(() => [] as string[]),
		resolver.resolve6(host).catch(() => [] as string[]),
	])
	return [...v4, ...v6]
}

const check = (c: Omit<HealthCheck, 'weight'> & { weight?: number }): HealthCheck => ({ weight: 0, ...c })

// --- SPF -------------------------------------------------------------------------------------

function ipv4ToInt(ip: string) {
	return ip.split('.').reduce((acc, octet) => (acc << 8n) + BigInt(Number(octet)), 0n)
}

function ipv6ToBig(ip: string) {
	const [head, tail] = ip.split('::') as [string, string | undefined]
	const h = head ? head.split(':') : []
	const t = tail !== undefined && tail ? tail.split(':') : []
	const parts = [...h, ...Array(8 - h.length - t.length).fill('0'), ...t]
	return parts.reduce((acc, p) => (acc << 16n) + BigInt(Number.parseInt(p || '0', 16)), 0n)
}

function inCidr(ip: string, cidr: string) {
	const [base, bitsRaw] = cidr.split('/') as [string, string | undefined]
	const v = isIP(ip)
	if (v !== isIP(base)) return false
	const size = v === 4 ? 32n : 128n
	const bits = BigInt(bitsRaw ?? (v === 4 ? 32 : 128))
	const toBig = v === 4 ? ipv4ToInt : ipv6ToBig
	const mask = bits === 0n ? 0n : ((1n << bits) - 1n) << (size - bits)
	return (toBig(ip) & mask) === (toBig(base) & mask)
}

interface SpfEval {
	lookups: number
	errors: string[]
}

/** Minimal SPF evaluation: does this record allow `ip`? Handles ip4, ip6, a, mx, include, redirect. */
async function spfAllows(domain: string, ip: string, state: SpfEval, depth = 0): Promise<boolean | null> {
	if (depth > 10) return null
	const records = (await txt(domain)) ?? []
	const record = records.find(r => /^v=spf1(\s|$)/i.test(r))
	if (!record) return null
	const terms = record.split(/\s+/).slice(1)
	let redirect: string | null = null
	for (const term of terms) {
		const m = term.match(/^([+\-~?]?)([a-z0-9]+)(?:[:=](.*))?$/i)
		if (!m) continue
		const qualifier = m[1] || '+'
		const mech = m[2]!.toLowerCase()
		const value = m[3]
		const pass = qualifier === '+'
		const [target, prefix] = (value ?? domain).split('/') as [string, string | undefined]
		const withPrefix = (addr: string) => (prefix ? `${addr}/${prefix}` : addr)
		switch (mech) {
			case 'ip4':
			case 'ip6':
				if (value && inCidr(ip, value)) return pass
				break
			case 'a': {
				state.lookups++
				for (const addr of await ips(target || domain)) if (inCidr(ip, withPrefix(addr))) return pass
				break
			}
			case 'mx': {
				state.lookups++
				const mxs = await resolver.resolveMx(target || domain).catch(() => [])
				for (const mx of mxs) for (const addr of await ips(mx.exchange)) if (inCidr(ip, withPrefix(addr))) return pass
				break
			}
			case 'include': {
				state.lookups++
				if (value && (await spfAllows(value, ip, state, depth + 1))) return pass
				break
			}
			case 'exists':
			case 'ptr':
				state.lookups++
				break
			case 'all':
				return pass
			case 'redirect':
				break
		}
		if (term.toLowerCase().startsWith('redirect=')) redirect = term.slice(9)
	}
	if (redirect) {
		state.lookups++
		return spfAllows(redirect, ip, state, depth + 1)
	}
	return false
}

/** Counts DNS lookups an SPF record needs (the limit is 10, beyond it receivers treat SPF as broken). */
async function countSpfLookups(domain: string, depth = 0, seen = new Set<string>()): Promise<number> {
	if (depth > 10 || seen.has(domain)) return 0
	seen.add(domain)
	const record = ((await txt(domain)) ?? []).find(r => /^v=spf1(\s|$)/i.test(r))
	if (!record) return 0
	let total = 0
	for (const term of record.split(/\s+/).slice(1)) {
		const t = term.replace(/^[+\-~?]/, '').toLowerCase()
		if (t.startsWith('include:')) total += 1 + (await countSpfLookups(t.slice(8), depth + 1, seen))
		else if (t.startsWith('redirect=')) total += 1 + (await countSpfLookups(t.slice(9), depth + 1, seen))
		else if (
			t === 'a' ||
			t.startsWith('a:') ||
			t.startsWith('a/') ||
			t === 'mx' ||
			t.startsWith('mx:') ||
			t.startsWith('mx/')
		)
			total += 1
		else if (t.startsWith('exists:') || t === 'ptr' || t.startsWith('ptr:')) total += 1
	}
	return total
}

// --- Checks ----------------------------------------------------------------------------------

export interface HealthOptions {
	dkimSelectors?: string[]
	/** SMTP hosts the domain's mailboxes send through, checked against SPF and blocklists. */
	sendingHosts?: string[]
}

export async function checkDomain(domainInput: string, opts: HealthOptions = {}): Promise<DomainHealth> {
	const domain = domainInput.trim().toLowerCase().replace(/\.$/, '')
	const checks: HealthCheck[] = []

	// MX
	let mxHosts: { exchange: string; priority: number }[] = []
	let mxFailed = false
	try {
		mxHosts = (await resolver.resolveMx(domain)).sort((a, b) => a.priority - b.priority)
	} catch (err) {
		mxFailed = !NOT_FOUND.has((err as { code?: string }).code ?? '')
	}
	const provider = providerForMx(mxHosts.map(m => m.exchange))
	const nullMx = mxHosts.length === 1 && (mxHosts[0]!.exchange === '' || mxHosts[0]!.exchange === '.')
	if (mxFailed) {
		checks.push(
			check({
				id: 'mx',
				label: 'MX records',
				status: 'warn',
				weight: 20,
				summary: 'The MX lookup failed. Try again in a minute.',
			}),
		)
	} else if (!mxHosts.length && !nullMx) {
		checks.push(
			check({
				id: 'mx',
				label: 'MX records',
				status: 'fail',
				weight: 20,
				summary: 'No MX records: nobody can send mail to this domain.',
				detail: 'Add the MX records your mail provider gives you.',
			}),
		)
	} else if (nullMx) {
		checks.push(
			check({
				id: 'mx',
				label: 'MX records',
				status: 'warn',
				weight: 20,
				summary: 'Null MX: this domain says it does not receive mail.',
			}),
		)
	} else {
		const unresolved: string[] = []
		for (const mx of mxHosts) if (!(await ips(mx.exchange)).length) unresolved.push(mx.exchange)
		checks.push(
			check({
				id: 'mx',
				label: 'MX records',
				status: unresolved.length === mxHosts.length ? 'fail' : unresolved.length ? 'warn' : 'pass',
				weight: 20,
				summary: unresolved.length
					? `${unresolved.join(', ')} ${unresolved.length === 1 ? 'does' : 'do'} not resolve to an address.`
					: `${mxHosts.length} MX record${mxHosts.length === 1 ? '' : 's'}${provider ? `, hosted by ${provider.name}` : ''}.`,
				records: mxHosts.map(m => `${m.priority} ${m.exchange}`),
			}),
		)
	}
	if (provider?.forwardOnly && provider.note) {
		checks.push(check({ id: 'forwarding', label: 'Forwarding only', status: 'info', summary: provider.note }))
	}

	checks.push(await checkSpf(domain, provider, opts.sendingHosts ?? []))
	checks.push(await checkDkim(domain, provider, opts.dkimSelectors ?? []))
	checks.push(await checkDmarc(domain))

	if (nullMx) mxHosts = []
	const mxIps = nullMx ? [] : (await Promise.all(mxHosts.slice(0, 3).map(m => ips(m.exchange)))).flat()
	const sendIps = (await Promise.all((opts.sendingHosts ?? []).slice(0, 3).map(h => (isIP(h) ? [h] : ips(h))))).flat()
	const hostIps = [...new Set([...sendIps, ...mxIps])].filter(ip => isIP(ip) === 4).slice(0, 4)

	checks.push(await checkPtr(hostIps, provider))
	checks.push(await checkBlocklists(hostIps, provider))
	checks.push(...(await checkTransportSecurity(domain)))
	checks.push(await checkBimi(domain))

	const scored = checks.filter(c => c.weight > 0)
	const factor: Record<CheckStatus, number> = { pass: 1, warn: 0.5, fail: 0, info: 1 }
	const total = scored.reduce((s, c) => s + c.weight, 0)
	const score = total ? Math.round((scored.reduce((s, c) => s + c.weight * factor[c.status], 0) / total) * 100) : 0

	return { domain, checkedAt: new Date().toISOString(), score, provider: provider?.name ?? null, checks }
}

async function checkSpf(domain: string, provider: Provider | null, sendingHosts: string[]): Promise<HealthCheck> {
	const base = { id: 'spf', label: 'SPF', weight: 20 }
	const records = await txt(domain)
	if (records === null)
		return check({ ...base, status: 'warn', summary: 'The TXT lookup failed. Try again in a minute.' })
	const spf = records.filter(r => /^v=spf1(\s|$)/i.test(r))
	const suggestion = `v=spf1 ${provider?.spfInclude ? `include:${provider.spfInclude}` : 'mx a'} ~all`
	if (!spf.length)
		return check({
			...base,
			status: 'fail',
			summary:
				'No SPF record. Receivers cannot tell which servers may send for this domain, so mail is likely to land in spam.',
			fix: { type: 'TXT', host: '@', value: suggestion },
		})
	if (spf.length > 1)
		return check({
			...base,
			status: 'fail',
			summary: `${spf.length} SPF records. There must be exactly one, otherwise SPF fails for every message.`,
			records: spf,
			fix: { type: 'TXT', host: '@', value: suggestion, note: 'Merge them into one record and delete the others.' },
		})
	const record = spf[0]!
	const all = record.match(/([+\-~?]?)all\b/i)
	const lookups = await countSpfLookups(domain)
	const problems: string[] = []
	let status: CheckStatus = 'pass'
	if (!all) {
		problems.push('It has no "all" at the end, so mail from any server is neutral.')
		status = 'warn'
	} else if (all[1] === '+' || all[1] === '') {
		problems.push('"+all" lets every server on the internet send as this domain.')
		status = 'fail'
	} else if (all[1] === '?') {
		problems.push('"?all" is neutral: it protects nothing. Use ~all or -all.')
		status = 'warn'
	}
	if (lookups > 10) {
		problems.push(
			`It needs ${lookups} DNS lookups; receivers stop at 10 and treat SPF as broken. Remove includes you no longer use.`,
		)
		status = 'fail'
	}
	if (provider?.spfInclude && !record.toLowerCase().includes(`include:${provider.spfInclude.toLowerCase()}`)) {
		problems.push(`It does not include ${provider.name} (include:${provider.spfInclude}).`)
		if (status === 'pass') status = 'warn'
	}
	if (!provider?.managed && sendingHosts.length) {
		for (const host of sendingHosts.slice(0, 3)) {
			const addrs = isIP(host) ? [host] : await ips(host)
			for (const ip of addrs.slice(0, 2)) {
				const allowed = await spfAllows(domain, ip, { lookups: 0, errors: [] })
				if (allowed === false) {
					problems.push(`The sending server ${host} (${ip}) is not allowed by it.`)
					if (status === 'pass') status = 'warn'
				}
			}
		}
	}
	return check({
		...base,
		status,
		summary: problems.length ? problems.join(' ') : `Valid, ${lookups} of 10 lookups used.`,
		records: [record],
		fix:
			status !== 'pass' && provider?.spfInclude && !record.includes(provider.spfInclude)
				? { type: 'TXT', host: '@', value: record.replace(/\s*([~\-?+]?all)\b/i, ` include:${provider.spfInclude} $1`) }
				: undefined,
	})
}

async function checkDkim(domain: string, provider: Provider | null, configured: string[]): Promise<HealthCheck> {
	const base = { id: 'dkim', label: 'DKIM', weight: 20 }
	const selectors = [...new Set([...configured, ...(provider?.dkimSelectors ?? []), ...COMMON_DKIM_SELECTORS])]
	const found: { selector: string; record: string }[] = []
	await Promise.all(
		selectors.map(async selector => {
			const records = await txt(`${selector}._domainkey.${domain}`)
			const record = records?.find(r => /(^|;)\s*(v=DKIM1|p=|k=)/i.test(r))
			if (record) found.push({ selector, record })
		}),
	)
	if (!found.length)
		return check({
			...base,
			status: configured.length ? 'fail' : 'warn',
			summary: configured.length
				? `No DKIM key at ${configured.map(s => `${s}._domainkey`).join(', ')}.`
				: 'No DKIM key at the usual selectors. If your provider uses a custom selector, add it in the domain settings so it gets checked.',
			detail:
				provider?.dkimHelp ??
				'Turn on DKIM signing at your mail provider (cPanel: Email Deliverability) and publish the TXT record it gives you.',
		})
	const revoked: string[] = []
	const weak: string[] = []
	for (const f of found) {
		const key = f.record.match(/(?:^|;)\s*p=([^;]*)/i)?.[1]?.replace(/\s/g, '') ?? ''
		if (!key) revoked.push(f.selector)
		else if (!/k=ed25519/i.test(f.record) && key.length < 300) weak.push(f.selector)
	}
	const usable = found.length - revoked.length
	const notes = [
		usable
			? `Key found for ${found
					.filter(f => !revoked.includes(f.selector))
					.map(f => f.selector)
					.join(', ')}.`
			: '',
		weak.length
			? `${weak.join(', ')} ${weak.length === 1 ? 'uses' : 'use'} a 1024-bit key; 2048-bit is recommended.`
			: '',
		revoked.length > 3
			? 'Every selector returns an empty key: this domain revokes DKIM, so it sends no signed mail.'
			: revoked.length
				? `${revoked.join(', ')} ${revoked.length === 1 ? 'is' : 'are'} revoked (empty key).`
				: '',
	].filter(Boolean)
	return check({
		...base,
		status: !usable ? 'fail' : weak.length ? 'warn' : 'pass',
		summary: notes.join(' '),
		records: found.map(f => `${f.selector}._domainkey: ${f.record.slice(0, 80)}${f.record.length > 80 ? '...' : ''}`),
	})
}

async function checkDmarc(domain: string): Promise<HealthCheck> {
	const base = { id: 'dmarc', label: 'DMARC', weight: 20 }
	const records = await txt(`_dmarc.${domain}`)
	if (records === null)
		return check({ ...base, status: 'warn', summary: 'The TXT lookup failed. Try again in a minute.' })
	const dmarc = records.filter(r => /^v=DMARC1/i.test(r))
	const starter = `v=DMARC1; p=none; rua=mailto:dmarc@${domain}; fo=1`
	if (!dmarc.length)
		return check({
			...base,
			status: 'fail',
			summary: 'No DMARC record. Gmail, Yahoo and Outlook expect one, and without it anyone can spoof this domain.',
			fix: {
				type: 'TXT',
				host: '_dmarc',
				value: starter,
				note: 'Start with p=none and read the reports for a couple of weeks, then move to p=quarantine.',
			},
		})
	if (dmarc.length > 1)
		return check({
			...base,
			status: 'fail',
			summary: 'More than one DMARC record: receivers ignore all of them.',
			records: dmarc,
		})
	const record = dmarc[0]!
	const tags = Object.fromEntries(
		record
			.split(';')
			.map(p => p.trim().split('='))
			.filter(p => p.length === 2)
			.map(([k, v]) => [k!.toLowerCase(), v!.trim()]),
	)
	const policy = (tags.p ?? '').toLowerCase()
	const notes: string[] = []
	let status: CheckStatus = 'pass'
	if (policy === 'none') {
		status = 'warn'
		notes.push('Policy is p=none: monitoring only, spoofed mail is still delivered.')
	} else if (policy !== 'quarantine' && policy !== 'reject') {
		status = 'fail'
		notes.push('The p= policy is missing or invalid.')
	} else notes.push(`Policy is p=${policy}.`)
	if (tags.pct && Number(tags.pct) < 100) notes.push(`Only applies to ${tags.pct}% of mail.`)
	if (!tags.rua) notes.push('No rua= address, so you get no reports.')
	return check({
		...base,
		status,
		summary: notes.join(' '),
		records: [record],
		fix:
			policy === 'none'
				? {
						type: 'TXT',
						host: '_dmarc',
						value: record.replace(/p=none/i, 'p=quarantine'),
						note: 'Once SPF and DKIM pass for all your legitimate mail.',
					}
				: undefined,
	})
}

async function checkPtr(hostIps: string[], provider: Provider | null): Promise<HealthCheck> {
	const base = { id: 'ptr', label: 'Reverse DNS', weight: 5 }
	if (provider?.managed) return check({ ...base, status: 'pass', summary: `Handled by ${provider.name}.` })
	if (!hostIps.length)
		return check({ ...base, status: 'info', weight: 0, summary: 'No mail server addresses to check.' })
	const results: string[] = []
	let missing = 0
	for (const ip of hostIps) {
		const names = await resolver.reverse(ip).catch(() => [] as string[])
		const name = names[0]
		if (!name) {
			missing++
			results.push(`${ip}: no PTR record`)
			continue
		}
		const forward = await ips(name)
		if (!forward.includes(ip)) {
			missing++
			results.push(`${ip}: ${name} does not point back to it`)
		} else results.push(`${ip}: ${name}`)
	}
	return check({
		...base,
		status: missing === 0 ? 'pass' : missing === hostIps.length ? 'fail' : 'warn',
		summary: missing
			? 'Mail servers without matching reverse DNS get rejected or spam-foldered. Ask your host to set the PTR record.'
			: 'Every mail server address has matching reverse DNS.',
		records: results,
	})
}

const BLOCKLISTS = ['zen.spamhaus.org', 'bl.spamcop.net', 'b.barracudacentral.org', 'psbl.surriel.com']

async function checkBlocklists(hostIps: string[], provider: Provider | null): Promise<HealthCheck> {
	const base = { id: 'blocklists', label: 'Blocklists', weight: 10 }
	if (provider?.managed)
		return check({ ...base, status: 'pass', summary: `Shared ${provider.name} servers, monitored by them.` })
	if (!hostIps.length)
		return check({ ...base, status: 'info', weight: 0, summary: 'No mail server addresses to check.' })
	const listed: string[] = []
	const unknown: string[] = []
	for (const ip of hostIps) {
		const reversed = ip.split('.').reverse().join('.')
		await Promise.all(
			BLOCKLISTS.map(async list => {
				const answer = await resolver.resolve4(`${reversed}.${list}`).catch(() => [] as string[])
				if (!answer.length) return
				// 127.255.255.x is Spamhaus refusing queries from public resolvers, not a listing
				if (answer.every(a => a.startsWith('127.255.255.'))) unknown.push(list)
				else listed.push(`${ip} on ${list}`)
			}),
		)
	}
	if (listed.length)
		return check({
			...base,
			status: 'fail',
			summary: 'Listed on a blocklist: mail from this server gets rejected.',
			records: listed,
		})
	return check({
		...base,
		status: 'pass',
		summary: `${hostIps.join(', ')} not listed${unknown.length ? ` (${[...new Set(unknown)].join(', ')} could not be checked)` : ''}.`,
	})
}

async function checkTransportSecurity(domain: string): Promise<HealthCheck[]> {
	const out: HealthCheck[] = []
	const sts = await txt(`_mta-sts.${domain}`)
	const stsRecord = sts?.find(r => /^v=STSv1/i.test(r))
	let policyOk = false
	if (stsRecord) {
		try {
			const res = await fetch(`https://mta-sts.${domain}/.well-known/mta-sts.txt`, {
				signal: AbortSignal.timeout(5000),
			})
			policyOk = res.ok && /version:\s*STSv1/i.test(await res.text())
		} catch {}
	}
	const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
	out.push(
		check({
			id: 'mta-sts',
			label: 'MTA-STS',
			weight: 3,
			status: stsRecord && policyOk ? 'pass' : stsRecord ? 'warn' : 'info',
			summary: stsRecord
				? policyOk
					? 'Senders must use TLS when delivering to this domain.'
					: `The record exists but https://mta-sts.${domain}/.well-known/mta-sts.txt is not reachable.`
				: 'Optional. Makes senders use TLS when they deliver to you, which stops downgrade attacks.',
			records: stsRecord ? [stsRecord] : undefined,
			fix: stsRecord
				? undefined
				: {
						type: 'TXT',
						host: '_mta-sts',
						value: `v=STSv1; id=${today}`,
						note: `Also serve a policy file at https://mta-sts.${domain}/.well-known/mta-sts.txt`,
					},
		}),
	)
	const rpt = await txt(`_smtp._tls.${domain}`)
	const rptRecord = rpt?.find(r => /^v=TLSRPTv1/i.test(r))
	out.push(
		check({
			id: 'tls-rpt',
			label: 'TLS reporting',
			weight: rptRecord ? 2 : 0,
			status: rptRecord ? 'pass' : 'info',
			summary: rptRecord
				? 'Receivers report TLS delivery problems to you.'
				: 'Optional. Get reports when senders fail to deliver over TLS.',
			records: rptRecord ? [rptRecord] : undefined,
			fix: rptRecord
				? undefined
				: { type: 'TXT', host: '_smtp._tls', value: `v=TLSRPTv1; rua=mailto:tls-reports@${domain}` },
		}),
	)
	return out
}

async function checkBimi(domain: string): Promise<HealthCheck> {
	const records = await txt(`default._bimi.${domain}`)
	const bimi = records?.find(r => /^v=BIMI1/i.test(r))
	return check({
		id: 'bimi',
		label: 'BIMI logo',
		status: 'info',
		summary: bimi
			? 'Your logo is published for inboxes that show BIMI.'
			: 'Optional. Shows your logo next to your mail in Gmail, Apple Mail and Yahoo. Needs DMARC at quarantine or reject.',
		records: bimi ? [bimi] : undefined,
	})
}
