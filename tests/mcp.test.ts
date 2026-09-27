import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadServerConfig, loadTools } from '../src/config.js'
import { authHeaders, sampleArguments, startTestServer, type TestServer } from './support.js'

const config = await loadServerConfig()
const tools = await loadTools()

let server: TestServer

beforeAll(async () => {
  server = await startTestServer()
})

afterAll(async () => {
  await server.close()
})

describe('skypulse-mcp MCP server', () => {
  it('answers initialize with its identity and the tools capability', async () => {
    const { status, body } = await server.rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    })

    expect(status).toBe(200)
    expect(body.result.protocolVersion).toBe('2025-03-26')
    expect(body.result.serverInfo.name).toBe(config.name)
    expect(body.result.capabilities.tools).toBeDefined()
  })

  it('lists exactly the generated tools', async () => {
    const { body } = await server.rpc('tools/list')

    expect(body.result.tools.map((tool: { name: string }) => tool.name)).toEqual(
      tools.map((tool) => tool.name),
    )
  })

  it('has at least one tool', () => {
    expect(tools.length).toBeGreaterThan(0)
  })

  it.each(tools.map((tool) => [tool.name, tool] as const))(
    'calls the upstream API for %s',
    async (_name, tool) => {
      const before = server.upstreamRequests.length
      const { body } = await server.rpc('tools/call', {
        name: tool.name,
        arguments: sampleArguments(tool),
      })

      expect(body.error).toBeUndefined()
      expect(body.result.isError).toBeUndefined()
      const sent = server.upstreamRequests.slice(before)
      expect(sent).toHaveLength(1)
      expect(sent[0]!.method).toBe(tool.http.method)
    },
  )

  it('rejects an unknown tool', async () => {
    const { body } = await server.rpc('tools/call', { name: 'no_such_tool', arguments: {} })

    expect(body.error.code).toBe(-32602)
  })

  it('rejects a call that leaves out a required argument', async () => {
    const tool = tools.find(
      (candidate) => ((candidate.inputSchema.required as string[] | undefined) ?? []).length > 0,
    )
    if (!tool) return
    const { body } = await server.rpc('tools/call', { name: tool.name, arguments: {} })

    expect(body.error.code).toBe(-32602)
    expect(body.error.message).toContain('required')
  })

  it('rejects an unknown method', async () => {
    const { body } = await server.rpc('resources/list')

    expect(body.error.code).toBe(-32601)
  })

  it('accepts a notification without a response body', async () => {
    const response = await fetch(server.mcpUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(await authHeaders(server.baseUrl)),
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    })

    expect(response.status).toBe(202)
  })

  it('refuses a request without credentials', async () => {
    const response = await fetch(server.mcpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })

    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toBeTruthy()
  })

  it('does not serve the MCP endpoint over GET', async () => {
    const response = await fetch(server.mcpUrl)

    expect(response.status).toBe(405)
  })
})
