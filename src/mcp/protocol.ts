import type { ServerConfig } from '../config.js'
import { InvalidArgumentsError, type ToolRegistry } from './tools.js'

export const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05']

export type JsonRpcId = string | number | null

export interface JsonRpcRequest {
  jsonrpc?: string
  id?: JsonRpcId
  method?: unknown
  params?: unknown
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: JsonRpcId
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export const ErrorCodes = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const

export function rpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } }
}

/**
 * Handles one JSON-RPC message. Returns null for a notification, which has no response.
 * Resources and prompts are not exposed: this server only offers tools.
 */
export async function handleMessage(
  message: unknown,
  config: ServerConfig,
  tools: ToolRegistry,
  traceparent?: string,
): Promise<JsonRpcResponse | null> {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) {
    return rpcError(null, ErrorCodes.invalidRequest, 'Invalid Request')
  }
  const request = message as JsonRpcRequest
  const isNotification = request.id === undefined
  const id: JsonRpcId = request.id ?? null
  if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    return isNotification ? null : rpcError(id, ErrorCodes.invalidRequest, 'Invalid Request')
  }
  if (isNotification) return null

  const params = (typeof request.params === 'object' && request.params !== null
    ? request.params
    : {}) as Record<string, unknown>

  switch (request.method) {
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : ''
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: config.name, title: config.displayName, version: config.version },
          instructions: config.description || undefined,
        },
      }
    }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} }
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: tools.list() } }
    case 'tools/call': {
      const name = params.name
      if (typeof name !== 'string' || name.length === 0) {
        return rpcError(id, ErrorCodes.invalidParams, "Invalid params: 'name' is required")
      }
      const args = (typeof params.arguments === 'object' && params.arguments !== null
        ? params.arguments
        : {}) as Record<string, unknown>
      try {
        return { jsonrpc: '2.0', id, result: await tools.call(name, args, traceparent) }
      } catch (error) {
        if (error instanceof InvalidArgumentsError) {
          return rpcError(id, ErrorCodes.invalidParams, error.message)
        }
        throw error
      }
    }
    default:
      return rpcError(id, ErrorCodes.methodNotFound, `Method not found: ${request.method}`)
  }
}
