# Mailroom

Self-hosted mail client for running several projects (brands, clients, domains) from one place. Connect any IMAP/SMTP mailbox, group mailboxes by project, give people access to a whole project or to single mailboxes, and check each domain's mail setup.

- Push mail: IMAP IDLE on every inbox, new mail shows up in seconds (no polling every few hours like Gmail's POP fetch)
- Full history: the newest page right away, then the whole mailbox in the background
- Projects: one per brand or client, with its domains and mailboxes; a unified inbox or one project or one mailbox
- Send from any mailbox you have access to; signatures per mailbox, with your own override
- Undo send, scheduled send, snooze, templates (personal or shared per project), drafts that follow you
- Domain health: MX, SPF (with lookup count and sending-server check), DKIM, DMARC, reverse DNS, blocklists, MTA-STS, TLS-RPT, BIMI, with the exact records to add
- People: owner, admins, members with per-project or per-mailbox access
- Safe reading: HTML is sanitized and shown in a sandboxed iframe, remote images blocked until you allow them

```
apps/server     Bun. src/api.ts (Elysia HTTP API) and src/worker.ts (IMAP sync, sending, health checks)
apps/web        Next.js 16 + HeroUI v3. The UI, plus a /api/* proxy to the API service
apps/mac        Native SwiftUI app for macOS (not deployed, built locally)
packages/shared Types used by the server and the web app
```

Postgres holds everything (mail, outbox, pending IMAP changes); Redis carries realtime events (worker -> API -> browser over SSE) and login throttling.

## How sync works

The worker keeps two IMAP connections per mailbox. `watch` sits in IDLE on INBOX and wakes the other one the moment something changes. `ops` runs one loop: changes made in the app (flags, moves, deletes from `pending_ops`), new mail, flag sync (CONDSTORE when the server has it), expunge detection, and the history backfill in batches of 100, newest first. Messages up to 300 KB are fetched whole and parsed; larger ones only get their text parts downloaded. Attachments are fetched from the server when opened.

Sending goes through the mailbox's own SMTP server, so the domain's SPF and DKIM stay valid. Every send waits in the `outbox` table for the undo window (or until its scheduled time), then the worker sends it and saves a copy to Sent.

Only one worker runs at a time (Postgres advisory lock), so a deploy that briefly runs two is safe.

## Local dev

Needs Postgres and Redis. With Docker: `docker compose -f docker-compose.dev.yml up -d` (also starts a GreenMail test mail server).

```bash
bun install
cp apps/server/.env.example apps/server/.env     # set APP_SECRET: openssl rand -hex 32
bun run api:dev                                   # API on 3001
PORT=3002 bun run worker:dev                      # worker
bun run web:dev                                   # http://localhost:3150
```

`bun lint`, `bun typecheck`, `bun run db:generate` after changing `apps/server/src/db/schema.ts`.

## Self-host

Two images, published on every version tag by `.github/workflows/release.yml` (linux/amd64 and linux/arm64):

- `ghcr.io/shinxz/mailroom-server:<version>`: the API (default command) and the sync worker (`bun src/worker.ts`)
- `ghcr.io/shinxz/mailroom-web:<version>`: the web app, with `API_URL` pointing at the API

On Seylo, the **Mailroom** template (Communication) creates everything: web, API, worker, Postgres and Redis,
with a generated `APP_SECRET` and setup token. The template lives in Seylo-dev/App under `templates/mailroom`.

To release: `git tag v0.2.0 && git push origin v0.2.0`, then bump the image defaults in the template.

## Deploy on Seylo

Seylo project "Mailroom": Postgres 18 and Valkey 9 from Seylo, and three App services from this repo (build type Dockerfile, build context the repo root, deploy on push to `main`).

| Service  | Dockerfile               | Start command        | Port | Domain        |
| -------- | ------------------------ | -------------------- | ---- | ------------- |
| `api`    | `apps/server/Dockerfile` | default              | 3001 | none          |
| `worker` | `apps/server/Dockerfile` | `bun src/worker.ts`  | 3002 | none          |
| `web`    | `apps/web/Dockerfile`    | default              | 3000 | mail.lue.my   |

`api` and `worker` env:

| Variable       |                                                                                   |
| -------------- | --------------------------------------------------------------------------------- |
| `DATABASE_URL` | `${{db.INTERNAL_URL}}`                                                            |
| `REDIS_URL`    | `${{redis.INTERNAL_URL}}`                                                         |
| `APP_SECRET`   | Same value on both. Encrypts mailbox passwords: changing it makes them unreadable |
| `SETUP_TOKEN`  | Asked for when creating the owner account on first run                            |
| `PORT`         | `3002` on the worker                                                              |

`web` env: `API_URL=${{api.INTERNAL_URL}}`.

## Mac app

`apps/mac` is a native SwiftUI app with three panes: projects, mailboxes and folders, the thread list, and the reader. It has compose windows (send from any of your mailboxes, signatures, attachments, templates, send later), archive/delete/spam/snooze/move/star, live updates over the same event stream as the web app, notifications for new mail and an unread badge on the Dock icon. Projects, domains and people are still managed in the web app.

It signs in to the web app's address (https://mail.lue.my) with your normal account and keeps a session token in the keychain. Emails render in a WKWebView with JavaScript off and remote images blocked until you allow them; inline images load through an internal scheme that adds the token.

It needs the command line tools (Swift 6), not Xcode.

```bash
apps/mac/scripts/bundle.sh --install    # builds build/Mailroom.app and copies it to /Applications
```

The build is signed ad hoc, so macOS asks once to allow keychain access after each rebuild. For development it can skip the keychain and point at a local server: `MAILROOM_SERVER=http://localhost:3150 MAILROOM_TOKEN=<token from /api/auth/login with "client":"native"> apps/mac/build/Mailroom.app/Contents/MacOS/Mailroom`.

Shortcuts: ⌘N new message, ⌘R reply, ⇧⌘R reply all, ⇧⌘F forward, ⌘E archive, ⌘⌫ delete, ⇧⌘U unread, ⇧⌘L star, ⇧⌘N get new mail.

## Gmail and Microsoft 365

Gmail works with an app password (IMAP on). Microsoft 365 mostly blocks password sign-in for IMAP/SMTP, so it only works where the tenant allows it. OAuth for both is not built yet.

## License

MIT, see [LICENSE](LICENSE).
