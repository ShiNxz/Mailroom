// Types shared by the API (apps/server) and the web app (apps/web). Everything here is JSON: dates are ISO strings.

export type Role = 'owner' | 'admin' | 'member'
export type ProjectAccess = 'all' | 'selected'
export type Security = 'tls' | 'starttls' | 'none'

export interface Address {
	name: string
	address: string
}

export interface UserSettings {
	/** Seconds a sent message waits in the outbox so it can be undone. 0 sends right away. */
	undoSeconds?: number
	/** Load remote images in emails without asking. */
	showImages?: boolean
	/** Ask the browser for desktop notifications on new mail. */
	notifications?: boolean
	/** The person's own sidebar: order and hidden projects and mailboxes. */
	sidebar?: SidebarPrefs
}

/** Ids are kept in order; ones that no longer exist are ignored, new ones go after the known ones. */
export interface SidebarPrefs {
	projectOrder?: string[]
	/** Per project id: its mailboxes in order */
	mailboxOrder?: Record<string, string[]>
	hiddenProjects?: string[]
	hiddenMailboxes?: string[]
}

export interface User {
	id: string
	email: string
	name: string
	role: Role
	disabled: boolean
	settings: UserSettings
	createdAt: string
}

export interface ProjectGrant {
	projectId: string
	access: ProjectAccess
	/** Only used when access is 'selected'. */
	mailboxIds: string[]
}

export interface UserWithAccess extends User {
	grants: ProjectGrant[]
}

export type MailboxStatus = 'connecting' | 'syncing' | 'idle' | 'error' | 'paused'

export interface Mailbox {
	id: string
	projectId: string
	domainId: string | null
	address: string
	displayName: string
	status: MailboxStatus
	statusMessage: string | null
	lastSyncAt: string | null
	/** Messages synced so far, and the server's total across synced folders. */
	syncedCount: number
	totalCount: number
	unread: number
	/** The signature this user gets for this mailbox: their own if set, else the mailbox default. */
	signature: string
	/** The mailbox default signature. */
	defaultSignature: string
	enabled: boolean
}

/** Connection settings, only shown to admins. The password never leaves the server. */
export interface MailboxSettings {
	address: string
	displayName: string
	username: string
	imapHost: string
	imapPort: number
	imapSecurity: Security
	smtpHost: string
	smtpPort: number
	smtpSecurity: Security
	saveSent: boolean
	signature: string
	enabled: boolean
}

export interface Domain {
	id: string
	projectId: string
	name: string
	dkimSelectors: string[]
	health: DomainHealth | null
	checkedAt: string | null
}

export interface Project {
	id: string
	name: string
	color: string
	description: string
	domains: Domain[]
	mailboxes: Mailbox[]
	/** What the current user can do here. Admins and the owner manage every project. */
	canManage: boolean
}

export type SpecialUse = 'inbox' | 'sent' | 'drafts' | 'trash' | 'junk' | 'archive' | 'all' | 'flagged'

export interface Folder {
	id: string
	mailboxId: string
	path: string
	name: string
	specialUse: SpecialUse | null
	total: number
	unread: number
	synced: number
	backfillDone: boolean
}

/** Virtual views that span folders. Combined with mailboxId/projectId filters. */
export type View =
	| 'inbox'
	| 'unread'
	| 'starred'
	| 'snoozed'
	| 'sent'
	| 'scheduled'
	| 'drafts'
	| 'archive'
	| 'trash'
	| 'junk'
	| 'all'

export interface Attachment {
	partId: string
	filename: string
	contentType: string
	size: number
	/** Content-ID for inline images referenced as cid: in the HTML. */
	cid: string | null
	inline: boolean
}

export interface ThreadRow {
	threadId: string
	mailboxId: string
	/** The newest message in the thread for this view. */
	messageId: string
	subject: string
	snippet: string
	participants: Address[]
	from: Address
	date: string
	count: number
	unread: boolean
	starred: boolean
	hasAttachments: boolean
	snoozedUntil: string | null
	folderIds: string[]
}

export interface Message {
	id: string
	mailboxId: string
	folderId: string
	threadId: string
	messageId: string | null
	subject: string
	from: Address
	to: Address[]
	cc: Address[]
	bcc: Address[]
	replyTo: Address[]
	date: string
	snippet: string
	/** Sanitized HTML, or null when the message is plain text. */
	html: string | null
	text: string
	attachments: Attachment[]
	seen: boolean
	flagged: boolean
	answered: boolean
	snoozedUntil: string | null
	references: string[]
	listUnsubscribe: string | null
	hasRemoteImages: boolean
}

export interface Thread {
	threadId: string
	mailboxId: string
	subject: string
	messages: Message[]
}

export type OutboxStatus = 'queued' | 'sending' | 'sent' | 'failed' | 'cancelled'

export interface ComposePayload {
	mailboxId: string
	to: Address[]
	cc: Address[]
	bcc: Address[]
	subject: string
	html: string
	/** The message this replies to or forwards (our id), used for threading headers. */
	replyToMessageId?: string | null
	forwardOfMessageId?: string | null
	attachmentIds: string[]
	/** Attachments forwarded from the original message, by part id. */
	forwardAttachments?: string[]
	/** Overrides the mailbox's sender name for this message (API sends). */
	fromName?: string | null
	replyTo?: Address[]
	/** Plain-text body. With html empty, the message goes out as text only. */
	text?: string | null
}

export interface OutboxItem {
	id: string
	mailboxId: string
	status: OutboxStatus
	sendAt: string
	sentAt: string | null
	error: string | null
	attempts: number
	payload: ComposePayload
	/** The Message-ID header, once sent */
	messageId: string | null
	createdAt: string
}

export interface Draft {
	id: string
	mailboxId: string | null
	payload: Partial<ComposePayload>
	updatedAt: string
}

export interface Upload {
	id: string
	filename: string
	contentType: string
	size: number
}

export interface Template {
	id: string
	projectId: string | null
	name: string
	subject: string
	html: string
	createdBy: string
}

export interface Contact {
	name: string
	address: string
	count: number
}

// --- Domain health ---------------------------------------------------------------------------

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'info'

export interface DnsFix {
	type: 'TXT' | 'MX' | 'CNAME' | 'A'
	host: string
	value: string
	note?: string
}

export interface HealthCheck {
	id: string
	label: string
	status: CheckStatus
	summary: string
	detail?: string
	records?: string[]
	fix?: DnsFix
	/** Points this check counts for in the score. 0 for informational checks. */
	weight: number
}

export interface DomainHealth {
	domain: string
	checkedAt: string
	score: number
	provider: string | null
	checks: HealthCheck[]
}

export interface AutoconfigResult {
	source: 'provider' | 'ispdb' | 'autoconfig' | 'srv' | 'guess'
	provider: string | null
	imapHost: string
	imapPort: number
	imapSecurity: Security
	smtpHost: string
	smtpPort: number
	smtpSecurity: Security
	username: string
	saveSent: boolean
	note?: string
}

// --- Realtime -------------------------------------------------------------------------------

export type ServerEvent =
	| {
			type: 'messages'
			mailboxId: string
			folderId: string
			newInbox?: { messageId: string; from: Address; subject: string }[]
	  }
	| { type: 'mailbox'; mailboxId: string; status: MailboxStatus; statusMessage: string | null }
	| { type: 'folders'; mailboxId: string }
	| { type: 'outbox'; mailboxId: string; id: string; status: OutboxStatus; error: string | null }
	| { type: 'access' }
	| { type: 'branding' }

/** How the app names and shows itself. Set by admins in Settings; logoUrl null shows the default mark. */
export interface Branding {
	name: string
	logoUrl: string | null
}

export const DEFAULT_BRANDING: Branding = { name: 'Mailroom', logoUrl: null }

export const formatAddress = (a: Address) => (a.name ? `${a.name} <${a.address}>` : a.address)

export const ROLE_LABELS: Record<Role, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' }

export const isAdminRole = (role: Role) => role === 'owner' || role === 'admin'
