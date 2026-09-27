import { describe, expect, it } from 'vitest'
import { loadServerConfig } from '../src/config.js'
import { createAuth } from '../src/security/auth.js'
import { AUTH_ENV } from './auth-support.js'

const config = await loadServerConfig()
const form = (values: Record<string, string>) => new URLSearchParams(values)
const credentials = {
  grant_type: 'client_credentials',
  client_id: AUTH_ENV.MCP_OAUTH_CLIENT_ID,
  client_secret: AUTH_ENV.MCP_OAUTH_CLIENT_SECRET,
}

describe('OAuth 2.0 client credentials', () => {
  const auth = createAuth(config, AUTH_ENV as NodeJS.ProcessEnv)

  it('issues a bearer token that authenticates', () => {
    const issued = auth.issueToken({}, form(credentials))

    expect(issued.status).toBe(200)
    expect(issued.body.token_type).toBe('Bearer')
    const result = auth.authenticate({ authorization: `Bearer ${issued.body.access_token}` })
    expect(result).toEqual({ ok: true, subject: AUTH_ENV.MCP_OAUTH_CLIENT_ID })
  })

  it('accepts the client credentials as HTTP Basic', () => {
    const basic = Buffer.from(
      `${AUTH_ENV.MCP_OAUTH_CLIENT_ID}:${AUTH_ENV.MCP_OAUTH_CLIENT_SECRET}`,
    ).toString('base64')

    const issued = auth.issueToken(
      { authorization: `Basic ${basic}` },
      form({ grant_type: 'client_credentials' }),
    )

    expect(issued.status).toBe(200)
  })

  it('refuses a wrong secret and another grant type', () => {
    expect(auth.issueToken({}, form({ ...credentials, client_secret: 'nope' })).status).toBe(401)
    expect(auth.issueToken({}, form({ ...credentials, grant_type: 'password' })).status).toBe(400)
  })

  it('refuses a tampered, malformed or missing token', () => {
    const token = String(auth.issueToken({}, form(credentials)).body.access_token)
    const [header, payload] = token.split('.')

    expect(auth.authenticate({ authorization: `Bearer ${header}.${payload}.forged` }).ok).toBe(false)
    expect(auth.authenticate({ authorization: 'Bearer not-a-token' }).ok).toBe(false)
    expect(auth.authenticate({}).ok).toBe(false)
  })

  it('refuses an expired token', () => {
    const short = createAuth(config, {
      ...AUTH_ENV,
      MCP_OAUTH_TOKEN_TTL_SECONDS: '-10',
    } as NodeJS.ProcessEnv)
    const token = String(short.issueToken({}, form(credentials)).body.access_token)

    expect(short.authenticate({ authorization: `Bearer ${token}` }).ok).toBe(false)
  })

  it('will not start without its credentials or with a weak signing key', () => {
    expect(() => createAuth(config, {} as NodeJS.ProcessEnv)).toThrow(/MCP_OAUTH_CLIENT_ID/)
    expect(() =>
      createAuth(config, { ...AUTH_ENV, MCP_OAUTH_SIGNING_KEY: 'short' } as NodeJS.ProcessEnv),
    ).toThrow(/at least 32/)
  })

  it('can only be switched off explicitly, and only in development mode', () => {
    const env = { MCP_AUTH_DISABLED: 'true' } as NodeJS.ProcessEnv

    expect(() => createAuth({ ...config, validationMode: 'PRODUCTION' }, env)).toThrow()
    expect(createAuth({ ...config, validationMode: 'DEVELOPMENT' }, env).disabled).toBe(true)
  })
})
