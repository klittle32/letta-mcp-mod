import http from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

function hasRequiredAuth(req) {
  const requiredBearer = process.env.REQUIRE_BEARER;
  if (requiredBearer && req.headers.authorization !== `Bearer ${requiredBearer}`) return false;
  const headerName = process.env.REQUIRE_HEADER_NAME;
  const headerValue = process.env.REQUIRE_HEADER_VALUE;
  if (headerName && headerValue && req.headers[headerName.toLowerCase()] !== headerValue) return false;
  return true;
}

function createFixtureServer(req) {
  const server = new Server(
    { name: "letta-http-streamable-fixture", version: "1.0.0" },
    { capabilities: { tools: {}, resources: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "echo",
        description: "Echo a message over HTTP",
        inputSchema: {
          type: "object",
          properties: { message: { type: "string", description: "Message to echo" } },
          required: ["message"],
        },
      },
      {
        name: "headers_seen",
        description: "Report selected request headers",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "fail_soft",
        description: "Return an MCP error result over HTTP",
        inputSchema: { type: "object", properties: { message: { type: "string" } } },
      },
    ],
  }));

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: "fixture://http-readme",
        name: "HTTP Fixture README",
        description: "Read resource: fixture://http-readme",
        mimeType: "text/plain",
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri === "fixture://http-readme") {
      return { contents: [{ uri: "fixture://http-readme", text: "HTTP Fixture README content", mimeType: "text/plain" }] };
    }
    throw new Error(`Unknown resource: ${request.params.uri}`);
  });

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
    if (request.params.name === "fail_soft") {
      return { isError: true, content: [{ type: "text", text: String(request.params.arguments?.message ?? "fixture http failure") }] };
    }
    throw new Error(`Unknown tool: ${request.params.name}`);
  });

  return server;
}

const httpServer = http.createServer(async (req, res) => {
  if (!req.url?.startsWith("/mcp")) {
    res.writeHead(404).end("not found");
    return;
  }

  if (!hasRequiredAuth(req)) {
    res.writeHead(401, { "content-type": "text/plain" }).end("unauthorized");
    return;
  }

  if (req.method === "GET" || req.method === "DELETE") {
    res.writeHead(405, { "content-type": "application/json" }).end(JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    }));
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405).end("method not allowed");
    return;
  }

  const mcpServer = createFixtureServer(req);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res);
  } catch (error) {
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "text/plain" }).end(error instanceof Error ? error.message : String(error));
    }
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
