import type { ServerEvent } from '@mailroom/shared'
import Redis from 'ioredis'
import { env } from '../env'
import { log } from './log'

// Redis carries the realtime side: worker -> API events (fanned out to browsers over SSE),
// API -> worker pokes (a new outbox item or IMAP change is waiting), and login rate limits.
// Durable state (pending IMAP changes, the outbox) lives in Postgres, so a lost message only delays things.

export const EVENTS_CHANNEL = 'mailroom:events'
export const COMMANDS_CHANNEL = 'mailroom:commands'

export type WorkerCommand =
	| { type: 'ops'; mailboxId: string }
	| { type: 'outbox' }
	| { type: 'mailbox-changed'; mailboxId: string }
	| { type: 'mailbox-removed'; mailboxId: string }
	| { type: 'resync'; mailboxId: string }

function connect(name: string) {
	const client = new Redis(env.redisUrl, { maxRetriesPerRequest: null, lazyConnect: false, connectionName: name })
	client.on('error', err => log.warn('redis error', { name, err }))
	return client
}

export const redis = connect('mailroom')

export const publishEvent = (event: ServerEvent) => redis.publish(EVENTS_CHANNEL, JSON.stringify(event))
export const sendCommand = (command: WorkerCommand) => redis.publish(COMMANDS_CHANNEL, JSON.stringify(command))

export function subscribe<T>(channel: string, handler: (message: T) => void) {
	const sub = connect(`mailroom-sub-${channel}`)
	sub.subscribe(channel).catch(err => log.error('redis subscribe failed', { channel, err }))
	sub.on('message', (_channel, raw) => {
		try {
			handler(JSON.parse(raw) as T)
		} catch (err) {
			log.warn('bad redis message', { channel, err })
		}
	})
	return sub
}
