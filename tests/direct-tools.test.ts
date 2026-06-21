import { describe, expect, it, vi } from "vitest";
import { computeServerHash, type CachedResource, type CachedTool, type MetadataCache } from "../src/core/cache.js";
import type { McpConfig, ServerEntry } from "../src/core/config.js";
import { createProxyState, type ProxyState } from "../src/features/proxy-tool.js";
import { collectDirectToolDescriptors, createDirectMcpTool, registerCachedDirectTools, type DirectToolDescriptor } from "../src/features/direct-tools.js";
import type { AdapterRuntime } from "../src/runtime.js";
import type { LettaModApi, LettaToolDefinition } from "../src/mod.js";

function cacheFor(
  entries: Record<string, { definition: ServerEntry; tools?: CachedTool[]; resources?: CachedResource[]; configHash?: string }>,
): MetadataCache {
  return {
    version: 1,
    servers: Object.fromEntries(
      Object.entries(entries).map(([serverName, entry]) => [
        serverName,
        {
          configHash: entry.configHash ?? computeServerHash(entry.definition),
          cachedAt: 1_000,
          tools: entry.tools ?? [{ name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { message: { type: "string" } } } }],
          resources: entry.resources ?? [],
        },
      ]),
    ),
  };
}

function stateWith(config: McpConfig, cache?: MetadataCache): ProxyState {
  return createProxyState({ config, cache: cache ?? { version: 1, servers: {} }, now: 1_000 });
}

function collect(config: McpConfig, cache?: MetadataCache) {
  return collectDirectToolDescriptors(stateWith(config, cache));
}

describe("direct tool descriptor collection", () => {
  it("does not expose direct tools by default", () => {
    const definition: ServerEntry = { command: "node" };
    const result = collect({ mcpServers: { fixture: definition } }, cacheFor({ fixture: { definition } }));

    expect(result.descriptors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("settings.directTools true exposes all valid cached tools for all servers", () => {
    const one: ServerEntry = { command: "one" };
    const two: ServerEntry = { command: "two" };
    const result = collect(
      { settings: { directTools: true }, mcpServers: { one, two } },
      cacheFor({
        one: { definition: one, tools: [{ name: "echo", description: "Echo one", inputSchema: { type: "object" } }] },
        two: { definition: two, tools: [{ name: "lookup", description: "Lookup two", inputSchema: { type: "object" } }] },
      }),
    );

    expect(result.descriptors.map((descriptor) => descriptor.name)).toEqual(["one_echo", "two_lookup"]);
    expect(result.descriptors[0]).toMatchObject({ serverName: "one", originalName: "echo", description: "Echo one" });
    expect(result.warnings).toEqual([]);
  });

  it("server directTools true opts in one server when global setting is false", () => {
    const enabled: ServerEntry = { command: "enabled", directTools: true };
    const disabled: ServerEntry = { command: "disabled" };
    const result = collect(
      { settings: { directTools: false }, mcpServers: { enabled, disabled } },
      cacheFor({ enabled: { definition: enabled }, disabled: { definition: disabled } }),
    );

    expect(result.descriptors.map((descriptor) => descriptor.name)).toEqual(["enabled_echo"]);
  });

  it("server directTools allow-list exposes only matching tools", () => {
    const definition: ServerEntry = { command: "github", directTools: ["search_repositories"] };
    const result = collect(
      { mcpServers: { github: definition } },
      cacheFor({
        github: {
          definition,
          tools: [
            { name: "search_repositories", description: "Search repos" },
            { name: "delete_repository", description: "Delete repo" },
          ],
        },
      }),
    );

    expect(result.descriptors.map((descriptor) => descriptor.name)).toEqual(["github_search_repositories"]);
  });

  it("allow-list matching accepts original, exposed, server, short, and normalized names", () => {
    const original: ServerEntry = { command: "a", directTools: ["read-file"] };
    const exposed: ServerEntry = { command: "b", directTools: ["beta_lookup"] };
    const serverPrefixed: ServerEntry = { command: "c", directTools: ["gamma_mcp_fetch"] };
    const shortPrefixed: ServerEntry = { command: "d", directTools: ["delta_search"] };
    const result = collect(
      {
        settings: { toolPrefix: "short" },
        mcpServers: {
          alpha: original,
          "beta-mcp": exposed,
          "gamma-mcp": serverPrefixed,
          "delta-mcp": shortPrefixed,
        },
      },
      cacheFor({
        alpha: { definition: original, tools: [{ name: "read_file" }] },
        "beta-mcp": { definition: exposed, tools: [{ name: "lookup" }] },
        "gamma-mcp": { definition: serverPrefixed, tools: [{ name: "fetch" }] },
        "delta-mcp": { definition: shortPrefixed, tools: [{ name: "search" }] },
      }),
    );

    expect(result.descriptors.map((descriptor) => descriptor.name)).toEqual([
      "alpha_read_file",
      "beta_lookup",
      "gamma_fetch",
      "delta_search",
    ]);
  });

  it("server directTools false opts out when global direct tools are enabled", () => {
    const enabled: ServerEntry = { command: "enabled" };
    const disabled: ServerEntry = { command: "disabled", directTools: false };
    const result = collect(
      { settings: { directTools: true }, mcpServers: { enabled, disabled } },
      cacheFor({ enabled: { definition: enabled }, disabled: { definition: disabled } }),
    );

    expect(result.descriptors.map((descriptor) => descriptor.name)).toEqual(["enabled_echo"]);
  });

  it("missing or stale cache produces no descriptor and reconnect-oriented warnings when direct tools are configured", () => {
    const missing: ServerEntry = { command: "missing", directTools: true };
    const stale: ServerEntry = { command: "stale", directTools: true };
    const result = collect(
      { mcpServers: { missing, stale } },
      cacheFor({ stale: { definition: stale, configHash: "not-current" } }),
    );

    expect(result.descriptors).toEqual([]);
    expect(result.warnings.join("\n")).toContain('Direct tools for "missing" are configured but metadata cache is missing');
    expect(result.warnings.join("\n")).toContain('Direct tools for "stale" are configured but metadata cache is stale');
    expect(result.warnings.join("\n")).toContain('/lmcp reconnect');
  });

  it("honors excludeTools before direct tool selection", () => {
    const definition: ServerEntry = { command: "fs", directTools: true, excludeTools: ["write_file"] };
    const result = collect(
      { mcpServers: { filesystem: definition } },
      cacheFor({
        filesystem: {
          definition,
          tools: [{ name: "read_file" }, { name: "write_file" }],
        },
      }),
    );

    expect(result.descriptors.map((descriptor) => descriptor.name)).toEqual(["filesystem_read_file"]);
  });

  it("uses active toolPrefix when naming direct tools", () => {
    const definition: ServerEntry = { command: "node", directTools: true };
    const server = collect({ settings: { toolPrefix: "server" }, mcpServers: { "github-mcp": definition } }, cacheFor({ "github-mcp": { definition } }));
    const short = collect({ settings: { toolPrefix: "short" }, mcpServers: { "github-mcp": definition } }, cacheFor({ "github-mcp": { definition } }));
    const none = collect({ settings: { toolPrefix: "none" }, mcpServers: { "github-mcp": definition } }, cacheFor({ "github-mcp": { definition } }));

    expect(server.descriptors.map((descriptor) => descriptor.name)).toEqual(["github_mcp_echo"]);
    expect(short.descriptors.map((descriptor) => descriptor.name)).toEqual(["github_echo"]);
    expect(none.descriptors.map((descriptor) => descriptor.name)).toEqual(["echo"]);
  });

  it("includes resource-backed synthetic tools when reconstructed metadata includes resources", () => {
    const definition: ServerEntry = { command: "node", directTools: ["get_project_readme"] };
    const result = collect(
      { mcpServers: { docs: definition } },
      cacheFor({ docs: { definition, tools: [], resources: [{ name: "Project README", uri: "file:///README.md", description: "Read README" }] } }),
    );

    expect(result.descriptors).toEqual([
      expect.objectContaining({
        name: "docs_get_project_readme",
        originalName: "get_project_readme",
        resourceUri: "file:///README.md",
      }),
    ]);
  });

  it("skips invalid, too-long, proxy-colliding, and duplicate tool names with warnings", () => {
    const invalid: ServerEntry = { command: "invalid", directTools: true };
    const long: ServerEntry = { command: "long", directTools: true };
    const proxyCollision: ServerEntry = { command: "proxy", directTools: true };
    const first: ServerEntry = { command: "first", directTools: true };
    const second: ServerEntry = { command: "second", directTools: true };
    const veryLongName = "x".repeat(65);
    const result = collect(
      {
        settings: { toolPrefix: "none" },
        mcpServers: { invalid, long, proxyCollision, first, second },
      },
      cacheFor({
        invalid: { definition: invalid, tools: [{ name: "bad.name" }] },
        long: { definition: long, tools: [{ name: veryLongName }] },
        proxyCollision: { definition: proxyCollision, tools: [{ name: "mcp" }] },
        first: { definition: first, tools: [{ name: "echo" }] },
        second: { definition: second, tools: [{ name: "echo" }] },
      }),
    );

    expect(result.descriptors.map((descriptor) => descriptor.name)).toEqual(["echo"]);
    expect(result.warnings.join("\n")).toContain('Direct tool "bad.name" skipped');
    expect(result.warnings.join("\n")).toContain(veryLongName);
    expect(result.warnings.join("\n")).toContain('Direct tool "mcp" skipped because it conflicts with the compact MCP proxy tool');
    expect(result.warnings.join("\n")).toContain('Direct tool "echo" skipped because another direct tool already uses that name');
  });
});

function descriptor(overrides: Partial<DirectToolDescriptor> = {}): DirectToolDescriptor {
  return {
    name: "fixture_echo",
    serverName: "fixture",
    originalName: "echo",
    description: "Echo text",
    parameters: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
    ...overrides,
  };
}

function fakeRuntime(callResult: Awaited<ReturnType<AdapterRuntime["callTool"]>> = {
  ok: true,
  target: {
    serverName: "fixture",
    requestedName: "fixture_echo",
    exposedName: "fixture_echo",
    originalName: "echo",
    metadata: { name: "fixture_echo", originalName: "echo", description: "Echo text" },
    isResource: false,
  },
  output: "hello",
  isError: false,
}): AdapterRuntime {
  const state = createProxyState({ config: { mcpServers: {} } });
  return {
    manager: { closeAll: vi.fn(), connect: vi.fn(), getConnection: vi.fn(), close: vi.fn() } as never,
    loadState: vi.fn(() => state),
    connectAndRefresh: vi.fn(),
    callTool: vi.fn(async () => callResult),
    closeAll: vi.fn(async () => undefined),
  };
}

describe("direct MCP tool definitions", () => {
  it("uses descriptor name, description, and object parameters", () => {
    const tool = createDirectMcpTool(descriptor(), fakeRuntime());

    expect(tool).toMatchObject({
      name: "fixture_echo",
      description: expect.stringContaining("Echo text"),
      parameters: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
    });
  });

  it("requires approval and is not parallel-safe", () => {
    const tool = createDirectMcpTool(descriptor(), fakeRuntime());

    expect(tool.requiresApproval).toBe(true);
    expect(tool.parallelSafe).toBe(false);
  });

  it("falls back to an object schema for non-object MCP schemas", () => {
    const tool = createDirectMcpTool(descriptor({ parameters: { type: "string" } }), fakeRuntime());

    expect(tool.parameters).toEqual({ type: "object", properties: {}, additionalProperties: true });
  });

  it("uses an empty object schema for resource descriptors", () => {
    const tool = createDirectMcpTool(descriptor({ resourceUri: "file:///README.md", parameters: { type: "object", properties: { ignored: { type: "string" } } } }), fakeRuntime());

    expect(tool.parameters).toEqual({ type: "object", properties: {}, additionalProperties: false });
  });

  it("returns cancellation before loading state when ctx.signal is aborted", async () => {
    const runtime = fakeRuntime();
    const tool = createDirectMcpTool(descriptor(), runtime);
    const controller = new AbortController();
    controller.abort();

    await expect(tool.run({ cwd: "/tmp/workspace", args: { message: "hello" } as never, signal: controller.signal })).resolves.toBe("MCP request cancelled.");
    expect(runtime.loadState).not.toHaveBeenCalled();
    expect(runtime.callTool).not.toHaveBeenCalled();
  });

  it("loads invocation state from ctx.cwd and calls runtime with JSON-string args plus server hint", async () => {
    const runtime = fakeRuntime();
    const tool = createDirectMcpTool(descriptor(), runtime);
    const signal = new AbortController().signal;

    const output = await tool.run({ cwd: "/tmp/workspace", args: { message: "hello" } as never, signal });

    expect(runtime.loadState).toHaveBeenCalledWith({ cwd: "/tmp/workspace", args: { message: "hello" }, signal });
    expect(runtime.callTool).toHaveBeenCalledWith(
      { cwd: "/tmp/workspace", args: { server: "fixture" }, signal },
      expect.anything(),
      "fixture_echo",
      JSON.stringify({ message: "hello" }),
    );
    expect(output).toBe('Called "fixture_echo" on "fixture".\n\nhello');
  });
});

function registrationRuntime(state: ProxyState): AdapterRuntime {
  return {
    manager: { closeAll: vi.fn(), connect: vi.fn(), getConnection: vi.fn(), close: vi.fn() } as never,
    loadState: vi.fn(() => state),
    connectAndRefresh: vi.fn(),
    callTool: vi.fn(),
    closeAll: vi.fn(async () => undefined),
  };
}

function directState(): ProxyState {
  const definition: ServerEntry = { command: "node", directTools: true };
  return stateWith(
    { mcpServers: { fixture: definition } },
    cacheFor({ fixture: { definition, tools: [{ name: "echo", description: "Echo text", inputSchema: { type: "object" } }] } }),
  );
}

describe("cached direct tool registration", () => {
  it("does not register when tool capability or tools API is missing", () => {
    const state = directState();
    const runtime = registrationRuntime(state);
    const noCapability = { capabilities: { tools: false }, tools: { register: vi.fn() }, diagnostics: { report: vi.fn() } } satisfies LettaModApi;
    const noToolsApi = { capabilities: { tools: true }, diagnostics: { report: vi.fn() } } satisfies LettaModApi;

    expect(registerCachedDirectTools({ letta: noCapability, runtime, activationCwd: "/tmp/workspace" })).toEqual([]);
    expect(registerCachedDirectTools({ letta: noToolsApi, runtime, activationCwd: "/tmp/workspace" })).toEqual([]);
    expect(noCapability.tools.register).not.toHaveBeenCalled();
    expect(runtime.loadState).not.toHaveBeenCalled();
  });

  it("loads activation state from injected activationCwd and registers cached descriptors", () => {
    const state = directState();
    const runtime = registrationRuntime(state);
    const registered: LettaToolDefinition[] = [];
    const disposers = [vi.fn()];
    const letta = {
      capabilities: { tools: true },
      tools: { register: vi.fn((tool: LettaToolDefinition) => { registered.push(tool); return disposers[registered.length - 1] ?? vi.fn(); }) },
      diagnostics: { report: vi.fn() },
    } satisfies LettaModApi;

    const returned = registerCachedDirectTools({ letta, runtime, activationCwd: "/tmp/activation" });

    expect(runtime.loadState).toHaveBeenCalledWith({ cwd: "/tmp/activation" });
    expect(registered.map((tool) => tool.name)).toEqual(["fixture_echo"]);
    expect(returned).toEqual(disposers);
    expect(runtime.connectAndRefresh).not.toHaveBeenCalled();
    expect(runtime.callTool).not.toHaveBeenCalled();
  });

  it("returns and preserves disposers for every registered direct tool", () => {
    const one: ServerEntry = { command: "one", directTools: true };
    const two: ServerEntry = { command: "two", directTools: true };
    const state = stateWith(
      { mcpServers: { one, two } },
      cacheFor({ one: { definition: one }, two: { definition: two, tools: [{ name: "lookup" }] } }),
    );
    const runtime = registrationRuntime(state);
    const first = vi.fn();
    const second = vi.fn();
    const letta = {
      capabilities: { tools: true },
      tools: { register: vi.fn((tool: LettaToolDefinition) => tool.name === "one_echo" ? first : second) },
      diagnostics: { report: vi.fn() },
    } satisfies LettaModApi;

    const returned = registerCachedDirectTools({ letta, runtime, activationCwd: "/tmp/activation" });

    expect(returned).toEqual([first, second]);
  });

  it("reports descriptor warnings and registration failures through diagnostics without throwing", () => {
    const stale: ServerEntry = { command: "stale", directTools: true };
    const valid: ServerEntry = { command: "valid", directTools: true };
    const state = stateWith(
      { mcpServers: { stale, valid } },
      cacheFor({ stale: { definition: stale, configHash: "stale" }, valid: { definition: valid } }),
    );
    const runtime = registrationRuntime(state);
    const letta = {
      capabilities: { tools: true },
      tools: { register: vi.fn(() => { throw new Error("collision"); }) },
      diagnostics: { report: vi.fn() },
    } satisfies LettaModApi;

    expect(() => registerCachedDirectTools({ letta, runtime, activationCwd: "/tmp/activation" })).not.toThrow();
    expect(letta.diagnostics.report).toHaveBeenCalledWith(expect.objectContaining({ severity: "warning", message: expect.stringContaining('Direct tools for "stale"') }));
    expect(letta.diagnostics.report).toHaveBeenCalledWith(expect.objectContaining({ severity: "warning", message: expect.stringContaining("Failed to register direct MCP tool") }));
  });
});
