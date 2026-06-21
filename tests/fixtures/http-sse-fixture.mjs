import http from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const sessions = new Map();

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
    { name: "letta-http-sse-fixture", version: "1.0.0" },
    { capabilities: { tools: {}, resources: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "echo",
        description: "Echo a message over SSE",
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
    ],
  }));

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: "fixture://sse-readme",
        name: "SSE Fixture README",
        description: "Read resource: fixture://sse-readme",
        mimeType: "text/plain",
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri === "fixture://sse-readme") {
      return { contents: [{ uri: "fixture://sse-readme", text: "SSE Fixture README content", mimeType: "text/plain" }] };
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
    throw new Error(`Unknown tool: ${request.params.name}`);
  });

  return server;
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");

  if (!hasRequiredAuth(req)) {
    res.writeHead(401, { "content-type": "text/plain" }).end("unauthorized");
    return;
  }

  if (req.method === "GET" && url.pathname === "/sse") {
    const transport = new SSEServerTransport("/messages", res);
    const server = createFixtureServer(req);
    sessions.set(transport.sessionId, { transport, server });
    transport.onclose = () => {
      sessions.delete(transport.sessionId);
      server.close().catch(() => undefined);
    };
    try {
      await server.connect(transport);
    } catch (error) {
      sessions.delete(transport.sessionId);
      if (!res.headersSent) res.writeHead(500).end(error instanceof Error ? error.message : String(error));
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/messages") {
    const sessionId = url.searchParams.get("sessionId");
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session) {
      res.writeHead(404).end("session not found");
      return;
    }
    try {
      const parsedBody = await readJsonBody(req);
      await session.transport.handlePostMessage(req, res, parsedBody);
    } catch (error) {
      if (!res.headersSent) res.writeHead(500).end(error instanceof Error ? error.message : String(error));
    }
    return;
  }

  res.writeHead(404).end("not found");
});

httpServer.listen(0, "127.0.0.1", () => {
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("unexpected address");
  process.stdout.write(`${JSON.stringify({ url: `http://127.0.0.1:${address.port}/sse` })}\n`);
});

process.on("SIGTERM", () => {
  for (const { transport, server } of sessions.values()) {
    transport.close().catch(() => undefined);
    server.close().catch(() => undefined);
  }
  httpServer.close(() => process.exit(0));
});
