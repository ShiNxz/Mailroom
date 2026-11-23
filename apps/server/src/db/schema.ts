import type {
	Address,
	Attachment,
	ComposePayload,
	DomainHealth,
	MailboxStatus,
	OutboxStatus,
	ProjectAccess,
	Role,
	Security,
	SpecialUse,
	UserSettings,
} from '@mailroom/shared'
import { type SQL, sql } from 'drizzle-orm'
import {
	bigint,
	boolean,
	customType,
	index,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uniqueIndex,
} from 'drizzle-orm/pg-core'
import { newId } from '../lib/ids'

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' })
const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' })

const id = () =>
	text('id')
		.primaryKey()
		.$defaultFn(() => newId())
const createdAt = () => timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow()
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })

// --- People ---------------------------------------------------------------------------------

export const users = pgTable('users', {
	id: id(),
	email: text('email').notNull().unique(),
	name: text('name').notNull(),
	passwordHash: text('password_hash').notNull(),
	role: text('role').$type<Role>().notNull().default('member'),
	settings: jsonb('settings').$type<UserSettings>().notNull().default({}),
	disabled: boolean('disabled').notNull().default(false),
	createdAt: createdAt(),
})

export const sessions = pgTable(
	'sessions',
	{
		/** sha256 of the token, so a database leak doesn't leak sessions. */
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		label: text('label'),
		createdAt: createdAt(),
		lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
		expiresAt: ts('expires_at').notNull(),
	},
	t => [index('sessions_user_idx').on(t.userId)],
)

// --- Projects, domains, mailboxes -------------------------------------------------------------

export const projects = pgTable('projects', {
	id: id(),
	name: text('name').notNull(),
	color: text('color').notNull().default('#6366f1'),
	description: text('description').notNull().default(''),
	position: integer('position').notNull().default(0),
	createdAt: createdAt(),
})

export const domains = pgTable('domains', {
	id: id(),
	projectId: text('project_id')
		.notNull()
		.references(() => projects.id, { onDelete: 'cascade' }),
	name: text('name').notNull().unique(),
	dkimSelectors: text('dkim_selectors').array().notNull().default(sql`'{}'::text[]`),
	health: jsonb('health').$type<DomainHealth>(),
	checkedAt: ts('checked_at'),
	createdAt: createdAt(),
})

export const mailboxes = pgTable(
	'mailboxes',
	{
		id: id(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id, { onDelete: 'cascade' }),
		domainId: text('domain_id').references(() => domains.id, { onDelete: 'set null' }),
		address: text('address').notNull().unique(),
		displayName: text('display_name').notNull().default(''),
		username: text('username').notNull(),
		/** Encrypted with APP_SECRET, see lib/crypto.ts */
		secret: text('secret').notNull(),
		imapHost: text('imap_host').notNull(),
		imapPort: integer('imap_port').notNull(),
		imapSecurity: text('imap_security').$type<Security>().notNull(),
		smtpHost: text('smtp_host').notNull(),
		smtpPort: integer('smtp_port').notNull(),
		smtpSecurity: text('smtp_security').$type<Security>().notNull(),
		/** Append sent mail to the Sent folder. Off for providers that do it themselves (Gmail, Outlook). */
		saveSent: boolean('save_sent').notNull().default(true),
		signature: text('signature').notNull().default(''),
		enabled: boolean('enabled').notNull().default(true),
		status: text('status').$type<MailboxStatus>().notNull().default('connecting'),
		statusMessage: text('status_message'),
		lastSyncAt: ts('last_sync_at'),
		createdAt: createdAt(),
	},
	t => [index('mailboxes_project_idx').on(t.projectId)],
)

/** A user's access to a project: every mailbox in it, or only the ones in mailbox_members. */
export const projectMembers = pgTable(
	'project_members',
	{
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id, { onDelete: 'cascade' }),
		access: text('access').$type<ProjectAccess>().notNull().default('all'),
	},
	t => [primaryKey({ columns: [t.userId, t.projectId] })],
)

export const mailboxMembers = pgTable(
	'mailbox_members',
	{
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		mailboxId: text('mailbox_id')
			.notNull()
			.references(() => mailboxes.id, { onDelete: 'cascade' }),
	},
	t => [primaryKey({ columns: [t.userId, t.mailboxId] })],
)

/** A user's own signature for a mailbox, used instead of the mailbox default. */
export const signatures = pgTable(
	'signatures',
	{
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		mailboxId: text('mailbox_id')
			.notNull()
			.references(() => mailboxes.id, { onDelete: 'cascade' }),
		html: text('html').notNull(),
	},
	t => [primaryKey({ columns: [t.userId, t.mailboxId] })],
)

// --- Mail -----------------------------------------------------------------------------------

export const folders = pgTable(
	'folders',
	{
		id: id(),
		mailboxId: text('mailbox_id')
			.notNull()
			.references(() => mailboxes.id, { onDelete: 'cascade' }),
		path: text('path').notNull(),
		name: text('name').notNull(),
		delimiter: text('delimiter').notNull().default('/'),
		specialUse: text('special_use').$type<SpecialUse>(),
		uidValidity: bigint('uid_validity', { mode: 'number' }),
		/** Highest UID synced: everything above it is new. */
		maxUid: bigint('max_uid', { mode: 'number' }).notNull().default(0),
		/** Lowest UID synced by the history backfill, which walks down from the newest. */
		minUid: bigint('min_uid', { mode: 'number' }),
		backfillDone: boolean('backfill_done').notNull().default(false),
		highestModseq: text('highest_modseq'),
		total: integer('total').notNull().default(0),
		unread: integer('unread').notNull().default(0),
		/** Set when the folder is gone from the server. Its messages are deleted with it. */
		syncedAt: ts('synced_at'),
	},
	t => [uniqueIndex('folders_mailbox_path_idx').on(t.mailboxId, t.path)],
)

export const messages = pgTable(
	'messages',
	{
		id: id(),
		mailboxId: text('mailbox_id')
			.notNull()
			.references(() => mailboxes.id, { onDelete: 'cascade' }),
		folderId: text('folder_id')
			.notNull()
			.references(() => folders.id, { onDelete: 'cascade' }),
		uid: bigint('uid', { mode: 'number' }).notNull(),
		messageId: text('message_id'),
		threadId: text('thread_id').notNull(),
		inReplyTo: text('in_reply_to'),
		references: text('references').array().notNull().default(sql`'{}'::text[]`),
		subject: text('subject').notNull().default(''),
		fromName: text('from_name').notNull().default(''),
		fromAddress: text('from_address').notNull().default(''),
		to: jsonb('to').$type<Address[]>().notNull().default([]),
		cc: jsonb('cc').$type<Address[]>().notNull().default([]),
		bcc: jsonb('bcc').$type<Address[]>().notNull().default([]),
		replyTo: jsonb('reply_to').$type<Address[]>().notNull().default([]),
		date: ts('date').notNull(),
		/** What lists sort by: the date, or when a snooze ends so the thread comes back on top. */
		sortAt: ts('sort_at').notNull(),
		snippet: text('snippet').notNull().default(''),
		textBody: text('text_body').notNull().default(''),
		htmlBody: text('html_body'),
		attachments: jsonb('attachments').$type<Attachment[]>().notNull().default([]),
		hasAttachments: boolean('has_attachments').notNull().default(false),
		listUnsubscribe: text('list_unsubscribe'),
		seen: boolean('seen').notNull().default(false),
		flagged: boolean('flagged').notNull().default(false),
		answered: boolean('answered').notNull().default(false),
		draft: boolean('draft').notNull().default(false),
		size: integer('size').notNull().default(0),
		snoozedUntil: ts('snoozed_until'),
		createdAt: createdAt(),
		search: tsvector('search').generatedAlwaysAs(
			(): SQL =>
				sql`setweight(to_tsvector('simple', coalesce(${messages.subject}, '')), 'A') || setweight(to_tsvector('simple', coalesce(${messages.fromName}, '') || ' ' || coalesce(${messages.fromAddress}, '')), 'B') || setweight(to_tsvector('simple', left(coalesce(${messages.textBody}, ''), 200000)), 'C')`,
		),
	},
	t => [
		uniqueIndex('messages_folder_uid_idx').on(t.folderId, t.uid),
		index('messages_folder_sort_idx').on(t.folderId, t.sortAt.desc()),
		index('messages_mailbox_thread_idx').on(t.mailboxId, t.threadId),
		index('messages_mailbox_msgid_idx').on(t.mailboxId, t.messageId),
		index('messages_search_idx').using('gin', t.search),
		index('messages_from_idx').on(t.mailboxId, t.fromAddress),
	],
)

/** IMAP changes made in the app (flags, moves), applied to the server by the worker in order. */
export const pendingOps = pgTable(
	'pending_ops',
	{
		id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
		mailboxId: text('mailbox_id')
			.notNull()
			.references(() => mailboxes.id, { onDelete: 'cascade' }),
		kind: text('kind').$type<'flags' | 'move' | 'delete'>().notNull(),
		payload: jsonb('payload').$type<PendingOpPayload>().notNull(),
		attempts: integer('attempts').notNull().default(0),
		error: text('error'),
		createdAt: createdAt(),
	},
	t => [index('pending_ops_mailbox_idx').on(t.mailboxId, t.id)],
)

export type PendingOpPayload = {
	folderId: string
	uids: number[]
	add?: string[]
	remove?: string[]
	/** For 'move': a folder, or a special folder the worker creates on the server if the account has none */
	targetFolderId?: string
	targetSpecial?: 'archive' | 'trash' | 'junk'
	/** Our message ids, so a move can update their folder and uid once the server answers. */
	messageIds?: string[]
}

// --- Sending ----------------------------------------------------------------------------------

export const outbox = pgTable(
	'outbox',
	{
		id: id(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		mailboxId: text('mailbox_id')
			.notNull()
			.references(() => mailboxes.id, { onDelete: 'cascade' }),
		payload: jsonb('payload').$type<ComposePayload>().notNull(),
		sendAt: ts('send_at').notNull(),
		status: text('status').$type<OutboxStatus>().notNull().default('queued'),
		attempts: integer('attempts').notNull().default(0),
		error: text('error'),
		messageId: text('message_id'),
		sentAt: ts('sent_at'),
		createdAt: createdAt(),
	},
	t => [index('outbox_due_idx').on(t.status, t.sendAt), index('outbox_user_idx').on(t.userId)],
)

export const uploads = pgTable('uploads', {
	id: id(),
	userId: text('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	filename: text('filename').notNull(),
	contentType: text('content_type').notNull(),
	size: integer('size').notNull(),
	data: bytea('data').notNull(),
	createdAt: createdAt(),
})

export const drafts = pgTable(
	'drafts',
	{
		id: id(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		mailboxId: text('mailbox_id').references(() => mailboxes.id, { onDelete: 'set null' }),
		payload: jsonb('payload').$type<Partial<ComposePayload>>().notNull(),
		updatedAt: ts('updated_at').notNull().defaultNow(),
		createdAt: createdAt(),
	},
	t => [index('drafts_user_idx').on(t.userId)],
)

/** Saved replies. projectId null means personal to the creator. */
export const templates = pgTable('templates', {
	id: id(),
	projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
	createdBy: text('created_by')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	name: text('name').notNull(),
	subject: text('subject').notNull().default(''),
	html: text('html').notNull(),
	createdAt: createdAt(),
})

/** Instance-wide settings (branding, ...), one JSON value per key. */
export const appSettings = pgTable('app_settings', {
	key: text('key').primaryKey(),
	value: jsonb('value').notNull(),
	updatedAt: ts('updated_at').notNull().defaultNow(),
})
