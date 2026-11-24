import type { ApiToken, NewApiToken, TokenScope } from '@mailroom/shared'
import { and, count, desc, eq, inArray, isNull } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import { accessibleMailboxIds, accessibleProjectIds } from '../access'
import { API_TOKEN_PREFIX } from '../auth'
import { sessionAuth } from '../context'
import { db, schema } from '../db'
import { assertWebhookUrl, postWebhook } from '../events/webhooks'
import { decryptSecret, encryptSecret } from '../lib/crypto'
import { HttpError, notFound } from '../lib/http'
import { randomToken, sha256 } from '../lib/ids'

// API tokens for apps. Only a signed-in person (passed a second factor) manages them; a token can't
// create or see other tokens. The secret is shown once and stored as a hash.

const MAX_TOKENS = 50

type TokenRow = typeof schema.apiTokens.$inferSelect

const toApiToken = (r: TokenRow): ApiToken => ({
	id: r.id,
	name: r.name,
	prefix: r.prefix,
	canRead: r.canRead,
	canSend: r.canSend,
	scope: r.scope,
	webhookUrl: r.webhookUrl,
	expiresAt: r.expiresAt?.toISOString() ?? null,
	lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
	createdAt: r.createdAt.toISOString(),
	revokedAt: r.revokedAt?.toISOString() ?? null,
})

const ScopeT = t.Union([
	t.Object({ type: t.Literal('all') }),
	t.Object({
		type: t.Literal('selected'),
		projectIds: t.Array(t.String(), { maxItems: 200 }),
		mailboxIds: t.Array(t.String(), { maxItems: 500 }),
	}),
])

/** A token may only reach what its owner can reach today. */
async function checkScope(user: Parameters<typeof accessibleMailboxIds>[0], scope: TokenScope): Promise<TokenScope> {
	if (scope.type === 'all') return scope
	const projectIds = [...new Set(scope.projectIds)]
	const mailboxIds = [...new Set(scope.mailboxIds)]
	if (!projectIds.length && !mailboxIds.length) throw new HttpError(400, 'Pick at least one project or mailbox')
	const projects = await accessibleProjectIds(user)
	if (projects !== 'all' && projectIds.some(id => !projects.includes(id)))
		throw new HttpError(403, 'You can only give a token projects you can see')
	const mailboxes = await accessibleMailboxIds(user)
	if (mailboxIds.some(id => !mailboxes.includes(id)))
		throw new HttpError(403, 'You can only give a token mailboxes you can use')
	return { type: 'selected', projectIds, mailboxIds }
}

const newWebhookSecret = () => `whsec_${randomToken(24)}`

async function ownToken(userId: string, id: string) {
	const [row] = await db
		.select()
		.from(schema.apiTokens)
		.where(and(eq(schema.apiTokens.id, id), eq(schema.apiTokens.userId, userId), isNull(schema.apiTokens.revokedAt)))
	if (!row) throw notFound('No such token')
	return row
}

export const tokenRoutes = new Elysia({ prefix: '/tokens' })
	.use(sessionAuth)
	.get('/', async ({ user }) => {
		const rows = await db
			.select()
			.from(schema.apiTokens)
			.where(and(eq(schema.apiTokens.userId, user.id), isNull(schema.apiTokens.revokedAt)))
			.orderBy(desc(schema.apiTokens.createdAt))
		const failing = rows.length
			? await db
					.select({ tokenId: schema.webhookDeliveries.tokenId, n: count() })
					.from(schema.webhookDeliveries)
					.where(
						and(
							inArray(
								schema.webhookDeliveries.tokenId,
								rows.map(r => r.id),
							),
							eq(schema.webhookDeliveries.status, 'failed'),
						),
					)
					.groupBy(schema.webhookDeliveries.tokenId)
			: []
		return {
			tokens: rows.map(r => ({ ...toApiToken(r), failedDeliveries: failing.find(f => f.tokenId === r.id)?.n ?? 0 })),
		}
	})

	.post(
		'/',
		async ({ user, body }) => {
			const [n] = await db
				.select({ n: count() })
				.from(schema.apiTokens)
				.where(and(eq(schema.apiTokens.userId, user.id), isNull(schema.apiTokens.revokedAt)))
			if ((n?.n ?? 0) >= MAX_TOKENS)
				throw new HttpError(400, `You can have up to ${MAX_TOKENS} tokens. Revoke one first.`)
			if (!body.canRead && !body.canSend) throw new HttpError(400, 'Give the token read access, send access or both')
			const scope = await checkScope(user, body.scope)
			const webhookUrl = body.webhookUrl?.trim() ? (await assertWebhookUrl(body.webhookUrl.trim())).toString() : null
			const webhookSecret = webhookUrl ? newWebhookSecret() : null
			const secret = `${API_TOKEN_PREFIX}${randomToken(32)}`
			const [row] = await db
				.insert(schema.apiTokens)
				.values({
					userId: user.id,
					name: body.name.trim() || 'API token',
					tokenHash: sha256(secret),
					prefix: secret.slice(0, 10),
					canRead: body.canRead,
					canSend: body.canSend,
					scope,
					webhookUrl,
					webhookSecret: webhookSecret ? encryptSecret(webhookSecret) : null,
					expiresAt: body.expiresInDays ? new Date(Date.now() + body.expiresInDays * 86400_000) : null,
				})
				.returning()
			return { token: toApiToken(row!), secret, webhookSecret } satisfies NewApiToken
		},
		{
			body: t.Object({
				name: t.String({ maxLength: 80 }),
				canRead: t.Boolean(),
				canSend: t.Boolean(),
				scope: ScopeT,
				webhookUrl: t.Optional(t.Union([t.String({ maxLength: 2000 }), t.Null()])),
				expiresInDays: t.Optional(t.Union([t.Integer({ minimum: 1, maximum: 3650 }), t.Null()])),
			}),
		},
	)

	// Name, permissions, scope and webhook can change; the secret can't (make a new token instead)
	.patch(
		'/:id',
		async ({ user, params, body }) => {
			const row = await ownToken(user.id, params.id)
			const canRead = body.canRead ?? row.canRead
			const canSend = body.canSend ?? row.canSend
			if (!canRead && !canSend) throw new HttpError(400, 'Give the token read access, send access or both')
			const changes: Partial<typeof schema.apiTokens.$inferInsert> = { canRead, canSend }
			if (body.name !== undefined) changes.name = body.name.trim() || row.name
			if (body.scope) changes.scope = await checkScope(user, body.scope)
			let webhookSecret: string | null = null
			if (body.webhookUrl !== undefined) {
				const url = body.webhookUrl?.trim() ? (await assertWebhookUrl(body.webhookUrl.trim())).toString() : null
				changes.webhookUrl = url
				if (!url) changes.webhookSecret = null
				else if (!row.webhookSecret) webhookSecret = newWebhookSecret()
			}
			if (body.rotateWebhookSecret && (changes.webhookUrl ?? row.webhookUrl)) webhookSecret = newWebhookSecret()
			if (webhookSecret) changes.webhookSecret = encryptSecret(webhookSecret)
			const [updated] = await db
				.update(schema.apiTokens)
				.set(changes)
				.where(eq(schema.apiTokens.id, row.id))
				.returning()
			return { token: toApiToken(updated!), webhookSecret }
		},
		{
			body: t.Object({
				name: t.Optional(t.String({ maxLength: 80 })),
				canRead: t.Optional(t.Boolean()),
				canSend: t.Optional(t.Boolean()),
				scope: t.Optional(ScopeT),
				webhookUrl: t.Optional(t.Union([t.String({ maxLength: 2000 }), t.Null()])),
				rotateWebhookSecret: t.Optional(t.Boolean()),
			}),
		},
	)

	.delete('/:id', async ({ user, params }) => {
		const row = await ownToken(user.id, params.id)
		await db.update(schema.apiTokens).set({ revokedAt: new Date() }).where(eq(schema.apiTokens.id, row.id))
		await db
			.update(schema.webhookDeliveries)
			.set({ status: 'failed', lastError: 'The token was revoked' })
			.where(and(eq(schema.webhookDeliveries.tokenId, row.id), eq(schema.webhookDeliveries.status, 'pending')))
		return { ok: true }
	})

	// Sends a ping to the webhook right away and says what came back
	.post('/:id/webhook/test', async ({ params, user }) => {
		const row = await ownToken(user.id, params.id)
		if (!row.webhookUrl || !row.webhookSecret) throw new HttpError(400, 'This token has no webhook')
		const body = JSON.stringify({ type: 'ping', id: `ping_${randomToken(8)}`, createdAt: new Date().toISOString() })
		try {
			const status = await postWebhook(row.webhookUrl, decryptSecret(row.webhookSecret), body, {
				'mailroom-event': 'ping',
				'mailroom-delivery': 'test',
			})
			return { ok: status >= 200 && status < 300, status }
		} catch (err) {
			if (err instanceof HttpError) throw err
			return { ok: false, status: null, error: err instanceof Error ? err.message : 'The request failed' }
		}
	})
