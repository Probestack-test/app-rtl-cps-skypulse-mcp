import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'
import type { ServerConfig } from '../config.js'

/**
 * OAuth 2.0 client-credentials protection for the MCP endpoint.
 *
 * The server issues short-lived HS256 access tokens at POST /oauth/token. No secret is stored in
 * this repository: the client id, client secret and token signing key are read from the
 * environment, and the server refuses to start without them.
 */
export interface AuthResult {
  ok: boolean
  subject?: string
  reason?: string
}

export interface TokenResponse {
  status: number
  body: Record<string, unknown>
}

export interface Auth {
  readonly type: 'OAUTH2'
  /** The scheme named in the WWW-Authenticate header of a 401. */
  readonly scheme: 'Bearer'
  readonly disabled: boolean
  authenticate(headers: IncomingHttpHeaders): AuthResult
  issueToken(headers: IncomingHttpHeaders, form: URLSearchParams): TokenResponse
}

const MIN_SIGNING_KEY_LENGTH = 32

export function createAuth(
  config: ServerConfig,
  env: NodeJS.ProcessEnv = process.env,
): Auth {
  const clientId = env.MCP_OAUTH_CLIENT_ID ?? ''
  const clientSecret = env.MCP_OAUTH_CLIENT_SECRET ?? ''
  const signingKey = env.MCP_OAUTH_SIGNING_KEY ?? ''
  const ttl = Number.parseInt(env.MCP_OAUTH_TOKEN_TTL_SECONDS ?? '3600', 10) || 3600
  const issuer = env.MCP_OAUTH_ISSUER || config.name
  const audience = env.MCP_OAUTH_AUDIENCE || config.name

  // Authentication can only be switched off explicitly, and only in DEVELOPMENT mode.
  const disabled =
    config.validationMode === 'DEVELOPMENT' && env.MCP_AUTH_DISABLED === 'true'
  if (disabled) {
    return {
      type: 'OAUTH2',
      scheme: 'Bearer',
      disabled: true,
      authenticate: () => ({ ok: true, subject: 'anonymous' }),
      issueToken: () => ({
        status: 404,
        body: { error: 'not_found', error_description: 'Authentication is disabled.' },
      }),
    }
  }

  const missing = [
    ['MCP_OAUTH_CLIENT_ID', clientId],
    ['MCP_OAUTH_CLIENT_SECRET', clientSecret],
    ['MCP_OAUTH_SIGNING_KEY', signingKey],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name)
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(', ')}. ` +
        'Set them before starting the server (see .env.example).',
    )
  }
  if (signingKey.length < MIN_SIGNING_KEY_LENGTH) {
    throw new Error(
      `MCP_OAUTH_SIGNING_KEY must be at least ${MIN_SIGNING_KEY_LENGTH} characters long.`,
    )
  }

  const sign = (data: string) =>
    createHmac('sha256', signingKey).update(data).digest('base64url')

  const issue = (subject: string): string => {
    const now = Math.floor(Date.now() / 1000)
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(
      JSON.stringify({ iss: issuer, aud: audience, sub: subject, iat: now, exp: now + ttl, jti: randomUUID() }),
    ).toString('base64url')
    return `${header}.${payload}.${sign(`${header}.${payload}`)}`
  }

  const verify = (token: string): AuthResult => {
    const parts = token.split('.')
    if (parts.length !== 3) return { ok: false, reason: 'malformed token' }
    const [header, payload, signature] = parts as [string, string, string]
    if (!safeEqual(signature, sign(`${header}.${payload}`))) {
      return { ok: false, reason: 'invalid signature' }
    }
    try {
      const head = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'))
      if (head.alg !== 'HS256') return { ok: false, reason: 'unsupported algorithm' }
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
      const now = Math.floor(Date.now() / 1000)
      if (typeof claims.exp !== 'number' || claims.exp <= now) return { ok: false, reason: 'token expired' }
      if (claims.iss !== issuer) return { ok: false, reason: 'wrong issuer' }
      if (claims.aud !== audience) return { ok: false, reason: 'wrong audience' }
      return { ok: true, subject: String(claims.sub ?? '') }
    } catch {
      return { ok: false, reason: 'malformed token' }
    }
  }

  return {
    type: 'OAUTH2',
    scheme: 'Bearer',
    disabled: false,
    authenticate(headers) {
      const value = headers.authorization
      if (typeof value !== 'string' || !/^Bearer\s+\S+$/i.test(value)) {
        return { ok: false, reason: 'missing bearer token' }
      }
      return verify(value.replace(/^Bearer\s+/i, ''))
    },
    issueToken(headers, form) {
      if (form.get('grant_type') !== 'client_credentials') {
        return {
          status: 400,
          body: { error: 'unsupported_grant_type', error_description: 'Only client_credentials is supported.' },
        }
      }
      let id = form.get('client_id') ?? ''
      let secret = form.get('client_secret') ?? ''
      const basic = headers.authorization
      if (typeof basic === 'string' && /^Basic\s+/i.test(basic)) {
        const decoded = Buffer.from(basic.replace(/^Basic\s+/i, ''), 'base64').toString('utf8')
        const separator = decoded.indexOf(':')
        if (separator >= 0) {
          id = decodeURIComponent(decoded.slice(0, separator))
          secret = decodeURIComponent(decoded.slice(separator + 1))
        }
      }
      // Both comparisons always run so timing does not reveal which one failed.
      const idOk = safeEqual(id, clientId)
      const secretOk = safeEqual(secret, clientSecret)
      if (!idOk || !secretOk) {
        return {
          status: 401,
          body: { error: 'invalid_client', error_description: 'Client authentication failed.' },
        }
      }
      return {
        status: 200,
        body: { access_token: issue(id), token_type: 'Bearer', expires_in: ttl },
      }
    },
  }
}

function safeEqual(left: string, right: string): boolean {
  const a = createHmac('sha256', 'compare').update(left).digest()
  const b = createHmac('sha256', 'compare').update(right).digest()
  return timingSafeEqual(a, b)
}
