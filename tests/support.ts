import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { loadServerConfig, loadTools, type ToolDefinition } from '../src/config.js'
import { ToolRegistry } from '../src/mcp/tools.js'
import type { Logger } from '../src/observability/logger.js'
import { Metrics } from '../src/observability/metrics.js'
import { createAuth } from '../src/security/auth.js'
import { createApp } from '../src/server.js'
import { UpstreamClient } from '../src/upstream/client.js'
import { AUTH_ENV, authHeaders } from './auth-support.js'

export { authHeaders }

export interface RecordedRequest {
  method: string
  url: string
  body: string
}

export interface TestServer {
  baseUrl: string
  mcpUrl: string
  upstreamRequests: RecordedRequest[]
  rpc(
    method: string,
    params?: unknown,
    headers?: Record<string, string>,
  ): Promise<{ status: number; body: any }>
  close(): Promise<void>
}

const silent: Logger = { info() {}, warn() {}, error() {} }

/** Starts this MCP server against a stub upstream API that answers every call with {"ok":true}. */
export async function startTestServer(): Promise<TestServer> {
  const upstreamRequests: RecordedRequest[] = []
  const upstream = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      upstreamRequests.push({
        method: request.method ?? '',
        url: request.url ?? '',
        body: Buffer.concat(chunks).toString('utf8'),
      })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true }))
    })
  })
  const upstreamUrl = await listen(upstream)

  const env = {
    ...AUTH_ENV,
    UPSTREAM_BASE_URL: upstreamUrl,
    UPSTREAM_RETRY_BACKOFF_MS: '1',
  } as NodeJS.ProcessEnv
  const config = await loadServerConfig()
  const metrics = new Metrics()
  const client = new UpstreamClient(config, env, silent, metrics)
  const app = createApp({
    config,
    auth: createAuth(config, env),
    tools: new ToolRegistry(await loadTools(), client),
    logger: silent,
    metrics,
  })
  const baseUrl = await listen(app)
  const mcpUrl = baseUrl + config.mcpPath

  return {
    baseUrl,
    mcpUrl,
    upstreamRequests,
    async rpc(method, params, headers) {
      const response = await fetch(mcpUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(headers ?? (await authHeaders(baseUrl))) },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      })
      const text = await response.text()
      return { status: response.status, body: text ? JSON.parse(text) : null }
    },
    async close() {
      await Promise.all([close(app), close(upstream)])
    },
  }
}

/** Arguments that satisfy a tool's required inputs. */
export function sampleArguments(tool: ToolDefinition): Record<string, unknown> {
  const schema = tool.inputSchema as {
    required?: string[]
    properties?: Record<string, { type?: string | string[]; enum?: unknown[] }>
  }
  const args: Record<string, unknown> = {}
  for (const name of schema.required ?? []) {
    const definition = schema.properties?.[name] ?? {}
    const type = [definition.type ?? 'string'].flat()[0]
    args[name] =
      definition.enum?.[0] ??
      (type === 'integer' || type === 'number'
        ? 1
        : type === 'boolean'
          ? true
          : type === 'array'
            ? []
            : type === 'object'
              ? {}
              : 'sample')
  }
  return args
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
    })
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections()
  })
}
