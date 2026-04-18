# CPI AI Assistant — MCP Server

> **Page owner:** Integration Platform Team  
> **Status:** ✅ Live  
> **Last updated:** April 2026

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Prerequisites](#prerequisites)
4. [Project Structure](#project-structure)
5. [Configuration Reference](#configuration-reference)
6. [Deployment to BTP Cloud Foundry](#deployment-to-btp-cloud-foundry)
7. [Local Development](#local-development)
8. [Chat UI — User Guide](#chat-ui--user-guide)
9. [MCP Integration (Claude / Cursor)](#mcp-integration-claude--cursor)
10. [Security](#security)
11. [API Reference](#api-reference)
12. [Troubleshooting](#troubleshooting)
13. [Changelog](#changelog)

---

## Overview

The **CPI AI Assistant** is a Node.js application deployed on **SAP BTP Cloud Foundry** that provides two capabilities from a single deployment:

| Capability | URL | Purpose |
|---|---|---|
| **Chat UI** | `https://<app-url>/` | Browser-based AI assistant for CPI monitoring & troubleshooting |
| **MCP Server** | `https://<app-url>/mcp` | Model Context Protocol endpoint for Claude Code, Cursor, and other AI IDEs |
| **Health check** | `https://<app-url>/health` | Liveness probe for CF health check |

Both capabilities share the same OData client stack and CPI tool registry — the same tools that Claude uses in the Chat UI are also exposed to MCP clients.

**Underlying technology:**

- Backend: [`odata-mcp-proxy`](https://www.npmjs.com/package/odata-mcp-proxy) — handles OData client, XSUAA auth, destination resolution, and MCP server creation
- AI: [Anthropic Claude](https://www.anthropic.com/) via the `@anthropic-ai/sdk` package — powers the agentic loop that converts natural language into OData API calls
- Auth: SAP XSUAA (OAuth 2.0) — protects the MCP endpoint; the Chat UI runs within the same CF app trust boundary

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                   BTP Cloud Foundry                  │
│                                                      │
│  ┌─────────────────────────────────────────────────┐ │
│  │           sbs-btp-is-ci-mcp (Node.js)           │ │
│  │                                                 │ │
│  │  ┌──────────┐  ┌─────────────┐  ┌───────────┐  │ │
│  │  │ Chat UI  │  │ /api/chat   │  │  /mcp     │  │ │
│  │  │ (static) │  │ (agentic    │  │ (MCP SSE  │  │ │
│  │  │          │  │  loop)      │  │  endpoint)│  │ │
│  │  └──────────┘  └──────┬──────┘  └─────┬─────┘  │ │
│  │                       │               │         │ │
│  │              ┌────────▼───────────────▼───────┐ │ │
│  │              │     Claude Tool Registry        │ │ │
│  │              │  (OData tools per entity set)   │ │ │
│  │              └────────────────┬────────────────┘ │ │
│  │                               │                  │ │
│  │              ┌────────────────▼────────────────┐ │ │
│  │              │  odata-mcp-proxy ODataClient     │ │ │
│  │              │  (XSUAA JWT + Destination Svc)   │ │ │
│  │              └────────────────┬────────────────┘ │ │
│  └───────────────────────────────┼─────────────────┘ │
│                                  │                    │
│  ┌───────────────┐  ┌────────────▼──────────────────┐ │
│  │  XSUAA        │  │  Destination Service           │ │
│  │  (sbs-btp-is- │  │  (CPI_API destination →        │ │
│  │   ci-mcp-     │  │   SAP Integration Suite OData) │ │
│  │   xsuaa)      │  └───────────────────────────────┘ │
│  └───────────────┘                                    │
└──────────────────────────────────────────────────────┘
                           │
                 ┌─────────▼──────────┐
                 │  Anthropic API     │
                 │  (Claude model)    │
                 └────────────────────┘
```

### Request flow — Chat UI

1. User types a question in the browser
2. Browser `POST /api/chat` with the conversation history
3. Server runs an **agentic loop** (up to 10 rounds):
   - Calls Claude with the system prompt, tool definitions, and conversation history
   - If Claude requests a tool call, the server executes the OData API call against CPI via the Destination Service
   - Tool results are fed back to Claude
   - Loop ends when Claude produces a final text response (no more tool calls)
4. Server returns the final text + clean conversation history to the browser
5. Browser renders the markdown response

### Request flow — MCP Client (Claude Code / Cursor)

1. MCP client sends `initialize` to `POST /mcp`
2. Server creates a new MCP session with a unique session ID
3. Client sends tool-call requests using the `mcp-session-id` header
4. Server proxies the tool calls to the CPI OData APIs via the Destination Service
5. Results are returned to the MCP client in JSON-RPC format

---

## Prerequisites

| Requirement | Details |
|---|---|
| **SAP BTP subaccount** | Cloud Foundry environment enabled |
| **SAP Integration Suite** | CPI tenant with OData API access |
| **BTP Destination** | Named destination pointing to your CPI OData base URL |
| **BTP Services** | `destination` (lite), `connectivity` (lite), `xsuaa` (application) |
| **Anthropic API Key** | From [console.anthropic.com](https://console.anthropic.com) |
| **MBT (Multi-Target Build Tool)** | `npm install -g mbt` |
| **CF CLI** | v7 or v8 |

---

## Project Structure

```
ci-mcp-server/
├── server.js               # Main application (Express + MCP + agentic loop)
├── ci-api-config.json      # CPI OData entity set definitions and tool registry config
├── package.json            # Node.js dependencies
├── mta.yaml                # MTA deployment descriptor (BTP CF)
├── xs-security.json        # XSUAA OAuth2 scopes and role templates
├── .npmrc                  # npm registry config
├── .gitignore
└── public/
    └── index.html          # Chat UI (single-page app, no build step)
```

### `ci-api-config.json`

This is the central configuration file that defines which CPI OData APIs are exposed as Claude tools. Each entry maps to one OData entity set and specifies:

- `destination` — the BTP Destination name for the CPI tenant
- `pathPrefix` — OData service path prefix (e.g. `/api/v1`)
- `entitySets` — list of entity sets with their operations, keys, navigation properties, and filterable fields

Modifying this file controls which tools are available in both the Chat UI and MCP integrations. A server restart is required after changes.

---

## Configuration Reference

All configuration is passed via **environment variables**. Do not hardcode secrets in `mta.yaml` or source files.

| Variable | Required | Default | Description |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ Yes | — | Anthropic API key. Set via `cf set-env` after deployment. |
| `MODEL_ID` | No | `claude-opus-4-5` | Claude model ID to use for the agentic loop. |
| `CHAT_TIMEOUT_MS` | No | `120000` | Maximum milliseconds for a single `/api/chat` request before returning HTTP 504. |
| `API_CONFIG_FILE` | No | `ci-api-config.json` | Path to the API configuration file. |
| `PORT` | No | Set by CF | Server port (managed automatically by Cloud Foundry). |

### Setting environment variables on BTP CF

```bash
# Required — set immediately after first deployment
cf set-env sbs-btp-is-ci-mcp ANTHROPIC_API_KEY sk-ant-...

# Optional overrides
cf set-env sbs-btp-is-ci-mcp MODEL_ID claude-opus-4-5
cf set-env sbs-btp-is-ci-mcp CHAT_TIMEOUT_MS 90000

# Apply changes
cf restage sbs-btp-is-ci-mcp
```

---

## Deployment to BTP Cloud Foundry

### Step 1 — Clone and install

```bash
git clone <repo-url>
cd ci-mcp-server
npm install
```

### Step 2 — Review `ci-api-config.json`

Ensure the `destination` field in each API entry matches the name of your BTP Destination that points to your CPI OData endpoint.

### Step 3 — Review `xs-security.json`

Update the `redirect-uris` to include your actual CF app URL:

```json
"redirect-uris": [
  "https://claude.ai/api/mcp/auth_callback",
  "https://<your-actual-cf-app-url>/**"
]
```

### Step 4 — Build the MTA archive

```bash
mbt build
```

This produces `mta_archives/sbs-btp-is-ci-mcp_1.0.0.mtar`.

### Step 5 — Deploy to CF

```bash
cf login -a https://api.cf.<region>.hana.ondemand.com -o <org> -s <space>
cf deploy mta_archives/sbs-btp-is-ci-mcp_1.0.0.mtar
```

### Step 6 — Set the API key

```bash
cf set-env sbs-btp-is-ci-mcp ANTHROPIC_API_KEY <your-anthropic-api-key>
cf restage sbs-btp-is-ci-mcp
```

### Step 7 — Verify

```bash
cf app sbs-btp-is-ci-mcp   # Should show "running"
curl https://<app-url>/health
```

---

## Local Development

### `default-env.json`

Create a `default-env.json` in the project root (this file is git-ignored):

```json
{
  "ANTHROPIC_API_KEY": "sk-ant-...",
  "MODEL_ID": "claude-opus-4-5",
  "VCAP_SERVICES": {
    "destination": [ { "credentials": { ... } } ],
    "xsuaa":       [ { "credentials": { ... } } ],
    "connectivity": [ { "credentials": { ... } } ]
  }
}
```

You can download the `VCAP_SERVICES` block from your deployed CF app:

```bash
cf env sbs-btp-is-ci-mcp
```

### Start the server

```bash
npm start
# → Chat UI:  http://localhost:3000/
# → MCP:      http://localhost:3000/mcp
```

---

## Chat UI — User Guide

### Accessing the UI

Navigate to `https://<app-url>/` in your browser. No additional login is required — the app runs within your BTP CF environment.

### Features

| Feature | How to use |
|---|---|
| **Ask a question** | Type in the input box and press Enter (or click the send button) |
| **Newline in input** | Press Shift + Enter |
| **Quick suggestions** | Click any suggestion chip on the welcome screen to pre-fill a common query |
| **New Chat** | Click **+ New Chat** in the header to clear the conversation and start fresh |
| **Copy response** | Hover over any AI response and click **Copy** to copy the full markdown text |
| **Multi-turn conversation** | The assistant remembers context within the same session (up to 20 messages) |

### What you can ask

The assistant can query your CPI tenant in real time. Example questions:

- *"Show me all integration packages"*
- *"List the last 20 failed message processing logs"*
- *"What iFlows are in the VENDOR_ONBOARDING package?"*
- *"Are there any runtime artifacts in ERROR state?"*
- *"Show me the error details for message GUID abc-123"*
- *"List all user credentials in the security store"*
- *"What JMS queues exist and how full are they?"*

### Limitations

- The conversation history is **in-memory in the browser** — refreshing the page starts a new session
- The assistant fetches live data from CPI on every question — responses reflect the current state of the tenant
- Very broad queries (e.g. "show all message logs ever") may hit the 120-second timeout — use filters to narrow the scope

---

## MCP Integration (Claude / Cursor)

### What is MCP?

The Model Context Protocol (MCP) allows AI coding assistants (Claude Code, Cursor, etc.) to call external tools directly. This server exposes all CPI OData entity sets as MCP tools, so an AI IDE can query your CPI tenant without you copying/pasting API responses.

### Connecting Claude Code

Add the following to your Claude Code MCP configuration (`~/.claude/mcp.json` or via the UI):

```json
{
  "mcpServers": {
    "cpi": {
      "type": "http",
      "url": "https://<app-url>/mcp",
      "headers": {
        "Authorization": "Bearer <your-xsuaa-access-token>"
      }
    }
  }
}
```

To obtain an XSUAA access token, use the OAuth2 client credentials flow with the credentials from the `sbs-btp-is-ci-mcp-xsuaa` service instance.

### Connecting Cursor

In Cursor settings → MCP:

```json
{
  "url": "https://<app-url>/mcp",
  "transport": "http",
  "headers": {
    "Authorization": "Bearer <token>"
  }
}
```

### Available tools (examples)

Tools are auto-generated from `ci-api-config.json`. Each entity set produces up to three tools:

| Tool pattern | Example | Description |
|---|---|---|
| `<EntitySet>__list` | `MessageProcessingLogs__list` | List collection with optional `$filter`, `$top`, `$orderby`, `$select`, `$skip` |
| `<EntitySet>__get` | `IntegrationPackages__get` | Fetch a single entity by key |
| `<EntitySet>__<Nav>__list` | `MessageProcessingLogs__ErrorInformations__list` | List a navigation property collection |

---

## Security

### Authentication

| Endpoint | Auth |
|---|---|
| `GET /` (Chat UI) | None — protected by CF route and network policy |
| `POST /api/chat` | None at application level — protected by CF route. Rate-limited to 20 req/min/IP. |
| `POST /mcp` | XSUAA JWT (Bearer token) required |
| `GET /health` | None |

> ⚠️ **Recommendation:** If the Chat UI should be restricted to specific users, add an SAP Application Router (approuter) in front of this app and configure route-level authentication via `xs-app.json`.

### Secrets management

| Secret | Storage | How to set |
|---|---|---|
| `ANTHROPIC_API_KEY` | CF environment variable (never in source code or `mta.yaml`) | `cf set-env` |
| XSUAA credentials | Injected automatically via `VCAP_SERVICES` by CF service binding | Service binding in `mta.yaml` |
| CPI OData credentials | Managed in BTP Destination Service (certificate or OAuth) | BTP Cockpit → Destinations |

### XSUAA roles

| Role template | Scopes | Use |
|---|---|---|
| `MCPViewer` | `read` | Read-only access to CPI data via MCP |
| `MCPEditor` | `read`, `write` | Read + write access (e.g. deploy artifacts) |
| `MCPAdmin` | `read`, `write`, `admin` | Full administrative access |

Assign roles in BTP Cockpit → Security → Role Collections.

### Rate limiting

`/api/chat` is rate-limited to **20 requests per IP per minute**. Exceeding this returns HTTP 429 with the message:
> "Too many requests. Please wait a moment before trying again."

---

## API Reference

### `POST /api/chat`

Sends a message to the agentic loop and receives a response.

**Request body:**
```json
{
  "messages": [
    { "role": "user",      "content": "List all integration packages" },
    { "role": "assistant", "content": "Here are the packages: ..." },
    { "role": "user",      "content": "Show me the iFlows in the first one" }
  ]
}
```

**Validation rules:**
- `messages` must be a non-empty array
- Each message must have `role` = `"user"` or `"assistant"`
- `content` must be a string, max 32,000 characters
- History is trimmed to the last 20 messages before sending to Claude
- History must start with a `user` message after trimming

**Success response (HTTP 200):**
```json
{
  "message": "Here are the iFlows in the VENDOR_ONBOARDING package:\n\n| Id | Name | ...",
  "messages": [
    { "role": "user",      "content": "..." },
    { "role": "assistant", "content": "..." }
  ]
}
```

**Error responses:**

| HTTP Status | Condition |
|---|---|
| `400` | Invalid request body (bad role, missing content, etc.) |
| `429` | Rate limit exceeded |
| `504` | Agentic loop did not complete within `CHAT_TIMEOUT_MS` |
| `500` | Unexpected server error |

### `GET /health`

Returns HTTP 200 with `{ "status": "ok" }` when the server is running. Used by CF health checks.

### `POST /mcp`, `GET /mcp`, `DELETE /mcp`

MCP protocol endpoints. Requires `mcp-session-id` header for all requests except `initialize`. See [MCP specification](https://modelcontextprotocol.io/specification) for full protocol details.

---

## Troubleshooting

### App fails to start with "ANTHROPIC_API_KEY is not set"

```bash
cf set-env sbs-btp-is-ci-mcp ANTHROPIC_API_KEY sk-ant-...
cf restage sbs-btp-is-ci-mcp
```

### Chat UI shows "Server error. Check that your CPI destination and API key are configured correctly."

Check the following in order:
1. `cf env sbs-btp-is-ci-mcp` — verify `ANTHROPIC_API_KEY` is set
2. BTP Cockpit → Destinations — verify the destination named in `ci-api-config.json` exists and the connection test passes
3. `cf logs sbs-btp-is-ci-mcp --recent` — check for detailed error messages

### Chat UI shows "The request timed out. Try a more specific query."

The agentic loop took longer than `CHAT_TIMEOUT_MS` (default: 120s). Options:
- Add a `$filter` or `$top` to narrow the query (e.g. "Show the **last 10** failed messages")
- Increase the timeout: `cf set-env sbs-btp-is-ci-mcp CHAT_TIMEOUT_MS 180000`

### MCP client gets "Session not found" (HTTP 404)

The server was restarted and in-memory sessions were lost. Reconnect your MCP client — it will automatically send a new `initialize` request.

### Destination returns 401 / 403

The destination credentials are expired or incorrect. Refresh them in BTP Cockpit → Destinations.

### `cf deploy` fails: "Service ... not found"

The required BTP services (`destination`, `connectivity`, `xsuaa`) must exist in your CF space before deployment. Create them manually or ensure the `mta.yaml` resources are correct for your account.

---

## Changelog

### v1.1.0 — April 2026

**Security**
- 🔴 Removed hardcoded `ANTHROPIC_API_KEY` from `mta.yaml` — key is now set exclusively via `cf set-env`
- Added startup guard: server exits immediately with a clear error if `ANTHROPIC_API_KEY` is missing

**Reliability**
- Fixed static date in system prompt — date is now generated per-request (was evaluated once at server start)
- Added 120-second request timeout on `/api/chat` with HTTP 504 response and user-facing hint
- Fixed conversation history trimming — history is now trimmed so it always starts with a `user` message
- Added graceful handling of non-JSON (XML) OData error responses in `cleanODataResponse`

**Performance & Security**
- Added **rate limiting**: 20 requests per IP per minute on `/api/chat` (via `express-rate-limit`)
- Model ID is now configurable via `MODEL_ID` environment variable (default: `claude-opus-4-5`)
- Timeout configurable via `CHAT_TIMEOUT_MS` environment variable

**Chat UI**
- Added **New Chat** button in the header — resets conversation without a page reload
- Added **Copy** button on bot responses (appears on hover, with "Copied ✓" confirmation)
- Replaced tenant-specific suggestion button with 6 generic CPI suggestions
- Improved error display: contextual hints shown for 429, 504, and 5xx responses

### v1.0.0 — Initial release

- MCP server exposing CPI OData APIs via `odata-mcp-proxy`
- Browser-based Chat UI with Claude-powered agentic loop
- XSUAA authentication for MCP endpoint
- Deployed on SAP BTP Cloud Foundry