// =============================================================================
// CI MCP Server + Chat UI
//
// Extends the odata-mcp-proxy by adding:
//   - A chat UI served at /
//   - A /api/chat endpoint backed by Claude (agentic loop with CPI tools)
//
// The MCP server (/mcp) and OAuth endpoints continue to work as before,
// so existing Claude Code / MCP client integrations are not affected.
//
// NOTE: odata-mcp-proxy modules are loaded via dynamic import() so that
// API_CONFIG_FILE is set in process.env BEFORE the config module executes.
// Static ESM imports are hoisted and would run before any module-level code.
//
// Environment variables:
//   ANTHROPIC_API_KEY  — Required. Your Anthropic API key.
//                        Set via: cf set-env sbs-btp-is-ci-mcp ANTHROPIC_API_KEY <key>
//   MODEL_ID           — Optional. Claude model ID (default: claude-opus-4-5).
//   CHAT_TIMEOUT_MS    — Optional. Max ms per /api/chat request (default: 120000).
//   API_CONFIG_FILE    — Optional. Path to API config JSON (default: ci-api-config.json).
// =============================================================================
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import express from 'express';
import rateLimit from 'express-rate-limit';
import Anthropic from '@anthropic-ai/sdk';

// ── Validate required env vars early ─────────────────────────────────────────
if (!process.env.ANTHROPIC_API_KEY) {
    console.error('❌  ANTHROPIC_API_KEY is not set.');
    console.error('    Set it via: cf set-env sbs-btp-is-ci-mcp ANTHROPIC_API_KEY <your-key>');
    console.error('    For local dev, add it to default-env.json or export it in your shell.');
    process.exit(1);
}

// Set config file path BEFORE any odata-mcp-proxy module loads
process.env.API_CONFIG_FILE = process.env.API_CONFIG_FILE ?? 'ci-api-config.json';

// Dynamic imports — executed after the env var is set above
const { config, apiConfig }             = await import('odata-mcp-proxy/dist/config/index.js');
const { resolveDestination }            = await import('odata-mcp-proxy/dist/client/destination-service.js');
const { ODataClient }                   = await import('odata-mcp-proxy/dist/client/odata-client.js');
const { createMcpServer }               = await import('odata-mcp-proxy/dist/server/mcp-server.js');
const { registerAllTools }              = await import('odata-mcp-proxy/dist/tools/registry.js');
const { registerApiDocResources }       = await import('odata-mcp-proxy/dist/resources/index.js');
const { createHttpServer,
        startHttpServer }               = await import('odata-mcp-proxy/dist/server/http.js');
const { XsuaaAuth }                     = await import('odata-mcp-proxy/dist/auth/xsuaa-auth.js');
const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Runtime configuration ─────────────────────────────────────────────────────
const MODEL_ID         = process.env.MODEL_ID       ?? 'claude-opus-4-5';
const CHAT_TIMEOUT_MS  = parseInt(process.env.CHAT_TIMEOUT_MS ?? '120000', 10);
const MAX_CHAT_ROUNDS  = 10;
const MAX_HISTORY_MSGS = 20;
const MAX_MSG_LENGTH   = 32_000;

// ── Anthropic client ──────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── OData clients (same setup as odata-mcp-proxy/dist/index.js) ──────────────
const odataClients = apiConfig.apis.map((apiDef) => {
    const getDestination = (jwt) => resolveDestination(apiDef.destination, jwt);
    const client = new ODataClient(
        getDestination,
        apiDef.pathPrefix,
        config.requestTimeout,
        apiDef.csrfProtected ?? true
    );
    return { apiDef, client };
});

const allEntitySets = apiConfig.apis.flatMap((api) => api.entitySets);

// ── Claude tool registry ──────────────────────────────────────────────────────
// Use __ as separator to avoid collisions with entity set names containing _
// e.g. MessageProcessingLogs__list, IntegrationPackages__get
const toolRegistry = new Map(); // toolName → { client, entitySet, operation, navProperty? }
const claudeTools = [];

for (const { apiDef, client } of odataClients) {
    for (const entitySet of apiDef.entitySets) {
        const filterHint = entitySet.filterableProperties?.length
            ? ` Filterable: ${entitySet.filterableProperties.join(', ')}.`
            : '';

        if (entitySet.operations.list) {
            const toolName = `${entitySet.entitySet}__list`;
            toolRegistry.set(toolName, { client, entitySet, operation: 'list' });
            claudeTools.push({
                name: toolName,
                description: `List ${entitySet.description}.${filterHint}`,
                input_schema: {
                    type: 'object',
                    properties: {
                        filter:  { type: 'string',  description: "OData $filter (e.g. \"Status eq 'FAILED'\")" },
                        top:     { type: 'integer', description: 'Max results ($top)' },
                        orderby: { type: 'string',  description: "Sort expression ($orderby, e.g. \"LogEnd desc\")" },
                        select:  { type: 'string',  description: 'Comma-separated fields to return ($select)' },
                        skip:    { type: 'integer', description: 'Results to skip for pagination ($skip)' },
                    },
                },
            });
        }

        if (entitySet.operations.get) {
            const toolName = `${entitySet.entitySet}__get`;
            const keyDesc = entitySet.keys.map((k) => `${k.name} (${k.type})`).join(', ');
            toolRegistry.set(toolName, { client, entitySet, operation: 'get' });
            claudeTools.push({
                name: toolName,
                description: `Get a single ${entitySet.entitySet} by key. Keys: ${keyDesc}.`,
                input_schema: {
                    type: 'object',
                    properties: {
                        key: { type: 'string', description: "Entity key value. For compound keys use: \"Key1='v1',Key2='v2'\"" },
                    },
                    required: ['key'],
                },
            });
        }

        // Navigation properties (e.g. ErrorInformations, Resources, Configurations)
        for (const nav of entitySet.navigationProperties ?? []) {
            if (!nav.isCollection) continue;
            const toolName = `${entitySet.entitySet}__${nav.name}__list`;
            toolRegistry.set(toolName, { client, entitySet, operation: 'nav', navProperty: nav.name });
            claudeTools.push({
                name: toolName,
                description: nav.description,
                input_schema: {
                    type: 'object',
                    properties: {
                        key: { type: 'string', description: 'Parent entity key value' },
                    },
                    required: ['key'],
                },
            });
        }
    }
}

// Add cache_control to the last tool so the full tool list is cached
if (claudeTools.length > 0) {
    claudeTools[claudeTools.length - 1] = {
        ...claudeTools[claudeTools.length - 1],
        cache_control: { type: 'ephemeral' },
    };
}

// ── System prompt ─────────────────────────────────────────────────────────────
// Defined as a function so the date is current on each request rather than
// being frozen at server start time.
function getSystemPrompt() {
    return `You are an AI assistant embedded in SAP Cloud Integration (CPI).
You help integration developers and administrators monitor, manage, and troubleshoot their CPI tenant.

Guidelines:
- Always use the available tools to fetch real data before answering questions about the tenant.
- Present data in clear markdown tables or lists.
- When showing timestamps, convert Unix milliseconds to human-readable dates (e.g. "2026-04-15 11:32").
- When showing errors, highlight the key error message and suggest likely causes.
- Keep responses concise but complete.
- Today's date is ${new Date().toISOString().split('T')[0]}.

Focus on artifact details — do NOT show these fields unless the user explicitly asks for them:
- Who created or modified an artifact (CreatedBy, ModifiedBy, LastModifiedBy)
- Creation or modification dates/timestamps (CreationDate, ModifiedDate, LastChangeTime)
- Internal component/node names (PreviousComponentName, LocalComponentName, OriginComponentName)
- Transaction IDs or correlation IDs unless debugging a specific message
- ResourceId, PackageContent, or other internal identifiers

For packages: focus on Id, Name, Version, ShortText/Description, Mode.
For iFlows/artifacts: focus on Id, Name, Version, PackageId, Type, Status.
For message logs: focus on MessageGuid, IntegrationFlowName, Status, ApplicationMessageType, LogStart, LogEnd, Sender, Receiver.
For runtime artifacts: focus on Id, Name, Version, Type, Status, DeployedOn.`;
}

// ── OData response cleaner ────────────────────────────────────────────────────
// Strips __metadata and __deferred noise from OData V2 responses and returns
// a plain array or object. Caps output at ~50 KB to avoid token bloat.
const MAX_TOOL_RESULT_CHARS = 50_000;

function cleanODataResponse(raw) {
    try {
        // OData V2 wraps results in { d: { results: [...] } } or { d: { ... } }
        const d = raw?.d ?? raw;
        const items = Array.isArray(d?.results) ? d.results : (Array.isArray(d) ? d : [d]);

        const cleaned = items.map((item) => {
            if (typeof item !== 'object' || item === null) return item;
            const out = {};
            for (const [k, v] of Object.entries(item)) {
                if (k === '__metadata') continue;           // OData type/link metadata
                if (v && typeof v === 'object' && '__deferred' in v) continue; // nav link stubs
                out[k] = v;
            }
            return out;
        });

        const result = cleaned.length === 1 ? cleaned[0] : cleaned;
        const json = JSON.stringify(result);
        if (json.length > MAX_TOOL_RESULT_CHARS) {
            // Truncate gracefully — return as many items as fit
            if (Array.isArray(result)) {
                const truncated = [];
                let size = 2; // for [ ]
                for (const item of result) {
                    const chunk = JSON.stringify(item);
                    if (size + chunk.length + 1 > MAX_TOOL_RESULT_CHARS) break;
                    truncated.push(item);
                    size += chunk.length + 1;
                }
                return { results: truncated, truncated: true, total: result.length, returned: truncated.length };
            }
            return json.slice(0, MAX_TOOL_RESULT_CHARS) + '…(truncated)';
        }
        return result;
    } catch (err) {
        // Guard against unexpected response shapes (e.g. XML OData error bodies)
        return { error: 'Failed to parse API response', detail: String(raw).slice(0, 500) };
    }
}

// ── Tool execution ────────────────────────────────────────────────────────────
async function executeTool(toolName, input) {
    const entry = toolRegistry.get(toolName);
    if (!entry) throw new Error(`Unknown tool: ${toolName}`);

    const { client, entitySet, operation, navProperty } = entry;

    let raw;
    if (operation === 'list') {
        const params = [];
        if (input.filter)  params.push(`$filter=${encodeURIComponent(input.filter)}`);
        if (input.top)     params.push(`$top=${input.top}`);
        if (input.orderby) params.push(`$orderby=${encodeURIComponent(input.orderby)}`);
        if (input.select)  params.push(`$select=${encodeURIComponent(input.select)}`);
        if (input.skip)    params.push(`$skip=${input.skip}`);
        const query = params.length ? `?${params.join('&')}` : '';
        raw = await client.execute('GET', `${entitySet.entitySet}${query}`);
    } else if (operation === 'get') {
        raw = await client.execute('GET', `${entitySet.entitySet}(${input.key})`);
    } else if (operation === 'nav') {
        raw = await client.execute('GET', `${entitySet.entitySet}(${input.key})/${navProperty}`);
    } else {
        throw new Error(`Unsupported operation: ${operation}`);
    }

    return cleanODataResponse(raw);
}

// ── Agentic loop ──────────────────────────────────────────────────────────────
async function runAgenticLoop(initialMessages) {
    let currentMessages = initialMessages;
    let finalResponse = null;

    for (let round = 0; round < MAX_CHAT_ROUNDS; round++) {
        const response = await anthropic.messages.create({
            model: MODEL_ID,
            max_tokens: 8096,
            system: [{ type: 'text', text: getSystemPrompt(), cache_control: { type: 'ephemeral' } }],
            tools: claudeTools,
            messages: currentMessages,
        });

        finalResponse = response;

        if (response.stop_reason !== 'tool_use') break;

        // Execute all tool calls in this round
        const toolResults = [];
        for (const block of response.content) {
            if (block.type !== 'tool_use') continue;
            try {
                const result = await executeTool(block.name, block.input);
                toolResults.push({
                    type: 'tool_result',
                    tool_use_id: block.id,
                    content: JSON.stringify(result),
                });
            } catch (err) {
                toolResults.push({
                    type: 'tool_result',
                    tool_use_id: block.id,
                    content: `Error executing tool: ${err.message}`,
                    is_error: true,
                });
            }
        }

        currentMessages = [
            ...currentMessages,
            { role: 'assistant', content: response.content },
            { role: 'user',      content: toolResults },
        ];
    }

    return { finalResponse, currentMessages };
}

// ── MCP session factory ───────────────────────────────────────────────────────
function createMcpSession() {
    const server = createMcpServer(apiConfig.server.name, apiConfig.server.version);
    for (const { apiDef, client } of odataClients) {
        registerAllTools(server, client, apiDef.entitySets, config.enabledApiCategories);
    }
    registerApiDocResources(server, allEntitySets, apiConfig.server.name);
    return server;
}

// ── Express app ───────────────────────────────────────────────────────────────
const auth = new XsuaaAuth();
const app = createHttpServer(config.port, auth);

// Serve chat UI static files
app.use(express.static(join(__dirname, 'public')));

// Increase body size limit for /api/chat — conversation history with CPI data can be large
app.use('/api/chat', express.json({ limit: '10mb' }));

// ── Rate limiter: max 20 /api/chat requests per IP per minute ─────────────────
const chatRateLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Please wait a moment before trying again.' },
});

// ── Chat API endpoint ─────────────────────────────────────────────────────────
app.post('/api/chat', chatRateLimiter, async (req, res) => {
    const { messages } = req.body;

    // ── Input validation ──────────────────────────────────────────────────────
    if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: '"messages" must be a non-empty array.' });
    }

    for (const msg of messages) {
        if (!msg || typeof msg !== 'object') {
            return res.status(400).json({ error: 'Each message must be an object with role and content.' });
        }
        if (!['user', 'assistant'].includes(msg.role)) {
            return res.status(400).json({ error: `Invalid message role "${msg.role}". Must be "user" or "assistant".` });
        }
        if (typeof msg.content !== 'string') {
            return res.status(400).json({ error: 'Message content must be a string.' });
        }
        if (msg.content.length > MAX_MSG_LENGTH) {
            return res.status(400).json({ error: `Message content exceeds ${MAX_MSG_LENGTH.toLocaleString()} character limit.` });
        }
    }

    // ── Trim history, ensuring it starts with a user message ─────────────────
    let trimmedMessages = messages.slice(-MAX_HISTORY_MSGS);
    while (trimmedMessages.length > 0 && trimmedMessages[0].role !== 'user') {
        trimmedMessages = trimmedMessages.slice(1);
    }
    if (trimmedMessages.length === 0) {
        return res.status(400).json({ error: 'No valid user message found in history.' });
    }

    try {
        // ── Run agentic loop with an overall timeout ──────────────────────────
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(
                () => reject(new Error(`Request timed out after ${CHAT_TIMEOUT_MS / 1000}s. The tenant may be slow or the query too broad.`)),
                CHAT_TIMEOUT_MS
            )
        );

        const { finalResponse, currentMessages } = await Promise.race([
            runAgenticLoop(trimmedMessages),
            timeoutPromise,
        ]);

        // ── Extract final text from last response ─────────────────────────────
        const text = finalResponse?.content
            ?.filter((b) => b.type === 'text')
            ?.map((b) => b.text)
            ?.join('') ?? '';

        // ── Build clean text-only history for the client ──────────────────────
        // Tool calls and results are stripped — Claude re-fetches data as needed.
        // This keeps subsequent requests small.
        const clientHistory = [];
        for (const msg of currentMessages) {
            if (msg.role === 'user' && typeof msg.content === 'string') {
                clientHistory.push({ role: 'user', content: msg.content });
            } else if (msg.role === 'assistant' && Array.isArray(msg.content)) {
                const txt = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
                if (txt) clientHistory.push({ role: 'assistant', content: txt });
            }
        }
        if (text) clientHistory.push({ role: 'assistant', content: text });

        res.json({ message: text, messages: clientHistory });
    } catch (err) {
        const isTimeout = err.message.includes('timed out');
        res.status(isTimeout ? 504 : 500).json({ error: err.message });
    }
});

// ── OAuth proxy for MCP clients (Claude.ai / Claude Code remote MCP) ─────────
// MCP clients need to perform an OAuth Authorization Code flow before they can
// connect to /mcp.  XSUAA is a confidential-client IdP (requires client_secret),
// so we proxy the authorize and token requests through the app server, injecting
// the XSUAA client credentials server-side.
//
// Endpoints:
//   GET  /.well-known/oauth-authorization-server  — OAuth metadata discovery
//   GET  /oauth/authorize                          — redirects → XSUAA /oauth/authorize
//   POST /oauth/token                              — proxies  → XSUAA /oauth/token

function getXsuaaCreds() {
    const vcap = JSON.parse(process.env.VCAP_SERVICES || '{}');
    const xsuaaList = vcap.xsuaa || [];
    // prefer the "application" plan binding (the MCP app's own XSUAA)
    const binding = xsuaaList.find((s) => s.plan === 'application') ?? xsuaaList[0];
    return binding?.credentials ?? null;
}

// OAuth server metadata — consumed by MCP client discovery
app.get('/.well-known/oauth-authorization-server', (req, res) => {
    const creds = getXsuaaCreds();
    if (!creds) return res.status(503).json({ error: 'XSUAA credentials not available' });
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.json({
        issuer: creds.url,
        authorization_endpoint: `${baseUrl}/oauth/authorize`,
        token_endpoint: `${baseUrl}/oauth/token`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'client_credentials'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        scopes_supported: ['openid'],
    });
});

// Authorization proxy — injects the XSUAA client_id, then redirects to XSUAA
app.get('/oauth/authorize', (req, res) => {
    const creds = getXsuaaCreds();
    if (!creds) return res.status(503).json({ error: 'XSUAA credentials not available' });
    const params = new URLSearchParams(req.query);
    params.set('client_id', creds.clientid);
    res.redirect(`${creds.url}/oauth/authorize?${params.toString()}`);
});

// Token proxy — injects client_id + client_secret, forwards to XSUAA token endpoint
app.post('/oauth/token', express.urlencoded({ extended: false }), async (req, res) => {
    const creds = getXsuaaCreds();
    if (!creds) return res.status(503).json({ error: 'XSUAA credentials not available' });
    try {
        const body = new URLSearchParams(req.body);
        body.set('client_id', creds.clientid);
        body.set('client_secret', creds.clientsecret);
        const upstream = await fetch(`${creds.url}/oauth/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString(),
        });
        const data = await upstream.json();
        res.status(upstream.status).json(data);
    } catch (err) {
        res.status(502).json({ error: 'Token proxy error', detail: err.message });
    }
});

// ── MCP routes (mirrors odata-mcp-proxy/dist/index.js) ───────────────────────
const sessions = new Map();

app.post('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    const body = req.body;
    const isInitRequest = Array.isArray(body)
        ? body.some((m) => m?.method === 'initialize')
        : body?.method === 'initialize';

    if (!isInitRequest) {
        if (sessionId && sessions.has(sessionId)) {
            const { transport } = sessions.get(sessionId);
            await transport.handleRequest(req, res, req.body);
            return;
        }
        res.status(404).json({
            jsonrpc: '2.0',
            error: { code: -32001, message: 'Session not found' },
            id: null,
        });
        return;
    }

    if (sessionId && sessions.has(sessionId)) {
        const { server: oldServer } = sessions.get(sessionId);
        sessions.delete(sessionId);
        try { await oldServer.close(); } catch { /* ignore */ }
    }

    const assignedSessionId = sessionId ?? randomUUID();
    const server = createMcpSession();
    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => assignedSessionId,
        onsessioninitialized: (id) => sessions.set(id, { transport, server }),
    });

    transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) sessions.delete(sid);
    };

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
});

app.get('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    if (!sessionId || !sessions.has(sessionId)) {
        res.status(400).json({ error: 'Bad Request', message: 'Missing or invalid mcp-session-id header.' });
        return;
    }
    const { transport } = sessions.get(sessionId);
    await transport.handleRequest(req, res);
});

app.delete('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    if (!sessionId || !sessions.has(sessionId)) {
        res.status(400).json({ error: 'Bad Request', message: 'Missing or invalid mcp-session-id header.' });
        return;
    }
    const { transport } = sessions.get(sessionId);
    await transport.handleRequest(req, res, req.body);
});

// ── Start server ──────────────────────────────────────────────────────────────
await startHttpServer(app, config.port);

console.log(`✅ CPI AI Assistant running on port ${config.port}`);
console.log(`   Chat UI : http://localhost:${config.port}/`);
console.log(`   MCP     : http://localhost:${config.port}/mcp`);
console.log(`   Health  : http://localhost:${config.port}/health`);
console.log(`   Model   : ${MODEL_ID}`);
console.log(`   Timeout : ${CHAT_TIMEOUT_MS / 1000}s`);

// Graceful shutdown
async function shutdown() {
    try {
        await Promise.all([...sessions.values()].map(({ server }) => server.close()));
    } catch { /* ignore */ }
    process.exit(0);
}
process.on('SIGINT',  () => void shutdown());
process.on('SIGTERM', () => void shutdown());