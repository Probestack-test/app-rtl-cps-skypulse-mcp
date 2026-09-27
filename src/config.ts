import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface ServerConfig {
  name: string
  displayName: string
  version: string
  description: string
  mcpPath: string
  auth: { type: 'OAUTH2' | 'API_KEY' }
  validationMode: 'DEVELOPMENT' | 'PRODUCTION'
  upstream: {
    baseUrl: string
    authType: 'NONE' | 'BEARER' | 'API_KEY'
    apiKeyHeader: string
  }
  resiliency: { timeouts: boolean; retry: boolean; circuitBreaker: boolean }
  observability: { health: boolean; metrics: boolean; tracing: boolean }
  logging: {
    enterprise: boolean
    provider: 'CONSOLE' | 'GCP'
    destination: 'CONSOLE' | 'FILE' | 'CONSOLE_AND_FILE'
  }
  exceptionHandling: boolean
}

/** An argument of the tool and the name it has on the upstream request. */
export interface ParamBinding {
  arg: string
  name: string
}

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  http: {
    method: string
    path: string
    pathParams: string[]
    query: ParamBinding[]
    headers: ParamBinding[]
    bodyArg: string | null
  }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

async function readJson<T>(relativePath: string): Promise<T> {
  return JSON.parse(await readFile(join(root, relativePath), 'utf8')) as T
}

export function loadServerConfig(): Promise<ServerConfig> {
  return readJson<ServerConfig>('config/mcp-server.json')
}

export async function loadTools(): Promise<ToolDefinition[]> {
  return (await readJson<{ tools: ToolDefinition[] }>('config/tools.json')).tools
}

export function intFromEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const value = Number.parseInt(env[name] ?? '', 10)
  return Number.isFinite(value) && value >= 0 ? value : fallback
}
