// Locked out (lost the phone and the recovery codes)? Run inside the api container:
//   bun src/reset-sign-in.ts you@example.com
// It removes the account's passkeys, authenticator app and recovery codes and signs it out everywhere.
// At the next sign-in, the password is enough to reach the screen that sets up a new factor.

import { eq } from 'drizzle-orm'
import { db, schema } from './db'
import { resetSignIn } from './security/factors'

const email = process.argv[2]?.trim().toLowerCase()
if (!email) {
	console.error('Usage: bun src/reset-sign-in.ts <email>')
	process.exit(1)
}
const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email))
if (!user) {
	console.error(`No account with the email ${email}`)
	process.exit(1)
}
await resetSignIn(user.id)
console.log(`Reset sign-in for ${user.email}. Sign in with the password and set up a passkey or authenticator app.`)
process.exit(0)
