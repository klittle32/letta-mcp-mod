import { describe, expect, it } from "vitest";
import { computeServerHash, type CachedTool, type MetadataCache } from "../src/core/cache.js";
import type { McpConfig, ServerEntry } from "../src/core/config.js";
import { createProxyState, executeMcpProxy, type McpProxyArgs } from "../src/features/proxy-tool.js";

function stateWith(config: McpConfig, cache?: MetadataCache, warnings: string[] = []) {
  return createProxyState({ config, cache: cache ?? { version: 1, servers: {} }, warnings, now: 1_000 });
}

function cacheFor(serverName: string, definition: ServerEntry, tools: CachedTool[] = [{ name: "read_file", description: "Read file", inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string", description: "File path" } } } }]): MetadataCache {
  return {
    version: 1,
    servers: {
      [serverName]: {
        configHash: computeServerHash(definition),
        cachedAt: 1_000,
        tools,
        resources: [],
      },
    },
  };
}

function run(args: McpProxyArgs, config: McpConfig, cache?: MetadataCache, warnings?: string[]) {
  return executeMcpProxy(args, stateWith(config, cache, warnings));
}

describe("proxy tool modes", () => {
  it("empty status says 0 configured servers", () => {
    expect(run({}, { mcpServers: {} })).toContain("MCP: 0 configured servers, 0 cached tools.");
  });

  it("status with configured server and no cache says configured/no cache", () => {
    const text = run({}, { mcpServers: { filesystem: { command: "npx" } } });

    expect(text).toContain("filesystem (configured, no cache)");
  });

  it("status with valid cached server shows cached tool count", () => {
    const definition = { command: "npx" };
    const text = run({}, { mcpServers: { filesystem: definition } }, cacheFor("filesystem", definition));

    expect(text).toContain("MCP: 1 configured servers, 1 cached tool.");
    expect(text).toContain("filesystem (1 cached tool)");
  });

  it("server list for unknown server returns actionable error", () => {
    expect(run({ server: "missing" }, { mcpServers: {} })).toContain('Server "missing" is not configured');
  });

  it("server list with cached tools shows names and descriptions", () => {
    const definition = { command: "npx" };
    const text = run({ server: "filesystem" }, { mcpServers: { filesystem: definition } }, cacheFor("filesystem", definition));

    expect(text).toContain("filesystem (1 cached tool)");
    expect(text).toContain("- filesystem_read_file - Read file");
  });

  it("server list/search/describe surface UI resource URIs", () => {
    const definition = { command: "npx" };
    const cache = cacheFor("filesystem", definition, [{ name: "render_card", description: "Render card", uiResourceUri: "ui://card.html" }]);

    const list = run({ server: "filesystem" }, { mcpServers: { filesystem: definition } }, cache);
    const search = run({ search: "render", includeSchemas: false }, { mcpServers: { filesystem: definition } }, cache);
    const describe = run({ describe: "filesystem_render_card" }, { mcpServers: { filesystem: definition } }, cache);

    expect(list).toContain("[UI resource: ui://card.html]");
    expect(search).toContain("UI resource: ui://card.html");
    expect(describe).toContain("UI resource URI: ui://card.html");
  });

  it("search rejects empty query", () => {
    expect(run({ search: "   " }, { mcpServers: {} })).toContain("search query is required");
  });

  it("search ORs whitespace terms", () => {
    const definition = { command: "npx" };
    const cache = cacheFor("filesystem", definition, [
      { name: "read_file", description: "Read file" },
      { name: "list_directory", description: "Directory listing" },
    ]);
    const text = run({ search: "read directory" }, { mcpServers: { filesystem: definition } }, cache);

    expect(text).toContain("filesystem_read_file");
    expect(text).toContain("filesystem_list_directory");
  });

  it("search can filter by server", () => {
    const a = { command: "a" };
    const b = { command: "b" };
    const cache: MetadataCache = {
      version: 1,
      servers: {
        one: { configHash: computeServerHash(a), cachedAt: 1_000, tools: [{ name: "read", description: "Read" }], resources: [] },
        two: { configHash: computeServerHash(b), cachedAt: 1_000, tools: [{ name: "read", description: "Read" }], resources: [] },
      },
    };
    const text = run({ search: "read", server: "two" }, { mcpServers: { one: a, two: b } }, cache);

    expect(text).not.toContain("one_read");
    expect(text).toContain("two_read");
  });

  it("search includes schemas by default", () => {
    const definition = { command: "npx" };
    const text = run({ search: "read" }, { mcpServers: { filesystem: definition } }, cacheFor("filesystem", definition));

    expect(text).toContain("Parameters:");
    expect(text).toContain("path (string) *required*");
  });

  it("search suppresses schemas when includeSchemas is false", () => {
    const definition = { command: "npx" };
    const text = run({ search: "read", includeSchemas: false }, { mcpServers: { filesystem: definition } }, cacheFor("filesystem", definition));

    expect(text).not.toContain("Parameters:");
  });

  it("regex search matches cached tool names and descriptions", () => {
    const definition = { command: "npx" };
    const cache = cacheFor("filesystem", definition, [
      { name: "read_file", description: "Read file" },
      { name: "list_directory", description: "Directory listing" },
      { name: "write_file", description: "Create file" },
    ]);

    const text = run({ search: "^(filesystem_)?(read|list)_", regex: true, includeSchemas: false }, { mcpServers: { filesystem: definition } }, cache);

    expect(text).toContain('matched regex "^(filesystem_)?(read|list)_"');
    expect(text).toContain("filesystem_read_file");
    expect(text).toContain("filesystem_list_directory");
    expect(text).not.toContain("filesystem_write_file");
  });

  it("regex search supports slash-delimited ignore-case patterns", () => {
    const definition = { command: "npx" };
    const cache = cacheFor("filesystem", definition, [{ name: "read_file", description: "Read Important File" }]);

    expect(run({ search: "/important file/i", regex: true, includeSchemas: false }, { mcpServers: { filesystem: definition } }, cache)).toContain("filesystem_read_file");
  });

  it("regex search rejects invalid, empty, and overlong patterns", () => {
    const definition = { command: "npx" };
    const config = { mcpServers: { filesystem: definition }, settings: { regexSearch: { maxPatternLength: 10 } } };

    expect(run({ search: "(", regex: true }, config, cacheFor("filesystem", definition))).toContain("Invalid MCP regex search pattern");
    expect(run({ search: "   ", regex: true }, config, cacheFor("filesystem", definition))).toContain("search query is required");
    expect(run({ search: "a".repeat(11), regex: true }, config, cacheFor("filesystem", definition))).toContain("too long");
  });

  it("describe returns server, original name, description, and schema", () => {
    const definition = { command: "npx" };
    const text = run({ describe: "filesystem_read_file" }, { mcpServers: { filesystem: definition } }, cacheFor("filesystem", definition));

    expect(text).toContain("Tool: filesystem_read_file");
    expect(text).toContain("Server: filesystem");
    expect(text).toContain("Original name: read_file");
    expect(text).toContain("Read file");
    expect(text).toContain("path (string) *required*");
  });

  it("describe unknown tool suggests search", () => {
    expect(run({ describe: "missing" }, { mcpServers: {} })).toContain('Use mcp({ search: "missing" })');
  });

  it("supported OAuth action without runtime returns runtime-required message", () => {
    expect(run({ action: "auth-start" }, { mcpServers: {} })).toContain('MCP OAuth action "auth-start" requires the adapter runtime');
  });

  it("unsupported action returns unsupported action message", () => {
    expect(run({ action: "ui-messages" }, { mcpServers: {} })).toContain('Unsupported MCP action "ui-messages"');
  });

  it("tool without runtime returns runtime-required message", () => {
    expect(run({ tool: "read" }, { mcpServers: {} })).toContain("MCP tool calls for \"read\" require the adapter runtime.");
  });

  it("connect without runtime returns runtime-required message", () => {
    expect(run({ connect: "filesystem" }, { mcpServers: {} })).toContain("requires the adapter runtime");
  });

  it("dispatcher precedence is action > tool > connect > describe > search > server > status", () => {
    expect(run({ action: "ui-messages", tool: "x", connect: "x", describe: "x", search: "x", server: "x" }, { mcpServers: {} })).toContain('Unsupported MCP action "ui-messages"');
    expect(run({ tool: "x", connect: "x", describe: "x", search: "x", server: "x" }, { mcpServers: {} })).toContain("MCP tool calls for \"x\" require the adapter runtime.");
    expect(run({ connect: "x", describe: "x", search: "x", server: "x" }, { mcpServers: {} })).toContain("requires the adapter runtime");
    expect(run({ describe: "x", search: "x", server: "x" }, { mcpServers: {} })).toContain('Tool "x" not found');
    expect(run({ search: "x", server: "x" }, { mcpServers: {} })).toContain('Server "x" is not configured');
    expect(run({ server: "x" }, { mcpServers: {} })).toContain('Server "x" is not configured');
    expect(run({}, { mcpServers: {} })).toContain("MCP: 0 configured servers");
  });
});
