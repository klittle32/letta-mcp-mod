import http from "node:http";
import { Buffer } from "node:buffer";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const issuedCodes = new Set();
const validAccessTokens = new Set(["fixture-access-token", "fixture-access-token-refreshed", "fixture-client-credentials-token"]);

function json(res, status, value, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(value));
}

function text(res, status, value, headers = {}) {
  res.writeHead(status, { "content-type": "text/plain", ...headers }).end(value);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => body += chunk);
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function originFor(req) {
  return `http://${req.headers.host}`;
}

function createFixtureServer(req) {
  const server = new Server(
    { name: "letta-http-oauth-fixture", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "echo",
        description: "Echo a message over OAuth HTTP",
        inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
      },
      {
        name: "headers_seen",
        description: "Report selected request headers",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === "echo") {
      return { content: [{ type: "text", text: String(request.params.arguments?.message ?? "") }] };
    }
    if (request.params.name === "headers_seen") {
      return { content: [{ type: "text", text: JSON.stringify({
        authorization: req.headers.authorization ? "present" : "missing",
        fixture: req.headers["x-fixture-header"] ?? "missing",
      }) }] };
    }
    throw new Error(`Unknown tool: ${request.params.name}`);
  });

  return server;
}

function parseClientAuth(req, params) {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Basic ")) {
    const decoded = Buffer.from(auth.slice("Basic ".length), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator !== -1) return { clientId: decoded.slice(0, separator), clientSecret: decoded.slice(separator + 1) };
  }
  return { clientId: params.get("client_id"), clientSecret: params.get("client_secret") };
}

const httpServer = http.createServer(async (req, res) => {
  const origin = originFor(req);
  const url = new URL(req.url ?? "/", origin);

  if (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === "/.well-known/oauth-protected-resource/mcp") {
    json(res, 200, {
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      scopes_supported: ["read", "write"],
      bearer_methods_supported: ["header"],
    });
    return;
  }

  if (url.pathname === "/.well-known/oauth-authorization-server") {
    json(res, 200, {
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      registration_endpoint: `${origin}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token", "client_credentials"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["read", "write"],
    });
    return;
  }

  if (url.pathname === "/authorize") {
    const redirectUri = url.searchParams.get("redirect_uri");
    if (!redirectUri) {
      text(res, 400, "missing redirect_uri");
      return;
    }
    const code = `fixture-code-${issuedCodes.size + 1}`;
    issuedCodes.add(code);
    const redirect = new URL(redirectUri);
    redirect.searchParams.set("code", code);
    const state = url.searchParams.get("state");
    if (state) redirect.searchParams.set("state", state);
    res.writeHead(302, { location: redirect.toString() }).end();
    return;
  }

  if (url.pathname === "/register" && req.method === "POST") {
    const metadata = JSON.parse(await readBody(req));
    json(res, 201, {
      ...metadata,
      client_id: "fixture-dynamic-client",
      client_secret: "fixture-dynamic-secret",
      token_endpoint_auth_method: "client_secret_basic",
    });
    return;
  }

  if (url.pathname === "/token" && req.method === "POST") {
    const params = new URLSearchParams(await readBody(req));
    const { clientId } = parseClientAuth(req, params);
    if (!clientId) {
      json(res, 401, { error: "invalid_client", error_description: "missing client" });
      return;
    }
    if (params.get("grant_type") === "authorization_code") {
      const code = params.get("code");
      if (!code || !issuedCodes.has(code)) {
        json(res, 400, { error: "invalid_grant", error_description: "unknown code" });
        return;
      }
      issuedCodes.delete(code);
      json(res, 200, { access_token: "fixture-access-token", refresh_token: "fixture-refresh-token", token_type: "Bearer", expires_in: 3600 });
      return;
    }
    if (params.get("grant_type") === "refresh_token" && params.get("refresh_token") === "fixture-refresh-token") {
      json(res, 200, { access_token: "fixture-access-token-refreshed", token_type: "Bearer", expires_in: 3600 });
      return;
    }
    if (params.get("grant_type") === "client_credentials") {
      const { clientId, clientSecret } = parseClientAuth(req, params);
      if (clientId !== "client-id" || clientSecret !== "client-secret-test-value") {
        json(res, 401, { error: "invalid_client", error_description: "bad client credentials" });
        return;
      }
      json(res, 200, { access_token: "fixture-client-credentials-token", token_type: "Bearer", expires_in: 3600, scope: params.get("scope") ?? undefined });
      return;
    }
    json(res, 400, { error: "unsupported_grant_type" });
    return;
  }

  if (url.pathname !== "/mcp") {
    text(res, 404, "not found");
    return;
  }

  const authorization = req.headers.authorization;
  const token = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
  if (!token || !validAccessTokens.has(token)) {
    text(res, 401, "unauthorized", { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` });
    return;
  }

  if (req.method === "GET" || req.method === "DELETE") {
    json(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
    return;
  }

  if (req.method !== "POST") {
    text(res, 405, "method not allowed");
    return;
  }

  const mcpServer = createFixtureServer(req);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res);
  } catch (error) {
    if (!res.headersSent) text(res, 500, error instanceof Error ? error.message : String(error));
  } finally {
    res.on("close", () => {
      transport.close().catch(() => undefined);
      mcpServer.close().catch(() => undefined);
    });
  }
});

httpServer.listen(0, "127.0.0.1", () => {
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("unexpected address");
  process.stdout.write(`${JSON.stringify({ url: `http://127.0.0.1:${address.port}/mcp` })}\n`);
});

process.on("SIGTERM", () => httpServer.close(() => process.exit(0)));
