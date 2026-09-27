import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs'
import { dirname } from 'node:path'
import type { ServerConfig } from '../config.js'

const SENSITIVE = /authorization|cookie|api-?key|token|secret|password/i

/** Replaces the value of any field that looks like a credential. */
export function maskFields(
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  const masked: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) {
    masked[key] = SENSITIVE.test(key) ? '***' : value
  }
  return masked
}

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
  error(message: string, fields?: Record<string, unknown>): void
}

type Level = 'info' | 'warn' | 'error'

export function createLogger(
  config: ServerConfig['logging'],
  env: NodeJS.ProcessEnv = process.env,
  service = 'mcp-server',
): Logger {
  const toConsole = config.destination !== 'FILE'
  const toFile = config.destination !== 'CONSOLE'
  const filePath = env.LOG_FILE || 'logs/app.log'
  let file: WriteStream | undefined
  if (toFile) {
    mkdirSync(dirname(filePath), { recursive: true })
    file = createWriteStream(filePath, { flags: 'a' })
  }

  const write = (
    level: Level,
    message: string,
    fields?: Record<string, unknown>,
  ) => {
    const safe = maskFields(fields)
    const timestamp = new Date().toISOString()
    let line: string
    if (config.enterprise || config.provider === 'GCP') {
      const severity =
        config.provider === 'GCP'
          ? level === 'warn'
            ? 'WARNING'
            : level.toUpperCase()
          : level
      line = JSON.stringify({ timestamp, severity, service, message, ...safe })
    } else {
      const extra = Object.keys(safe).length ? ` ${JSON.stringify(safe)}` : ''
      line = `${timestamp} ${level.toUpperCase()} ${message}${extra}`
    }
    if (toConsole) {
      ;(level === 'error' ? process.stderr : process.stdout).write(line + '\n')
    }
    file?.write(line + '\n')
  }

  return {
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
  }
}
