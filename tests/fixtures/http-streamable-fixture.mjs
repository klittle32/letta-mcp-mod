import http from "node:http";
import {
  createMcpHandler,
  Server,
} from "@modelcontextprotocol/server";

function hasRequiredAuth(req) {
  const requiredBearer = process.env.REQUIRE_BEARER;
  if (requiredBearer && req.headers.authorization !== `Bearer ${requiredBearer}`) return false;
  const headerName = process.env.REQUIRE_HEADER_NAME;
  const headerValue = process.env.REQUIRE_HEADER_VALUE;
  if (headerName && headerValue && req.headers[headerName.toLowerCase()] !== headerValue) return false;
  return true;
}

const stats = {
  methods: {},
  requestIds: [],
  protocolHeaders: [],
  dropped: false,
  corrected: false,
};

function createFixtureServer(req) {
  const server = new Server(
    { name: "letta-http-streamable-fixture", version: "1.0.0" },
    { capabilities: { tools: {}, resources: {} } },
  );

  server.setRequestHandler("tools/list", async (request) => {
    const tools = [
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
    ];
    if (process.env.PAGINATE_TOOLS === "1") {
      return request.params?.cursor
        ? { tools: tools.slice(1) }
        : { tools: tools.slice(0, 1), nextCursor: "fixture-page-2" };
    }
    return { tools };
  });

  server.setRequestHandler("resources/list", async () => ({
    resources: [
      {
        uri: "fixture://http-readme",
        name: "HTTP Fixture README",
        description: "Read resource: fixture://http-readme",
        mimeType: "text/plain",
      },
    ],
  }));

  server.setRequestHandler("resources/read", async (request) => {
    if (request.params.uri === "fixture://http-readme") {
      return { contents: [{ uri: "fixture://http-readme", text: "HTTP Fixture README content", mimeType: "text/plain" }] };
    }
    throw new Error(`Unknown resource: ${request.params.uri}`);
  });

  server.setRequestHandler("tools/call", async (request) => {
    if (request.params.name === "echo") {
      return { content: [{ type: "text", text: String(request.params.arguments?.message ?? "") }] };
    }
    if (request.params.name === "headers_seen") {
      return { content: [{ type: "text", text: JSON.stringify({
        authorization: req.headers.get("authorization") ? "present" : "missing",
        fixture: req.headers.get("x-fixture-header") ?? "missing",
      }) }] };
    }
    if (request.params.name === "fail_soft") {
      return { isError: true, content: [{ type: "text", text: String(request.params.arguments?.message ?? "fixture http failure") }] };
    }
    throw new Error(`Unknown tool: ${request.params.name}`);
  });

  return server;
}

const mcpHandler = createMcpHandler(
  ({ requestInfo }) => createFixtureServer(requestInfo),
  { responseMode: "json" },
);

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  if (url.pathname === "/stats") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(stats));
    return;
  }

  if (url.pathname !== "/mcp") {
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

  const body = await readBody(req);
  const parsedBody = JSON.parse(body);
  const messages = Array.isArray(parsedBody) ? parsedBody : [parsedBody];
  for (const message of messages) {
    if (typeof message?.method === "string") {
      stats.methods[message.method] = (stats.methods[message.method] ?? 0) + 1;
    }
    if (message?.id !== undefined) stats.requestIds.push(message.id);
  }
  stats.protocolHeaders.push(req.headers["mcp-protocol-version"] ?? null);

  const requestedMethod = messages.find((message) => typeof message?.method === "string")?.method;
  if (process.env.DROP_METHOD_ONCE === requestedMethod && !stats.dropped) {
    stats.dropped = true;
    req.socket.destroy();
    return;
  }
  if (process.env.CORRECT_DISCOVER_ONCE === "1" && requestedMethod === "server/discover" && !stats.corrected) {
    stats.corrected = true;
    const request = messages[0];
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      error: {
        code: -32022,
        message: "Use the supported protocol version.",
        data: { supported: ["2026-07-28"], requested: "2026-07-28" },
      },
    }));
    return;
  }

  try {
    const response = await mcpHandler.fetch(toWebRequest(req, body), { parsedBody });
    await sendWebResponse(res, response);
  } catch (error) {
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "text/plain" }).end(error instanceof Error ? error.message : String(error));
    }
  }
});

httpServer.listen(0, "127.0.0.1", () => {
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("unexpected address");
  process.stdout.write(`${JSON.stringify({ url: `http://127.0.0.1:${address.port}/mcp` })}\n`);
});

process.on("SIGTERM", () => {
  mcpHandler.close().finally(() => httpServer.close(() => process.exit(0)));
});

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => body += chunk);
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function toWebRequest(req, body) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  return new Request(`http://${req.headers.host}${req.url}`, {
    method: req.method,
    headers,
    body: body || undefined,
  });
}

async function sendWebResponse(res, response) {
  const headers = Object.fromEntries(response.headers.entries());
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
}
