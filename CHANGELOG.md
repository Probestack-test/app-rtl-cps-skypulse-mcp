# Changelog

All notable changes to **SkyPulse MCP** are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-09-27

### Added

- MCP server generated from the API specification (`openapi/openapi.json`), served over Streamable HTTP at `/mcp`.
- 1 tool: `skypulse_get_forecast`.
- Authentication: OAuth 2.0 client credentials.
- Unit tests and a CI/CD workflow that builds, tests and deploys to Cloud Run.
- A Postman collection with tests for the MCP endpoint.
