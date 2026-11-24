import type { SidebarPrefs } from '@mailroom/shared'
import { eq } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import { toUser } from '../auth'
import { authed } from '../context'
import { db, schema } from '../db'

// The person's own sidebar (order, hidden projects and mailboxes), kept with their settings so it
// follows them to every browser. Only their own view: admins set the shared project order elsewhere.

const Ids = t.Array(t.String({ maxLength: 64 }), { maxItems: 500 })

export const prefsRoutes = new Elysia().use(authed).put(
	'/me/sidebar',
	async ({ user, body }) => {
		const sidebar: SidebarPrefs = { ...user.settings.sidebar }
		if (body.projectOrder) sidebar.projectOrder = [...new Set(body.projectOrder)]
		if (body.mailboxOrder) sidebar.mailboxOrder = { ...sidebar.mailboxOrder, ...body.mailboxOrder }
		if (body.hiddenProjects) sidebar.hiddenProjects = [...new Set(body.hiddenProjects)]
		if (body.hiddenMailboxes) sidebar.hiddenMailboxes = [...new Set(body.hiddenMailboxes)]
		const [updated] = await db
			.update(schema.users)
			.set({ settings: { ...user.settings, sidebar } })
			.where(eq(schema.users.id, user.id))
			.returning()
		return { user: toUser(updated!) }
	},
	{
		body: t.Object({
			projectOrder: t.Optional(Ids),
			mailboxOrder: t.Optional(t.Record(t.String({ maxLength: 64 }), Ids)),
			hiddenProjects: t.Optional(Ids),
			hiddenMailboxes: t.Optional(Ids),
		}),
	},
)
