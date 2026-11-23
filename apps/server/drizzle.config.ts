import { defineConfig } from 'drizzle-kit'

// `bun run db:generate` writes a SQL migration to ./drizzle from the schema. No database needed.
export default defineConfig({
	dialect: 'postgresql',
	schema: './src/db/schema.ts',
	out: './drizzle',
})
