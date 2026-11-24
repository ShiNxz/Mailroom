# mailroom-sdk

Send and receive email through a [Mailroom](https://github.com/ShiNxz/Mailroom) server instead of talking SMTP and IMAP yourself. Mailroom keeps the mailboxes connected; your app uses an API token.

```bash
npm install mailroom-sdk
```

Make a token in Mailroom under **Settings > API tokens** (all your mailboxes, or only some projects or mailboxes; read, send or both), then:

```bash
MAILROOM_URL=https://mail.example.com
MAILROOM_TOKEN=mr_...
```

## Send

```ts
import { Mailroom } from 'mailroom-sdk'

const mail = new Mailroom() // reads MAILROOM_URL and MAILROOM_TOKEN

const support = mail.mailbox('support@example.com')
const billing = mail.mailbox('billing@example.com', { name: 'Example Billing' }) // overrides the sender name

await support.send({
	to: 'Dana <dana@client.com>',
	subject: 'Your ticket',
	text: 'We are on it.', // or html, or both
	attachments: [{ filename: 'report.csv', content: 'a,b\n1,2' }],
})

// Wait until it actually went out (throws if the mail server refused it)
await billing.send({ to: 'dana@client.com', subject: 'Invoice', html: '<p>Attached</p>', wait: true })
```

Pass an `idempotencyKey` to make retries safe: the same key sends once. `sendAt` schedules a message.

Bulk mail (newsletters, digests) needs a one-click unsubscribe for Gmail and Yahoo. Pass the https URL that
unsubscribes this recipient when POSTed to, and both headers are set for you:

```ts
await news.send({ to, subject: 'Your weekly briefing', html, unsubscribe: `https://app.example.com/u/${token}` })
```

Other headers go in `headers`: the List-* headers, Auto-Submitted, Precedence, Feedback-ID and your own X- headers
(`headers: { 'Auto-Submitted': 'auto-generated', 'List-Id': '<briefing.example.com>' }`). Mailroom's own headers
(From, To, Subject, Message-ID and the like) can't be set.

## Receive

```ts
support.on('message', async msg => {
	console.log(msg.from.address, msg.subject, msg.text)
	await msg.reply({ text: 'Thanks, we got it.' }) // threaded, to the sender (replyAll: true for everyone)
	await msg.markRead()
})

mail.on('message', msg => {}) // every mailbox the token can read
mail.on('sent', s => {}) // this token's sends that went out
mail.on('failed', s => console.error(s.error))
mail.on('error', err => console.error(err)) // connection trouble; it keeps reconnecting
```

Events come over one live connection that reconnects by itself and picks up where it left off, so nothing is missed while it reconnects (events are kept for 7 days). To resume after a restart, save `mail.cursor` and pass it back: `new Mailroom({ after: savedCursor })`.

## Read

```ts
const { messages, nextCursor } = await support.messages({ unread: true, limit: 20 })
const results = await mail.messages({ q: 'invoice', folder: 'all' })
const full = await messages[0].load() // lists leave the bodies out
```

## Webhooks

Give the token a webhook URL and Mailroom POSTs every event to it, signed with the token's webhook secret:

```ts
const event = await Mailroom.parseWebhook(rawBody, request.headers.get('mailroom-signature'), process.env.MAILROOM_WEBHOOK_SECRET!)
if (event.type === 'message.received') console.log(event.message.subject)
```

Use the raw body string, before parsing it as JSON. Deliveries older than 5 minutes are refused, so a captured one can't be replayed.

## Without the SDK

It is plain HTTP under `/api` with `Authorization: Bearer <token>`:

| | |
| --- | --- |
| `GET /api/mailboxes` | the mailboxes the token covers |
| `GET /api/messages?mailbox=&folder=&unread=&q=&limit=&cursor=` | messages, newest first |
| `GET /api/messages/:id` | one message with its bodies |
| `PATCH /api/messages/:id` | `{ seen, flagged }` |
| `POST /api/messages` | send: `{ from, fromName?, to, cc?, bcc?, replyTo?, subject, text?, html?, attachments?: [{ filename, content (base64), contentType? }], headers?, sendAt?, idempotencyKey?, inReplyTo? }` |
| `POST /api/messages/:id/reply` | `{ text?, html?, replyAll?, attachments?, ... }` |
| `GET /api/outbox/:id` | where a send is |
| `GET /api/stream?after=` | server-sent events (`message.received`, `message.sent`, `message.failed`) |
| `GET /api/updates?after=&wait=25` | the same as long-polling |

A token is limited to 600 requests a minute and 500 sends an hour, and only reaches mailboxes its owner can.

MIT
