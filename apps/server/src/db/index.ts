import path from 'node:path'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { env } from '../env'
import { log } from '../lib/log'
import * as schema from './schema'

export const sqlClient = postgres(env.databaseUrl, {
	max: Number(process.env.DATABASE_POOL ?? 10),
	ssl: env.databaseSsl,
	onnotice: () => {},
})

export const db = drizzle(sqlClient, { schema })
export type Db = typeof db
export { schema }

/** Applies apps/server/drizzle/*.sql. Both the API and the worker call it on start; Postgres serializes them. */
export async function runMigrations() {
	const folder = path.join(import.meta.dir, '../../drizzle')
	await sqlClient`select pg_advisory_lock(727001)`
	try {
		await migrate(db, { migrationsFolder: folder })
	} finally {
		await sqlClient`select pg_advisory_unlock(727001)`
	}
	log.info('database migrated')
}
