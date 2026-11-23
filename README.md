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
packages/shared Types used by both
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

## Gmail and Microsoft 365

Gmail works with an app password (IMAP on). Microsoft 365 mostly blocks password sign-in for IMAP/SMTP, so it only works where the tenant allows it. OAuth for both is not built yet.
