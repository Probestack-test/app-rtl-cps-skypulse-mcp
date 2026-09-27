import { randomBytes } from 'node:crypto'

const random = () => randomBytes(24).toString('hex')

/** Test credentials for the OAuth 2.0 client-credentials flow: generated for each run, never written down. */
export const AUTH_ENV = {
  MCP_OAUTH_CLIENT_ID: 'test-client',
  MCP_OAUTH_CLIENT_SECRET: random(),
  MCP_OAUTH_SIGNING_KEY: random(),
}

/** Gets an access token from the server's token endpoint and returns the header that carries it. */
export async function authHeaders(baseUrl: string): Promise<Record<string, string>> {
  const response = await fetch(`${baseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: AUTH_ENV.MCP_OAUTH_CLIENT_ID,
      client_secret: AUTH_ENV.MCP_OAUTH_CLIENT_SECRET,
    }),
  })
  const { access_token } = (await response.json()) as { access_token: string }
  return { authorization: `Bearer ${access_token}` }
}
