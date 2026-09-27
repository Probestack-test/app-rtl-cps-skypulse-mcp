import { randomBytes } from 'node:crypto'
import { intFromEnv, type ServerConfig } from '../config.js'
import type { Logger } from '../observability/logger.js'
import type { Metrics } from '../observability/metrics.js'

export interface UpstreamRequest {
  method: string
  url: string
  headers: Record<string, string>
  body?: string
}

export interface UpstreamResult {
  status: number
  statusText: string
  body: string
}

export class UpstreamUnavailableError extends Error {}

const IDEMPOTENT = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS'])
const RETRYABLE_STATUS = new Set([502, 503, 504])
const MAX_BODY_CHARS = 256 * 1024

/**
 * Calls the API the tools stand in for: authenticates to it, applies the timeout / retry /
 * circuit-breaker choices made when this server was generated, and never logs a credential.
 */
export class UpstreamClient {
  private readonly timeoutMs: number
  private readonly retries: number
  private readonly backoffMs: number
  private readonly breakerThreshold: number
  private readonly breakerResetMs: number
  private consecutiveFailures = 0
  private openedAt = 0

  constructor(
    private readonly config: ServerConfig,
    private readonly env: NodeJS.ProcessEnv,
    private readonly logger: Logger,
    private readonly metrics: Metrics,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.timeoutMs = intFromEnv(env, 'UPSTREAM_TIMEOUT_MS', config.resiliency.timeouts ? 10_000 : 30_000)
    this.retries = config.resiliency.retry ? intFromEnv(env, 'UPSTREAM_RETRY_ATTEMPTS', 2) : 0
    this.backoffMs = intFromEnv(env, 'UPSTREAM_RETRY_BACKOFF_MS', 200)
    this.breakerThreshold = intFromEnv(env, 'UPSTREAM_BREAKER_THRESHOLD', 5)
    this.breakerResetMs = intFromEnv(env, 'UPSTREAM_BREAKER_RESET_MS', 30_000)
  }

  /** The base URL calls go to: the environment wins over what was chosen at generation time. */
  get baseUrl(): string {
    return (this.env.UPSTREAM_BASE_URL || this.config.upstream.baseUrl || '').replace(/\/+$/, '')
  }

  async call(request: UpstreamRequest, traceparent?: string): Promise<UpstreamResult> {
    this.assertClosed()
    const headers = { ...request.headers, ...this.credentialHeaders() }
    if (this.config.observability.tracing) {
      headers.traceparent = traceparent ?? `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-01`
    }
    const attempts = IDEMPOTENT.has(request.method) ? this.retries + 1 : 1

    let lastError: unknown
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await sleep(this.backoffMs * 2 ** (attempt - 1))
      try {
        const response = await this.fetchImpl(request.url, {
          method: request.method,
          headers,
          body: request.body,
          signal: AbortSignal.timeout(this.timeoutMs),
        })
        const text = await response.text()
        if (RETRYABLE_STATUS.has(response.status) && attempt < attempts - 1) {
          this.recordFailure()
          continue
        }
        if (response.status >= 500) this.recordFailure()
        else this.recordSuccess()
        return {
          status: response.status,
          statusText: response.statusText,
          body: text.length > MAX_BODY_CHARS ? text.slice(0, MAX_BODY_CHARS) + '\n...[truncated]' : text,
        }
      } catch (error) {
        lastError = error
        this.recordFailure()
        this.logger.warn('Upstream call failed', {
          method: request.method,
          attempt: attempt + 1,
          error: error instanceof Error ? error.name : 'error',
        })
      }
    }
    this.metrics.increment('mcp_upstream_errors_total')
    throw new Error(`The upstream API could not be reached: ${describe(lastError)}`)
  }

  private credentialHeaders(): Record<string, string> {
    const { authType, apiKeyHeader } = this.config.upstream
    if (authType === 'BEARER' && this.env.UPSTREAM_BEARER_TOKEN) {
      return { authorization: `Bearer ${this.env.UPSTREAM_BEARER_TOKEN}` }
    }
    if (authType === 'API_KEY' && this.env.UPSTREAM_API_KEY) {
      const header = this.env.UPSTREAM_API_KEY_HEADER || apiKeyHeader
      return { [header.toLowerCase()]: this.env.UPSTREAM_API_KEY }
    }
    return {}
  }

  private assertClosed(): void {
    if (!this.config.resiliency.circuitBreaker || this.consecutiveFailures < this.breakerThreshold) return
    if (Date.now() - this.openedAt >= this.breakerResetMs) {
      // Half-open: let one call through to find out whether the API has recovered.
      this.consecutiveFailures = this.breakerThreshold - 1
      return
    }
    throw new UpstreamUnavailableError(
      'The upstream API is temporarily unavailable (circuit breaker is open). Try again shortly.',
    )
  }

  private recordFailure(): void {
    this.consecutiveFailures += 1
    if (this.consecutiveFailures >= this.breakerThreshold) this.openedAt = Date.now()
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.name === 'TimeoutError' ? 'the request timed out' : error.message
  }
  return 'unknown error'
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
