// One-line JSON logs, which Seylo's log search reads well.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const
type Level = keyof typeof LEVELS
const min = LEVELS[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? LEVELS.info

function write(level: Level, msg: string, fields?: Record<string, unknown>) {
	if (LEVELS[level] < min) return
	const entry: Record<string, unknown> = { t: new Date().toISOString(), level, msg, ...fields }
	if (fields?.err instanceof Error)
		entry.err = { message: fields.err.message, code: (fields.err as { code?: string }).code }
	const line = JSON.stringify(entry)
	if (level === 'error' || level === 'warn') console.error(line)
	else console.log(line)
}

export const log = {
	debug: (msg: string, fields?: Record<string, unknown>) => write('debug', msg, fields),
	info: (msg: string, fields?: Record<string, unknown>) => write('info', msg, fields),
	warn: (msg: string, fields?: Record<string, unknown>) => write('warn', msg, fields),
	error: (msg: string, fields?: Record<string, unknown>) => write('error', msg, fields),
	child: (base: Record<string, unknown>) => ({
		debug: (msg: string, fields?: Record<string, unknown>) => write('debug', msg, { ...base, ...fields }),
		info: (msg: string, fields?: Record<string, unknown>) => write('info', msg, { ...base, ...fields }),
		warn: (msg: string, fields?: Record<string, unknown>) => write('warn', msg, { ...base, ...fields }),
		error: (msg: string, fields?: Record<string, unknown>) => write('error', msg, { ...base, ...fields }),
	}),
}

export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))
