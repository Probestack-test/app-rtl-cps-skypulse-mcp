import type { ToolDefinition } from '../config.js'
import type { UpstreamClient } from '../upstream/client.js'

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

export class InvalidArgumentsError extends Error {}

type Schema = {
  type?: string | string[]
  enum?: unknown[]
  required?: string[]
  properties?: Record<string, Schema>
}

/** Top-level argument checks: required, JSON type and enum. Returns the problems found. */
export function validateArguments(
  schema: Record<string, unknown>,
  args: Record<string, unknown>,
): string[] {
  const problems: string[] = []
  const root = schema as Schema
  for (const name of root.required ?? []) {
    if (args[name] === undefined || args[name] === null) {
      problems.push(`'${name}' is required`)
    }
  }
  for (const [name, definition] of Object.entries(root.properties ?? {})) {
    const value = args[name]
    if (value === undefined || value === null) continue
    if (definition.type && !matchesType(value, definition.type)) {
      problems.push(`'${name}' must be of type ${[definition.type].flat().join(' or ')}`)
    } else if (definition.enum && !definition.enum.includes(value)) {
      problems.push(`'${name}' must be one of: ${definition.enum.join(', ')}`)
    }
  }
  return problems
}

function matchesType(value: unknown, type: string | string[]): boolean {
  return [type].flat().some((expected) => {
    switch (expected) {
      case 'string':
        return typeof value === 'string'
      case 'number':
        return typeof value === 'number' && Number.isFinite(value)
      case 'integer':
        return typeof value === 'number' && Number.isInteger(value)
      case 'boolean':
        return typeof value === 'boolean'
      case 'array':
        return Array.isArray(value)
      case 'object':
        return typeof value === 'object' && !Array.isArray(value)
      case 'null':
        return value === null
      default:
        return true
    }
  })
}

export function buildRequest(
  tool: ToolDefinition,
  args: Record<string, unknown>,
  baseUrl: string,
): { method: string; url: string; headers: Record<string, string>; body?: string } {
  let path = tool.http.path
  for (const name of tool.http.pathParams) {
    path = path.split(`{${name}}`).join(encodeURIComponent(String(args[name])))
  }
  const query = new URLSearchParams()
  for (const { arg, name } of tool.http.query) {
    const value = args[arg]
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) {
      for (const item of value) query.append(name, String(item))
    } else {
      query.append(name, typeof value === 'object' ? JSON.stringify(value) : String(value))
    }
  }
  const headers: Record<string, string> = { accept: 'application/json' }
  for (const { arg, name } of tool.http.headers) {
    const value = args[arg]
    if (value !== undefined && value !== null) headers[name.toLowerCase()] = String(value)
  }
  let body: string | undefined
  if (tool.http.bodyArg && args[tool.http.bodyArg] !== undefined) {
    body = JSON.stringify(args[tool.http.bodyArg])
    headers['content-type'] = 'application/json'
  }
  const queryString = query.toString()
  return {
    method: tool.http.method,
    url: `${baseUrl}${path}${queryString ? `?${queryString}` : ''}`,
    headers,
    body,
  }
}

export class ToolRegistry {
  private readonly byName = new Map<string, ToolDefinition>()

  constructor(
    tools: ToolDefinition[],
    private readonly upstream: UpstreamClient,
  ) {
    for (const tool of tools) this.byName.set(tool.name, tool)
  }

  list(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
    return [...this.byName.values()].map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    }))
  }

  has(name: string): boolean {
    return this.byName.has(name)
  }

  async call(
    name: string,
    args: Record<string, unknown>,
    traceparent?: string,
  ): Promise<ToolResult> {
    const tool = this.byName.get(name)
    if (!tool) throw new InvalidArgumentsError(`Unknown tool: ${name}`)
    const problems = validateArguments(tool.inputSchema, args)
    if (problems.length > 0) {
      throw new InvalidArgumentsError(`Invalid arguments: ${problems.join('; ')}`)
    }
    const baseUrl = this.upstream.baseUrl
    if (!baseUrl) {
      return textResult(
        'The target API URL is not configured. Set UPSTREAM_BASE_URL for this server.',
        true,
      )
    }
    try {
      const response = await this.upstream.call(buildRequest(tool, args, baseUrl), traceparent)
      const failed = response.status >= 400
      const prefix = failed ? `HTTP ${response.status} ${response.statusText}`.trim() + '\n' : ''
      return textResult(prefix + prettyJson(response.body), failed)
    } catch (error) {
      return textResult(error instanceof Error ? error.message : 'The upstream call failed.', true)
    }
  }
}

function textResult(text: string, isError = false): ToolResult {
  return isError ? { content: [{ type: 'text', text }], isError: true } : { content: [{ type: 'text', text }] }
}

function prettyJson(body: string): string {
  if (!body) return '(empty response)'
  try {
    return JSON.stringify(JSON.parse(body), null, 2)
  } catch {
    return body
  }
}
