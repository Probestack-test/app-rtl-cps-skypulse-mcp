import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { ServerConfig } from './config.js'
import { ErrorCodes, handleMessage, rpcError, type JsonRpcResponse } from './mcp/protocol.js'
import type { ToolRegistry } from './mcp/tools.js'
import type { Logger } from './observability/logger.js'
import type { Metrics } from './observability/metrics.js'
import type { Auth } from './security/auth.js'

export interface AppDependencies {
  config: ServerConfig
  auth: Auth
  tools: ToolRegistry
  logger: Logger
  metrics: Metrics
}

const MAX_BODY_BYTES = 1024 * 1024

class BodyTooLargeError extends Error {}

export function createApp(deps: AppDependencies): Server {
  const { config, auth, tools, logger, metrics } = deps

  return createServer((request, response) => {
    const requestId = randomUUID()
    const started = Date.now()
    const url = new URL(request.url ?? '/', 'http://localhost')
    const path = url.pathname.replace(/\/+$/, '') || '/'

    response.setHeader('x-request-id', requestId)
    response.on('finish', () => {
      metrics.increment('mcp_http_requests_total', {
        method: request.method ?? 'GET',
        status: String(response.statusCode),
      })
      if (path !== '/health' && path !== '/ready' && path !== '/metrics') {
        logger.info('request', {
          requestId,
          method: request.method,
          path,
          status: response.statusCode,
          durationMs: Date.now() - started,
        })
      }
    })

    route(request, response, path, requestId).catch((error: unknown) => {
      logger.error('Unhandled error', {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      })
      if (response.headersSent) return response.end()
      if (error instanceof BodyTooLargeError) {
        return sendJson(response, 413, rpcError(null, ErrorCodes.invalidRequest, 'Request body is too large'))
      }
      const message = config.exceptionHandling
        ? 'Internal error'
        : error instanceof Error
          ? error.message
          : 'Internal error'
      sendJson(response, 500, rpcError(null, ErrorCodes.internal, message, { requestId }))
    })
  })

  async function route(
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
    requestId: string,
  ): Promise<void> {
    const method = request.method ?? 'GET'

    if (config.observability.health && method === 'GET' && (path === '/health' || path === '/ready')) {
      return sendJson(response, 200, { status: 'UP' })
    }
    if (config.observability.metrics && method === 'GET' && path === '/metrics') {
      response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' })
      return void response.end(metrics.render())
    }
    if (auth.issueToken && path === '/oauth/token') {
      if (method !== 'POST') return sendJson(response, 405, { error: 'method_not_allowed' })
      const form = new URLSearchParams(await readBody(request))
      const issued = auth.issueToken(request.headers, form)
      response.setHeader('cache-control', 'no-store')
      return sendJson(response, issued.status, issued.body)
    }
    if (path !== config.mcpPath) return sendJson(response, 404, { error: 'not_found' })
    if (method !== 'POST') {
      response.setHeader('allow', 'POST')
      return sendJson(response, 405, { error: 'method_not_allowed' })
    }

    const authentication = auth.authenticate(request.headers)
    if (!authentication.ok) {
      metrics.increment('mcp_auth_failures_total')
      logger.warn('Authentication failed', { requestId, reason: authentication.reason })
      response.setHeader(
        'www-authenticate',
        `${auth.scheme} realm="mcp"`,
      )
      return sendJson(response, 401, { error: 'unauthorized', error_description: 'Authentication is required.' })
    }

    let payload: unknown
    try {
      payload = JSON.parse(await readBody(request))
    } catch (error) {
      if (error instanceof BodyTooLargeError) throw error
      return sendJson(response, 400, rpcError(null, ErrorCodes.parse, 'Parse error'))
    }

    const traceparent = config.observability.tracing
      ? (request.headers.traceparent as string | undefined)
      : undefined
    const respond = async (message: unknown): Promise<JsonRpcResponse | null> => {
      try {
        return await handleMessage(message, config, tools, traceparent)
      } catch (error) {
        logger.error('Request failed', {
          requestId,
          error: error instanceof Error ? error.message : String(error),
        })
        const id = (message as { id?: string | number | null } | null)?.id ?? null
        return rpcError(id, ErrorCodes.internal, 'Internal error', { requestId })
      }
    }

    if (Array.isArray(payload)) {
      if (payload.length === 0) {
        return sendJson(response, 400, rpcError(null, ErrorCodes.invalidRequest, 'Invalid Request'))
      }
      const results = (await Promise.all(payload.map(respond))).filter(
        (item): item is JsonRpcResponse => item !== null,
      )
      if (results.length === 0) return accepted(response)
      return sendJson(response, 200, results)
    }
    const result = await respond(payload)
    if (result === null) return accepted(response)
    return sendJson(response, 200, result)
  }
}

function accepted(response: ServerResponse): void {
  response.writeHead(202)
  response.end()
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  })
  response.end(text)
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new BodyTooLargeError())
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}
