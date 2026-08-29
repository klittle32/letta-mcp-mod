import { ProtocolError, ProtocolErrorCode, Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { appendFileSync } from "node:fs";

const server = new Server(
  { name: "letta-mcp-fixture", version: "1.0.0" },
  { capabilities: { tools: { listChanged: true }, resources: {} } },
);

server.setRequestHandler("tools/list", async () => {
  recordEvent("TOOLS_LIST_COUNT_FILE");
  return {
    tools: [
    {
      name: "echo",
      description: "Echo a message",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string", description: "Message to echo" } },
        required: ["message"],
      },
    },
    {
      name: "list_items",
      description: "List fixture items",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "structured_status",
      description: "Return structured fixture status",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "fail_soft",
      description: "Return an MCP error result",
      inputSchema: { type: "object", properties: { message: { type: "string" } } },
    },
    {
      name: "throw_error",
      description: "Throw a fixture handler error",
      inputSchema: { type: "object", properties: {} },
    },
  ],
  };
});

server.setRequestHandler("resources/list", async () => ({
  resources: [
    {
      uri: "fixture://readme",
      name: "Fixture README",
      description: "Read resource: fixture://readme",
      mimeType: "text/plain",
    },
    {
      uri: "fixture://blob",
      name: "Fixture Blob",
      description: "Read resource: fixture://blob",
      mimeType: "application/octet-stream",
    },
  ],
}));

server.setRequestHandler("resources/read", async (request) => {
  if (request.params.uri === "fixture://readme") {
    return { contents: [{ uri: "fixture://readme", text: "Fixture README content", mimeType: "text/plain" }] };
  }
  if (request.params.uri === "fixture://blob") {
    return { contents: [{ uri: "fixture://blob", blob: "YWJjMTIz", mimeType: "application/octet-stream" }] };
  }
  throw new Error(`Unknown resource: ${request.params.uri}`);
});

server.setRequestHandler("tools/call", async (request) => {
  if (request.params.name === "echo") {
    return { content: [{ type: "text", text: String(request.params.arguments?.message ?? "") }] };
  }
  if (request.params.name === "list_items") {
    if (process.env.NOTIFY_LIST_CHANGED === "1") await server.sendToolListChanged();
    return { content: [{ type: "text", text: "alpha\nbeta\ngamma" }] };
  }
  if (request.params.name === "structured_status") {
    return {
      content: [{ type: "text", text: "Status: ok" }],
      structuredContent: { ok: true, source: "fixture" },
    };
  }
  if (request.params.name === "fail_soft") {
    return { isError: true, content: [{ type: "text", text: String(request.params.arguments?.message ?? "fixture failure") }] };
  }
  if (request.params.name === "throw_error") {
    recordEvent("TOOLS_CALL_COUNT_FILE");
    if (process.env.STALE_CATALOG_ERROR === "1") {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Unknown tool: throw_error");
    }
    throw new Error("fixture thrown failure");
  }
  throw new Error(`Unknown tool: ${request.params.name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);

function recordEvent(envName) {
  const path = process.env[envName];
  if (path) appendFileSync(path, "1\n");
}
