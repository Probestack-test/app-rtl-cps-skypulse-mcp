import { loadServerConfig, loadTools } from './config.js'
import { ToolRegistry } from './mcp/tools.js'
import { createLogger } from './observability/logger.js'
import { Metrics } from './observability/metrics.js'
import { createAuth } from './security/auth.js'
import { createApp } from './server.js'
import { UpstreamClient } from './upstream/client.js'

const config = await loadServerConfig()
const logger = createLogger(config.logging, process.env, config.name)
const metrics = new Metrics()

try {
  const auth = createAuth(config)
  if (auth.disabled) {
    logger.warn('Authentication is DISABLED (MCP_AUTH_DISABLED=true, development mode only).')
  }
  const upstream = new UpstreamClient(config, process.env, logger, metrics)
  const tools = new ToolRegistry(await loadTools(), upstream)
  const app = createApp({ config, auth, tools, logger, metrics })

  const port = Number.parseInt(process.env.PORT ?? '8080', 10)
  app.listen(port, () => {
    logger.info('MCP server started', {
      name: config.name,
      version: config.version,
      port,
      mcpPath: config.mcpPath,
      tools: tools.list().length,
      auth: auth.type,
    })
  })

  const shutdown = () => {
    logger.info('Shutting down')
    app.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 5000).unref()
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
} catch (error) {
  logger.error('The server could not start', {
    error: error instanceof Error ? error.message : String(error),
  })
  process.exit(1)
}
