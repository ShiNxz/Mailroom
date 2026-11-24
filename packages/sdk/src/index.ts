// mailroom-sdk: send and receive email through a Mailroom server with an API token.
//
//   const mail = new Mailroom() // MAILROOM_URL and MAILROOM_TOKEN from the environment
//   const support = mail.mailbox('support@example.com', { name: 'Example Support' })
//   await support.send({ to: 'dana@client.com', subject: 'Hi', text: 'Hello!' })
//   support.on('message', async msg => { await msg.reply({ text: 'Thanks, we got it.' }) })
//
// No dependencies; runs on Node 18+, Bun, Deno and edge runtimes (fetch, streams, Web Crypto).

// --- Types ---------------------------------------------------------------------------------------

export interface Address {
	name: string
	address: string
}

/** "a@x.com", "Dana <dana@x.com>", { address, name? }, or a list of those (a string may hold several, comma separated). */
export type AddressInput = string | { name?: string; address: string } | (string | { name?: string; address: string })[]

export interface MailboxInfo {
	id: string
	address: string
	/** The sender name mail goes out with unless a send overrides it */
	name: string
	projectId: string
	project: string
}

export interface AttachmentInfo {
	partId: string
	filename: string
	contentType: string
	size: number
}

export interface MessageData {
	id: string
	mailboxId: string
	/** The mailbox address the message is in */
	mailbox: string
	folder: string
	threadId: string
	/** The Message-ID header */
	messageId: string | null
	inReplyTo: string | null
	from: Address
	to: Address[]
	cc: Address[]
	replyTo: Address[]
	subject: string
	date: string
	snippet: string
	seen: boolean
	flagged: boolean
	answered: boolean
	attachments: AttachmentInfo[]
	/** In events and single-message reads; lists leave bodies out (call message.load()) */
	text?: string
	/** The HTML as received, not sanitized: sanitize it before showing it in a browser */
	html?: string | null
}

export type SendStatus = 'queued' | 'sending' | 'sent' | 'failed' | 'cancelled'

export interface SendResult {
	id: string
	mailboxId: string
	status: SendStatus
	subject: string
	to: Address[]
	sendAt: string
	sentAt: string | null
	error: string | null
	/** The Message-ID header, once sent */
	messageId: string | null
}

export interface Attachment {
	filename: string
	/** Text is sent as UTF-8; bytes as they are. Use { base64 } for content that is already base64. */
	content?: string | Uint8Array | ArrayBuffer
	base64?: string
	contentType?: string
}

export interface SendOptions {
	to: AddressInput
	cc?: AddressInput
	bcc?: AddressInput
	replyTo?: AddressInput
	subject: string
	text?: string
	html?: string
	attachments?: Attachment[]
	/** Send later (up to a year ahead) */
	sendAt?: Date | string
	/** The same key within a day sends once, so a retried request never sends twice */
	idempotencyKey?: string
	/** The From name for this message; defaults to the mailbox handle's name, then the mailbox's own */
	name?: string
	/** The Mailroom id of a message this answers, for threading (msg.reply() does this for you) */
	inReplyTo?: string
	/** Resolve once the message went out (or throw if it failed) instead of when it was queued */
	wait?: boolean | { timeoutMs?: number }
	/**
	 * Extra headers: List-* (List-Unsubscribe, List-Id...), Auto-Submitted, Precedence, Feedback-ID and your
	 * own X- headers. Mailroom's own headers (From, To, Subject, Message-ID...) can't be set.
	 */
	headers?: Record<string, string>
	/**
	 * One-click unsubscribe (RFC 8058), as Gmail and Yahoo require for bulk mail: an https URL that
	 * unsubscribes the recipient when POSTed to. Sets List-Unsubscribe and List-Unsubscribe-Post.
	 */
	unsubscribe?: string
}

export interface ReplyOptions
	extends Pick<
		SendOptions,
		'text' | 'html' | 'attachments' | 'sendAt' | 'idempotencyKey' | 'name' | 'wait' | 'headers' | 'unsubscribe'
	> {
	/** Also to everyone else on the original */
	replyAll?: boolean
}

export interface ListOptions {
	/** Mailbox address or id; every mailbox the token covers when left out */
	mailbox?: string
	/** inbox (default), sent, archive, trash, junk, drafts, all, or a folder path */
	folder?: string
	unread?: boolean
	/** Search words (subject, sender, text) */
	q?: string
	limit?: number
	cursor?: string
}

export type MailroomEventName = 'message' | 'sent' | 'failed' | 'ready' | 'error'

type Handlers = {
	message: (message: Message) => unknown
	sent: (send: SendResult) => unknown
	failed: (send: SendResult) => unknown
	ready: (info: { cursor: string }) => unknown
	error: (error: Error) => unknown
}

export type WebhookEvent =
	| {
			id: string
			type: 'message.received'
			createdAt: string
			mailbox: { id: string; address: string }
			message: MessageData
	  }
	| {
			id: string
			type: 'message.sent' | 'message.failed'
			createdAt: string
			mailbox: { id: string; address: string }
			send: SendResult
	  }
	| { id: string; type: 'ping'; createdAt: string }

export class MailroomError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly code?: string,
	) {
		super(message)
		this.name = 'MailroomError'
	}
}

export interface MailroomOptions {
	/** Your Mailroom address, like https://mail.example.com (MAILROOM_URL) */
	url?: string
	/** The API service directly, like http://mailroom-api:3001 inside your network (MAILROOM_API_URL). Instead of url. */
	apiUrl?: string
	/** An API token from Settings > API tokens (MAILROOM_TOKEN) */
	token?: string
	/** Resume listening after this event id (from mail.cursor) instead of from now */
	after?: string
	fetch?: typeof fetch
}

// --- Helpers -------------------------------------------------------------------------------------

const env = (name: string): string | undefined => {
	const g = globalThis as {
		process?: { env?: Record<string, string | undefined> }
		Deno?: { env: { get(n: string): string | undefined } }
	}
	try {
		return g.process?.env?.[name] ?? g.Deno?.env.get(name)
	} catch {
		return undefined
	}
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function bytesToBase64(bytes: Uint8Array): string {
	const B = (globalThis as { Buffer?: { from(b: Uint8Array): { toString(enc: string): string } } }).Buffer
	if (B) return B.from(bytes).toString('base64')
	let s = ''
	for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
	return btoa(s)
}

function attachmentBody(a: Attachment) {
	let content: string
	if (a.base64 !== undefined) content = a.base64
	else if (typeof a.content === 'string') content = bytesToBase64(new TextEncoder().encode(a.content))
	else if (a.content instanceof ArrayBuffer) content = bytesToBase64(new Uint8Array(a.content))
	else if (a.content) content = bytesToBase64(a.content)
	else throw new Error(`Attachment ${a.filename} has no content`)
	return { filename: a.filename, content, contentType: a.contentType }
}

const toList = (v: AddressInput | undefined) => (v === undefined ? undefined : Array.isArray(v) ? v : [v])

/** The headers to send: the ones given, plus the two one-click unsubscribe headers. */
function headersOf(o: { headers?: Record<string, string>; unsubscribe?: string }) {
	if (!o.unsubscribe) return o.headers
	const url = new URL(o.unsubscribe)
	if (url.protocol !== 'https:') throw new Error('unsubscribe must be an https URL (RFC 8058)')
	return {
		...o.headers,
		'List-Unsubscribe': `<${url.href}>`,
		'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
	}
}

async function subtle(): Promise<SubtleCrypto> {
	const c = (globalThis as { crypto?: Crypto }).crypto
	if (c?.subtle) return c.subtle
	const node = (await import('node:crypto' as string)) as { webcrypto: Crypto }
	return node.webcrypto.subtle
}

function equalHex(a: string, b: string) {
	if (a.length !== b.length) return false
	let diff = 0
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
	return diff === 0
}

// --- Messages ------------------------------------------------------------------------------------

/** A message, with shortcuts to answer and mark it. */
export class Message implements MessageData {
	id!: string
	mailboxId!: string
	mailbox!: string
	folder!: string
	threadId!: string
	messageId!: string | null
	inReplyTo!: string | null
	from!: Address
	to!: Address[]
	cc!: Address[]
	replyTo!: Address[]
	subject!: string
	date!: string
	snippet!: string
	seen!: boolean
	flagged!: boolean
	answered!: boolean
	attachments!: AttachmentInfo[]
	text?: string
	html?: string | null

	constructor(
		private readonly client: Mailroom,
		data: MessageData,
	) {
		Object.assign(this, data)
	}

	/** Answers the sender (or everyone with replyAll), threaded under this message. */
	reply(options: ReplyOptions): Promise<SendResult> {
		return this.client.replyTo(this.id, options)
	}

	/** The bodies, when this message came from a list. */
	async load(): Promise<this> {
		const { message } = await this.client.request<{ message: MessageData }>(
			'GET',
			`/messages/${encodeURIComponent(this.id)}`,
		)
		Object.assign(this, message)
		return this
	}

	markRead() {
		return this.mark({ seen: true })
	}
	markUnread() {
		return this.mark({ seen: false })
	}
	star() {
		return this.mark({ flagged: true })
	}
	unstar() {
		return this.mark({ flagged: false })
	}

	private async mark(change: { seen?: boolean; flagged?: boolean }) {
		const { message } = await this.client.request<{ message: MessageData }>(
			'PATCH',
			`/messages/${encodeURIComponent(this.id)}`,
			change,
		)
		this.seen = message.seen
		this.flagged = message.flagged
		return this
	}

	toJSON(): MessageData {
		const { client: _client, ...data } = this as unknown as MessageData & { client: unknown }
		return data
	}
}

// --- Mailbox handles -----------------------------------------------------------------------------

/** One mailbox: send from it and listen to what arrives in it. */
export class Mailbox {
	constructor(
		private readonly client: Mailroom,
		/** The mailbox address (or id) */
		readonly address: string,
		/** The From name for sends from this handle; the mailbox's own name when left out */
		readonly name?: string,
	) {}

	send(options: SendOptions): Promise<SendResult> {
		return this.client.send({ ...options, from: this.address, name: options.name ?? this.name })
	}

	messages(options: Omit<ListOptions, 'mailbox'> = {}) {
		return this.client.messages({ ...options, mailbox: this.address })
	}

	/** New mail in this mailbox's inbox. */
	on(event: 'message', handler: Handlers['message']): () => void
	/** This token's sends from this mailbox that went out, or failed for good. */
	on(event: 'sent' | 'failed', handler: Handlers['sent']): () => void
	on(event: 'message' | 'sent' | 'failed', handler: (value: never) => unknown): () => void {
		const mine = (box: { address: string; id: string }) =>
			box.address.toLowerCase() === this.address.toLowerCase() || box.id === this.address
		return this.client.subscribe(event, handler as (v: unknown) => unknown, mine)
	}
}

// --- The client ----------------------------------------------------------------------------------

type Listener = {
	event: MailroomEventName
	handler: (v: unknown) => unknown
	filter?: (box: { address: string; id: string }) => boolean
}

export class Mailroom {
	private readonly base: string
	private readonly token: string
	private readonly fetchImpl: typeof fetch
	private listeners: Listener[] = []
	private streaming = false
	private closed = false
	private controller: AbortController | null = null
	private lastEventId: string | null

	constructor(options: MailroomOptions = {}) {
		const apiUrl = options.apiUrl ?? (options.url ? undefined : env('MAILROOM_API_URL'))
		const url = options.url ?? env('MAILROOM_URL')
		const token = options.token ?? env('MAILROOM_TOKEN')
		if (!apiUrl && !url) throw new Error('Mailroom: set MAILROOM_URL or pass { url }')
		if (!token) throw new Error('Mailroom: set MAILROOM_TOKEN or pass { token }')
		// The web app serves the API under /api; the API service itself has no prefix
		this.base = apiUrl ? apiUrl.replace(/\/+$/, '') : `${url!.replace(/\/+$/, '').replace(/\/api$/, '')}/api`
		this.token = token
		this.fetchImpl = options.fetch ?? fetch.bind(globalThis)
		this.lastEventId = options.after ?? null
	}

	/** The last event seen. Save it and pass it back as { after } to pick up where you left off. */
	get cursor(): string | null {
		return this.lastEventId
	}

	async request<T>(method: string, path: string, body?: unknown): Promise<T> {
		const res = await this.fetchImpl(`${this.base}${path}`, {
			method,
			headers: {
				authorization: `Bearer ${this.token}`,
				accept: 'application/json',
				...(body === undefined ? {} : { 'content-type': 'application/json' }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		})
		const text = await res.text()
		let data: unknown = null
		try {
			data = text ? JSON.parse(text) : null
		} catch {
			data = { error: text }
		}
		if (!res.ok) {
			const err = data as { error?: string; code?: string } | null
			throw new MailroomError(err?.error ?? `Mailroom answered ${res.status}`, res.status, err?.code)
		}
		return data as T
	}

	/** Which token this is, and whose. */
	whoami() {
		return this.request<{
			token: { id: string; name: string; canRead: boolean; canSend: boolean; expiresAt: string | null } | null
			user: { id: string; email: string; name: string }
		}>('GET', '/token')
	}

	/** The mailboxes this token can use. */
	async mailboxes(): Promise<MailboxInfo[]> {
		return (await this.request<{ mailboxes: MailboxInfo[] }>('GET', '/mailboxes')).mailboxes
	}

	/** A handle for one mailbox. `name` overrides the sender name for its sends. */
	mailbox(address: string, options: { name?: string } = {}) {
		return new Mailbox(this, address, options.name)
	}

	/** Sends from a mailbox (`from`: its address or id). Resolves once queued, or once sent with { wait }. */
	async send(options: SendOptions & { from: string }): Promise<SendResult> {
		const { send } = await this.request<{ send: SendResult }>('POST', '/messages', {
			from: options.from,
			fromName: options.name,
			to: toList(options.to),
			cc: toList(options.cc),
			bcc: toList(options.bcc),
			replyTo: toList(options.replyTo),
			subject: options.subject,
			text: options.text,
			html: options.html,
			attachments: options.attachments?.map(attachmentBody),
			sendAt: options.sendAt instanceof Date ? options.sendAt.toISOString() : options.sendAt,
			idempotencyKey: options.idempotencyKey,
			inReplyTo: options.inReplyTo,
			headers: headersOf(options),
		})
		return options.wait ? this.waitForSend(send.id, typeof options.wait === 'object' ? options.wait : {}) : send
	}

	async replyTo(messageId: string, options: ReplyOptions): Promise<SendResult> {
		const { send } = await this.request<{ send: SendResult }>(
			'POST',
			`/messages/${encodeURIComponent(messageId)}/reply`,
			{
				text: options.text,
				html: options.html,
				replyAll: options.replyAll,
				fromName: options.name,
				attachments: options.attachments?.map(attachmentBody),
				sendAt: options.sendAt instanceof Date ? options.sendAt.toISOString() : options.sendAt,
				idempotencyKey: options.idempotencyKey,
				headers: headersOf(options),
			},
		)
		return options.wait ? this.waitForSend(send.id, typeof options.wait === 'object' ? options.wait : {}) : send
	}

	/** Where a send is: queued, sending, sent, failed or cancelled. */
	async getSend(id: string): Promise<SendResult> {
		return (await this.request<{ send: SendResult }>('GET', `/outbox/${encodeURIComponent(id)}`)).send
	}

	/** Waits until a send went out (resolves) or failed for good (throws). */
	async waitForSend(id: string, { timeoutMs = 120_000 }: { timeoutMs?: number } = {}): Promise<SendResult> {
		const end = Date.now() + timeoutMs
		for (let delay = 500; ; delay = Math.min(delay * 1.5, 5000)) {
			const send = await this.getSend(id)
			if (send.status === 'sent') return send
			if (send.status === 'failed' || send.status === 'cancelled')
				throw new MailroomError(send.error ?? `The send was ${send.status}`, 422, send.status)
			if (Date.now() > end) throw new MailroomError('Timed out waiting for the send', 408, 'timeout')
			await sleep(delay)
		}
	}

	/** A page of messages, newest first; pass nextCursor back for the next page. */
	async messages(options: ListOptions = {}): Promise<{ messages: Message[]; nextCursor: string | null }> {
		const q = new URLSearchParams()
		for (const [k, v] of Object.entries(options)) if (v !== undefined) q.set(k, String(v))
		const qs = q.toString()
		const r = await this.request<{ messages: MessageData[]; nextCursor: string | null }>(
			'GET',
			`/messages${qs ? `?${qs}` : ''}`,
		)
		return { messages: r.messages.map(m => new Message(this, m)), nextCursor: r.nextCursor }
	}

	/** One message with its bodies. */
	async message(id: string): Promise<Message> {
		const { message } = await this.request<{ message: MessageData }>('GET', `/messages/${encodeURIComponent(id)}`)
		return new Message(this, message)
	}

	// --- Listening ----------------------------------------------------------------------------------

	/** New mail in any mailbox the token can read. */
	on(event: 'message', handler: Handlers['message']): () => void
	/** This token's sends that went out, or failed for good. */
	on(event: 'sent' | 'failed', handler: Handlers['sent']): () => void
	/** The stream connected (again); `cursor` is where it picks up. */
	on(event: 'ready', handler: Handlers['ready']): () => void
	/** Connection problems (it keeps reconnecting) and errors thrown by your handlers. */
	on(event: 'error', handler: Handlers['error']): () => void
	on(event: MailroomEventName, handler: (value: never) => unknown): () => void {
		return this.subscribe(event, handler as (v: unknown) => unknown)
	}

	/** Used by mailbox handles. Returns a function that removes the listener. */
	subscribe(event: MailroomEventName, handler: (v: unknown) => unknown, filter?: Listener['filter']) {
		const listener: Listener = { event, handler, filter }
		this.listeners.push(listener)
		if (event !== 'error' && event !== 'ready') this.startStream()
		return () => {
			this.listeners = this.listeners.filter(l => l !== listener)
		}
	}

	/** Stops listening. */
	close() {
		this.closed = true
		this.controller?.abort()
	}

	private emit(event: MailroomEventName, value: unknown, box?: { address: string; id: string }) {
		for (const l of this.listeners) {
			if (l.event !== event) continue
			if (l.filter && (!box || !l.filter(box))) continue
			try {
				const out = l.handler(value)
				if (out && typeof (out as Promise<unknown>).catch === 'function')
					(out as Promise<unknown>).catch(err => this.emitError(err))
			} catch (err) {
				this.emitError(err)
			}
		}
	}

	private emitError(err: unknown) {
		const error = err instanceof Error ? err : new Error(String(err))
		if (this.listeners.some(l => l.event === 'error')) this.emit('error', error)
		else console.error('[mailroom]', error)
	}

	private startStream() {
		if (this.streaming || this.closed) return
		this.streaming = true
		void this.listen()
	}

	/** Server-sent events with reconnects; nothing is missed across them (within 7 days). */
	private async listen() {
		let delay = 1000
		while (!this.closed) {
			const controller = new AbortController()
			this.controller = controller
			// The server pings every 25 s; a minute of silence means the connection is gone
			let idle: ReturnType<typeof setTimeout> | undefined
			const touch = () => {
				clearTimeout(idle)
				idle = setTimeout(() => controller.abort(), 60_000)
			}
			try {
				touch()
				const after = this.lastEventId ? `?after=${encodeURIComponent(this.lastEventId)}` : ''
				const res = await this.fetchImpl(`${this.base}/stream${after}`, {
					headers: { authorization: `Bearer ${this.token}`, accept: 'text/event-stream' },
					signal: controller.signal,
				})
				if (res.status === 401 || res.status === 403) {
					const text = await res.text().catch(() => '')
					let message = `Mailroom refused the stream (${res.status})`
					try {
						message = (JSON.parse(text) as { error?: string }).error ?? message
					} catch {}
					this.emitError(new MailroomError(message, res.status))
					this.closed = true
					break
				}
				if (!res.ok || !res.body) throw new MailroomError(`Mailroom answered ${res.status}`, res.status)
				delay = 1000
				const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
				let buffer = ''
				for (;;) {
					const { value, done } = await reader.read()
					if (done) break
					touch()
					buffer += value
					let end = buffer.indexOf('\n\n')
					while (end >= 0) {
						this.handleFrame(buffer.slice(0, end))
						buffer = buffer.slice(end + 2)
						end = buffer.indexOf('\n\n')
					}
				}
			} catch (err) {
				if (this.closed) break
				if (!(err instanceof Error && err.name === 'AbortError')) this.emitError(err)
			} finally {
				clearTimeout(idle)
			}
			if (this.closed) break
			await sleep(delay)
			delay = Math.min(delay * 2, 30_000)
		}
		this.streaming = false
	}

	private handleFrame(frame: string) {
		let event = 'message'
		let id: string | null = null
		const data: string[] = []
		for (const line of frame.split('\n')) {
			if (line.startsWith(':')) continue
			const at = line.indexOf(':')
			const field = at < 0 ? line : line.slice(0, at)
			const value = at < 0 ? '' : line.slice(at + 1).replace(/^ /, '')
			if (field === 'event') event = value
			else if (field === 'id') id = value
			else if (field === 'data') data.push(value)
		}
		if (!data.length) return
		let payload: WebhookEvent | { cursor: string } | { error: string }
		try {
			payload = JSON.parse(data.join('\n'))
		} catch {
			return
		}
		if (event === 'ready') {
			if (!this.lastEventId) this.lastEventId = (payload as { cursor: string }).cursor
			this.emit('ready', { cursor: this.lastEventId })
			return
		}
		if (event === 'error') {
			this.emitError(new MailroomError((payload as { error: string }).error, 401))
			return
		}
		if (id) this.lastEventId = id
		const e = payload as WebhookEvent
		if (e.type === 'message.received') this.emit('message', new Message(this, e.message), e.mailbox)
		else if (e.type === 'message.sent') this.emit('sent', e.send, e.mailbox)
		else if (e.type === 'message.failed') this.emit('failed', e.send, e.mailbox)
	}

	// --- Webhooks -----------------------------------------------------------------------------------

	/**
	 * Checks a webhook delivery: `body` is the raw request body (a string, before JSON.parse), `signature`
	 * the Mailroom-Signature header, `secret` the token's webhook secret. Refuses deliveries older than
	 * `toleranceSeconds` (replays).
	 */
	static async verifyWebhook(
		body: string,
		signature: string | null | undefined,
		secret: string,
		toleranceSeconds = 300,
	) {
		const match = signature?.match(/^t=(\d+),v1=([0-9a-f]{64})$/)
		if (!match) return false
		const [, t, v1] = match
		if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSeconds) return false
		const s = await subtle()
		const key = await s.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
			'sign',
		])
		const mac = new Uint8Array(await s.sign('HMAC', key, new TextEncoder().encode(`${t}.${body}`)))
		const hex = Array.from(mac, b => b.toString(16).padStart(2, '0')).join('')
		return equalHex(hex, v1!)
	}

	/** verifyWebhook, then the parsed event; throws when the signature is wrong. */
	static async parseWebhook(body: string, signature: string | null | undefined, secret: string): Promise<WebhookEvent> {
		if (!(await Mailroom.verifyWebhook(body, signature, secret))) throw new MailroomError('Bad webhook signature', 401)
		return JSON.parse(body) as WebhookEvent
	}
}

export default Mailroom
