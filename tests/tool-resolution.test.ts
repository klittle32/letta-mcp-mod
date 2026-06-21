import { describe, expect, it } from "vitest";
import { updateServerCache, type MetadataCache } from "../src/core/cache.js";
import type { McpConfig, ServerEntry } from "../src/core/config.js";
import { createProxyState, type ProxyState } from "../src/features/proxy-tool.js";
import { inferServerHint, resolveToolTarget } from "../src/mcp/calls.js";

const definition: ServerEntry = { command: "node", args: ["fixture.mjs"] };
const otherDefinition: ServerEntry = { command: "node", args: ["other.mjs"] };

function stateWithCache(options: {
  config?: McpConfig;
  cache?: MetadataCache;
  now?: number;
} = {}): ProxyState {
  const config = options.config ?? {
    mcpServers: {
      fixture: definition,
      other: otherDefinition,
    },
    settings: { toolPrefix: "server" },
  };
  let cache = options.cache ?? { version: 1 as const, servers: {} };
  cache = updateServerCache({
    cache,
    serverName: "fixture",
    definition: config.mcpServers.fixture,
    now: options.now ?? 1000,
    tools: [
      { name: "echo", description: "Echo", inputSchema: { type: "object" } },
      { name: "shared", description: "Shared", inputSchema: { type: "object" } },
    ],
    resources: [{ uri: "fixture://readme", name: "Fixture README", description: "Read resource: fixture://readme" }],
  });
  if (config.mcpServers.other) {
    cache = updateServerCache({
      cache,
      serverName: "other",
      definition: config.mcpServers.other,
      now: options.now ?? 1000,
      tools: [{ name: "shared", description: "Other shared", inputSchema: { type: "object" } }],
      resources: [],
    });
  }
  return createProxyState({ config, cache, now: options.now ?? 1000 });
}

describe("tool target resolution", () => {
  it("finds cached exposed name", () => {
    const result = resolveToolTarget(stateWithCache(), { toolName: "fixture_echo" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target).toMatchObject({ serverName: "fixture", requestedName: "fixture_echo", exposedName: "fixture_echo", originalName: "echo", isResource: false });
    }
  });

  it("finds cached original name when unambiguous", () => {
    const result = resolveToolTarget(stateWithCache(), { toolName: "echo" });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.target.exposedName).toBe("fixture_echo");
  });

  it("honors server hint and does not search other servers", () => {
    const result = resolveToolTarget(stateWithCache(), { toolName: "shared", serverName: "other" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target.serverName).toBe("other");
      expect(result.target.exposedName).toBe("other_shared");
    }
  });

  it("reports unknown server hint", () => {
    expect(resolveToolTarget(stateWithCache(), { toolName: "echo", serverName: "missing" })).toEqual({
      ok: false,
      kind: "unknown_server",
      message: 'Server "missing" is not configured. Use mcp({}) to list configured servers.',
    });
  });

  it("reports unknown tool with search/connect hint", () => {
    const result = resolveToolTarget(stateWithCache(), { toolName: "missing" });

    expect(result).toEqual({
      ok: false,
      kind: "unknown_tool",
      message: 'Tool "missing" was not found in cached MCP metadata. Use mcp({ search: "missing" }) or mcp({ connect: "server" }) first.',
      serverHint: undefined,
    });
  });

  it("identifies synthetic resource target from resourceUri", () => {
    const result = resolveToolTarget(stateWithCache(), { toolName: "fixture_get_fixture_readme" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target.isResource).toBe(true);
      expect(result.target.resourceUri).toBe("fixture://readme");
    }
  });

  it("infers server prefix when toolPrefix is server and configured server matches", () => {
    expect(inferServerHint(stateWithCache(), "fixture_echo")).toBe("fixture");
  });

  it("does not infer every configured server for an unhinted unknown tool", () => {
    expect(inferServerHint(stateWithCache(), "unknown_tool")).toBeUndefined();
  });

  it("reports ambiguity if original name appears in multiple cached servers", () => {
    const result = resolveToolTarget(stateWithCache(), { toolName: "shared" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("ambiguous_tool");
      expect(result.message).toContain("fixture_shared");
      expect(result.message).toContain("other_shared");
    }
  });
});
