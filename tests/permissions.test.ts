import { describe, expect, it, vi } from "vitest";
import { computeServerHash, type MetadataCache } from "../src/core/cache.js";
import type { McpSettings } from "../src/core/config.js";
import type { McpConfig, ServerEntry } from "../src/core/config.js";
import { createProxyState, type ProxyState } from "../src/features/proxy-tool.js";
import { ApprovalTracker, decideMcpPermission, normalizeApprovalSettings, registerMcpPermissions, type LettaPermissionEvent } from "../src/features/permissions.js";
import type { AdapterRuntime } from "../src/runtime.js";

function cacheFor(entries: Record<string, { definition: ServerEntry; tools?: Array<{ name: string; description?: string }> }>): MetadataCache {
  return {
    version: 1,
    servers: Object.fromEntries(Object.entries(entries).map(([serverName, entry]) => [
      serverName,
      {
        configHash: computeServerHash(entry.definition),
        cachedAt: 1_000,
        tools: entry.tools ?? [{ name: "search", description: "Search things" }],
        resources: [],
      },
    ])),
  };
}

function stateWith(config: McpConfig, cache?: MetadataCache): ProxyState {
  return createProxyState({ config, cache: cache ?? { version: 1, servers: {} }, now: 1_000 });
}

function permissionEvent(args: Record<string, unknown>, overrides: Partial<LettaPermissionEvent> = {}): LettaPermissionEvent {
  return {
    agentId: "agent-test",
    conversationId: "conv-test",
    toolCallId: "call-test",
    toolName: "mcp",
    args,
    cwd: "/tmp/workspace",
    workingDirectory: "/tmp/workspace",
    permissionMode: "default",
    phase: "approval",
    ...overrides,
  };
}

function fakeRuntime(state: ProxyState): AdapterRuntime {
  return {
    manager: { closeAll: vi.fn(), connect: vi.fn(), getConnection: vi.fn(), close: vi.fn() } as never,
    loadState: vi.fn(() => state),
    connectAndRefresh: vi.fn(),
    callTool: vi.fn(),
    closeAll: vi.fn(async () => undefined),
  };
}

describe("MCP permission approval settings", () => {
  it("uses safe defaults when approval settings are missing", () => {
    expect(normalizeApprovalSettings(undefined)).toEqual({
      approval: {
        dangerousTools: "ask",
        unknownServers: "deny",
        configWrites: "alwaysAsk",
      },
      warnings: [],
    });
  });

  it("preserves valid approval decisions", () => {
    expect(normalizeApprovalSettings({ dangerousTools: "alwaysAsk", unknownServers: "ask", configWrites: "allow" })).toEqual({
      approval: {
        dangerousTools: "alwaysAsk",
        unknownServers: "ask",
        configWrites: "allow",
      },
      warnings: [],
    });
  });

  it("falls back to defaults for invalid approval decisions with concise warnings", () => {
    const result = normalizeApprovalSettings({ dangerousTools: "maybe", unknownServers: false, configWrites: "deny" });

    expect(result.approval).toEqual({
      dangerousTools: "ask",
      unknownServers: "deny",
      configWrites: "deny",
    });
    expect(result.warnings).toEqual([
      'Invalid MCP approval setting "dangerousTools": expected allow, ask, alwaysAsk, or deny.',
      'Invalid MCP approval setting "unknownServers": expected allow, ask, alwaysAsk, or deny.',
    ]);
  });

  it("types settings.approval without an any cast", () => {
    const settings: McpSettings = {
      approval: {
        dangerousTools: "deny",
        unknownServers: "allow",
        configWrites: "alwaysAsk",
      },
    };

    expect(settings.approval?.dangerousTools).toBe("deny");
  });
});

describe("MCP permission decisions for benign proxy operations", () => {
  const definition: ServerEntry = { command: "node" };
  const state = stateWith(
    { mcpServers: { github: definition } },
    cacheFor({ github: { definition, tools: [{ name: "search", description: "Search repos" }] } }),
  );

  it("returns no opinion for unrelated tools", () => {
    expect(decideMcpPermission(permissionEvent({}, { toolName: "read_file" }), state)).toBeUndefined();
  });

  it("allows proxy status", () => {
    expect(decideMcpPermission(permissionEvent({}), state)).toEqual({ decision: "allow", reason: "MCP status/search/describe is read-only." });
  });

  it("allows proxy search", () => {
    expect(decideMcpPermission(permissionEvent({ search: "repo" }), state)).toEqual({ decision: "allow", reason: "MCP status/search/describe is read-only." });
  });

  it("allows proxy describe", () => {
    expect(decideMcpPermission(permissionEvent({ describe: "github_search" }), state)).toEqual({ decision: "allow", reason: "MCP status/search/describe is read-only." });
  });

  it("allows configured server listing", () => {
    expect(decideMcpPermission(permissionEvent({ server: "github" }), state)).toEqual({ decision: "allow", reason: "MCP server listing is read-only." });
  });

  it("denies missing server listing by default", () => {
    expect(decideMcpPermission(permissionEvent({ server: "missing" }), state)).toEqual({ decision: "deny", reason: 'MCP server "missing" is not configured.' });
  });
});

describe("MCP permission decisions for live proxy and OAuth operations", () => {
  const definition: ServerEntry = { command: "node" };

  it("asks before connecting a configured server", () => {
    const state = stateWith({ mcpServers: { github: definition } });

    expect(decideMcpPermission(permissionEvent({ connect: "github" }), state)).toEqual({
      decision: "ask",
      reason: 'Connecting MCP server "github" may start external processes or network connections.',
    });
  });

  it("denies connecting an unknown server by default", () => {
    const state = stateWith({ mcpServers: { github: definition } });

    expect(decideMcpPermission(permissionEvent({ connect: "missing" }), state)).toEqual({
      decision: "deny",
      reason: 'MCP server "missing" is not configured.',
    });
  });

  it("uses configured unknown-server policy for missing live targets", () => {
    const state = stateWith({
      mcpServers: { github: definition },
      settings: { approval: { unknownServers: "ask" } },
    });

    expect(decideMcpPermission(permissionEvent({ connect: "missing" }), state)).toEqual({
      decision: "ask",
      reason: 'MCP server "missing" is not configured.',
    });
  });

  it("allows OAuth status for a configured server", () => {
    const state = stateWith({ mcpServers: { github: definition } });

    expect(decideMcpPermission(permissionEvent({ action: "auth-status", server: "github" }), state)).toEqual({
      decision: "allow",
      reason: "MCP OAuth status is read-only.",
    });
  });

  it("asks before starting OAuth for a configured server", () => {
    const state = stateWith({ mcpServers: { github: definition } });

    expect(decideMcpPermission(permissionEvent({ action: "auth-start", server: "github" }), state)).toEqual({
      decision: "ask",
      reason: 'MCP OAuth action "auth-start" may change authentication state.',
    });
  });

  it("asks before completing OAuth for a configured server", () => {
    const state = stateWith({ mcpServers: { github: definition } });

    expect(decideMcpPermission(permissionEvent({ action: "auth-complete", server: "github", args: "code=abc" }), state)).toEqual({
      decision: "ask",
      reason: 'MCP OAuth action "auth-complete" may change authentication state.',
    });
  });
});

describe("MCP permission decisions for proxy tool-call risk", () => {
  const definition: ServerEntry = { command: "node" };

  it("allows a benign configured cached tool call", () => {
    const state = stateWith(
      { mcpServers: { github: definition } },
      cacheFor({ github: { definition, tools: [{ name: "search", description: "Search repos" }] } }),
    );

    expect(decideMcpPermission(permissionEvent({ tool: "github_search", args: "{}" }), state)).toEqual({
      decision: "allow",
      reason: 'MCP tool "github_search" is allowed by policy.',
    });
  });

  it("asks for dangerous exposed tool names by default", () => {
    const state = stateWith(
      { mcpServers: { fs: definition } },
      cacheFor({ fs: { definition, tools: [{ name: "delete_file", description: "Delete a file" }] } }),
    );

    expect(decideMcpPermission(permissionEvent({ tool: "fs_delete_file", args: "{}" }), state)).toEqual({
      decision: "ask",
      reason: 'MCP tool "fs_delete_file" is potentially dangerous.',
    });
  });

  it("honors dangerousTools alwaysAsk", () => {
    const state = stateWith(
      { mcpServers: { fs: definition }, settings: { approval: { dangerousTools: "alwaysAsk" } } },
      cacheFor({ fs: { definition, tools: [{ name: "write_file", description: "Write a file" }] } }),
    );

    expect(decideMcpPermission(permissionEvent({ tool: "fs_write_file", args: "{}" }), state)).toEqual({
      decision: "alwaysAsk",
      reason: 'MCP tool "fs_write_file" is potentially dangerous.',
    });
  });

  it("honors dangerousTools deny", () => {
    const state = stateWith(
      { mcpServers: { fs: definition }, settings: { approval: { dangerousTools: "deny" } } },
      cacheFor({ fs: { definition, tools: [{ name: "shell", description: "Run shell" }] } }),
    );

    expect(decideMcpPermission(permissionEvent({ tool: "fs_shell", args: "{}" }), state)).toEqual({
      decision: "deny",
      reason: 'MCP tool "fs_shell" is potentially dangerous.',
    });
  });

  it("considers original MCP tool names when exposed names are benign", () => {
    const state = stateWith({ mcpServers: { fs: definition } });
    const server = state.servers.get("fs");
    if (!server) throw new Error("missing test server");
    server.tools = [{ name: "safe_alias", originalName: "delete", description: "Alias", serverName: "fs" }];

    expect(decideMcpPermission(permissionEvent({ tool: "safe_alias", args: "{}" }), state)).toEqual({
      decision: "ask",
      reason: 'MCP tool "safe_alias" is potentially dangerous.',
    });
  });

  it("denies unresolved tool calls safely", () => {
    const state = stateWith(
      { mcpServers: { github: definition } },
      cacheFor({ github: { definition, tools: [{ name: "search", description: "Search repos" }] } }),
    );

    expect(decideMcpPermission(permissionEvent({ tool: "missing_tool", args: "{}" }), state)).toEqual({
      decision: "deny",
      reason: 'MCP tool "missing_tool" was not found in cached metadata.',
    });
  });

  it("does not throw on invalid proxy args JSON", () => {
    const state = stateWith(
      { mcpServers: { fs: definition } },
      cacheFor({ fs: { definition, tools: [{ name: "search", description: "Search files" }] } }),
    );

    expect(() => decideMcpPermission(permissionEvent({ tool: "fs_search", args: "{" }), state)).not.toThrow();
    expect(decideMcpPermission(permissionEvent({ tool: "fs_search", args: "{" }), state)).toEqual({
      decision: "allow",
      reason: 'MCP tool "fs_search" is allowed by policy.',
    });
  });
});

describe("MCP permission decisions for path arguments", () => {
  const definition: ServerEntry = { command: "node" };

  function readState(config: Partial<McpConfig> = {}): ProxyState {
    return stateWith(
      { mcpServers: { fs: definition }, ...config },
      cacheFor({ fs: { definition, tools: [{ name: "read_file", description: "Read a file" }] } }),
    );
  }

  it("allows path-like args inside cwd", () => {
    expect(decideMcpPermission(permissionEvent({ tool: "fs_read_file", args: JSON.stringify({ path: "/tmp/workspace/README.md" }) }, { cwd: "/tmp/workspace", workingDirectory: "/tmp/workspace" }), readState())).toEqual({
      decision: "allow",
      reason: 'MCP tool "fs_read_file" is allowed by policy.',
    });
  });

  it("allows relative path-like args resolving inside cwd", () => {
    expect(decideMcpPermission(permissionEvent({ tool: "fs_read_file", args: JSON.stringify({ filename: "src/index.ts" }) }, { cwd: "/tmp/workspace", workingDirectory: "/tmp/workspace" }), readState())).toEqual({
      decision: "allow",
      reason: 'MCP tool "fs_read_file" is allowed by policy.',
    });
  });

  it("asks for absolute path-like args outside cwd", () => {
    expect(decideMcpPermission(permissionEvent({ tool: "fs_read_file", args: JSON.stringify({ path: "/etc/passwd" }) }, { cwd: "/tmp/workspace", workingDirectory: "/tmp/workspace" }), readState())).toEqual({
      decision: "ask",
      reason: 'MCP tool "fs_read_file" uses a path outside the working directory.',
    });
  });

  it("inspects nested path-like fields", () => {
    expect(decideMcpPermission(permissionEvent({ tool: "fs_read_file", args: JSON.stringify({ input: { destination: "../outside.txt" } }) }, { cwd: "/tmp/workspace/project", workingDirectory: "/tmp/workspace/project" }), readState())).toEqual({
      decision: "ask",
      reason: 'MCP tool "fs_read_file" uses a path outside the working directory.',
    });
  });

  it("ignores non-path strings", () => {
    expect(decideMcpPermission(permissionEvent({ tool: "fs_read_file", args: JSON.stringify({ query: "../outside.txt", url: "https://example.com/file" }) }), readState())).toEqual({
      decision: "allow",
      reason: 'MCP tool "fs_read_file" is allowed by policy.',
    });
  });

  it("uses working directory values without reading the filesystem", () => {
    expect(decideMcpPermission(permissionEvent({ tool: "fs_read_file", args: JSON.stringify({ dir: ".." }) }, { cwd: "/var/tmp/workspace/subdir", workingDirectory: "/var/tmp/workspace/subdir" }), readState({ settings: { approval: { dangerousTools: "deny" } } }))).toEqual({
      decision: "deny",
      reason: 'MCP tool "fs_read_file" uses a path outside the working directory.',
    });
  });
});

describe("MCP permission decisions for direct tools", () => {
  const definition: ServerEntry = { command: "node" };

  it("allows a known cached benign direct tool", () => {
    const state = stateWith(
      { mcpServers: { github: { ...definition, directTools: true } } },
      cacheFor({ github: { definition: { ...definition, directTools: true }, tools: [{ name: "search", description: "Search repos" }] } }),
    );

    expect(decideMcpPermission(permissionEvent({ query: "repo" }, { toolName: "github_search" }), state)).toEqual({
      decision: "allow",
      reason: 'MCP direct tool "github_search" is allowed by policy.',
    });
  });

  it("asks for a dangerous cached direct tool by default", () => {
    const serverDefinition: ServerEntry = { ...definition, directTools: true };
    const state = stateWith(
      { mcpServers: { fs: serverDefinition } },
      cacheFor({ fs: { definition: serverDefinition, tools: [{ name: "delete_file", description: "Delete a file" }] } }),
    );

    expect(decideMcpPermission(permissionEvent({ path: "README.md" }, { toolName: "fs_delete_file" }), state)).toEqual({
      decision: "ask",
      reason: 'MCP direct tool "fs_delete_file" is potentially dangerous.',
    });
  });

  it("asks for direct tool path args outside cwd", () => {
    const serverDefinition: ServerEntry = { ...definition, directTools: true };
    const state = stateWith(
      { mcpServers: { fs: serverDefinition } },
      cacheFor({ fs: { definition: serverDefinition, tools: [{ name: "read_file", description: "Read a file" }] } }),
    );

    expect(decideMcpPermission(permissionEvent({ path: "/etc/passwd" }, { toolName: "fs_read_file" }), state)).toEqual({
      decision: "ask",
      reason: 'MCP direct tool "fs_read_file" uses a path outside the working directory.',
    });
  });

  it("denies a previously registered direct tool that no longer resolves in current state", () => {
    const state = stateWith({ mcpServers: { fs: { ...definition, directTools: true } } });

    expect(decideMcpPermission(permissionEvent({}, { toolName: "fs_search" }), state, { directToolNames: ["fs_search"] })).toEqual({
      decision: "deny",
      reason: 'MCP direct tool "fs_search" is no longer present in current cached metadata.',
    });
  });

  it("leaves proxy behavior unchanged when direct tools are disabled", () => {
    const state = stateWith(
      { mcpServers: { github: definition } },
      cacheFor({ github: { definition, tools: [{ name: "search", description: "Search repos" }] } }),
    );

    expect(decideMcpPermission(permissionEvent({ tool: "github_search", args: "{}" }), state)).toEqual({
      decision: "allow",
      reason: 'MCP tool "github_search" is allowed by policy.',
    });
  });
});

describe("MCP permission approval/execution tracking", () => {
  const definition: ServerEntry = { command: "node" };

  function dangerousState(config: Partial<McpConfig> = {}): ProxyState {
    return stateWith(
      { mcpServers: { fs: definition }, ...config },
      cacheFor({ fs: { definition, tools: [{ name: "delete_file", description: "Delete a file" }] } }),
    );
  }

  it("records approval for risky ask decisions and allows matching execution once", () => {
    const tracker = new ApprovalTracker();
    const state = dangerousState();
    const approvalEvent = permissionEvent({ tool: "fs_delete_file", args: "{}" }, { phase: "approval", toolCallId: "call-1" });
    const executionEvent = permissionEvent({ tool: "fs_delete_file", args: "{}" }, { phase: "execution", toolCallId: "call-1" });

    expect(decideMcpPermission(approvalEvent, state, { tracker })).toEqual({
      decision: "ask",
      reason: 'MCP tool "fs_delete_file" is potentially dangerous.',
    });
    expect(decideMcpPermission(executionEvent, state, { tracker })).toEqual({
      decision: "allow",
      reason: "Risky MCP call was approved before execution.",
    });
    expect(decideMcpPermission(executionEvent, state, { tracker })).toEqual({
      decision: "deny",
      reason: "Risky MCP call reached execution without a matching prior approval.",
    });
  });

  it("denies risky execution without prior matching approval", () => {
    const tracker = new ApprovalTracker();

    expect(decideMcpPermission(permissionEvent({ tool: "fs_delete_file", args: "{}" }, { phase: "execution", toolCallId: "call-2" }), dangerousState(), { tracker })).toEqual({
      decision: "deny",
      reason: "Risky MCP call reached execution without a matching prior approval.",
    });
  });

  it("denies risky execution when args change after approval", () => {
    const tracker = new ApprovalTracker();
    const state = dangerousState();

    expect(decideMcpPermission(permissionEvent({ tool: "fs_delete_file", args: JSON.stringify({ path: "a.txt" }) }, { phase: "approval", toolCallId: "call-3" }), state, { tracker })?.decision).toBe("ask");
    expect(decideMcpPermission(permissionEvent({ tool: "fs_delete_file", args: JSON.stringify({ path: "b.txt" }) }, { phase: "execution", toolCallId: "call-3" }), state, { tracker })).toEqual({
      decision: "deny",
      reason: "Risky MCP call reached execution without a matching prior approval.",
    });
  });

  it("denies in both phases when dangerousTools is deny", () => {
    const tracker = new ApprovalTracker();
    const state = dangerousState({ settings: { approval: { dangerousTools: "deny" } } });

    expect(decideMcpPermission(permissionEvent({ tool: "fs_delete_file", args: "{}" }, { phase: "approval", toolCallId: "call-4" }), state, { tracker })).toEqual({
      decision: "deny",
      reason: 'MCP tool "fs_delete_file" is potentially dangerous.',
    });
    expect(decideMcpPermission(permissionEvent({ tool: "fs_delete_file", args: "{}" }, { phase: "execution", toolCallId: "call-4" }), state, { tracker })).toEqual({
      decision: "deny",
      reason: 'MCP tool "fs_delete_file" is potentially dangerous.',
    });
  });

  it("allows benign calls in both phases without tracking", () => {
    const tracker = new ApprovalTracker();
    const state = stateWith(
      { mcpServers: { github: definition } },
      cacheFor({ github: { definition, tools: [{ name: "search", description: "Search repos" }] } }),
    );

    expect(decideMcpPermission(permissionEvent({ tool: "github_search", args: "{}" }, { phase: "approval", toolCallId: "call-5" }), state, { tracker })).toEqual({
      decision: "allow",
      reason: 'MCP tool "github_search" is allowed by policy.',
    });
    expect(decideMcpPermission(permissionEvent({ tool: "github_search", args: "{}" }, { phase: "execution", toolCallId: "call-5" }), state, { tracker })).toEqual({
      decision: "allow",
      reason: 'MCP tool "github_search" is allowed by policy.',
    });
  });
});

describe("MCP permission overlay registration", () => {
  const definition: ServerEntry = { command: "node" };
  const state = stateWith(
    { mcpServers: { github: definition } },
    cacheFor({ github: { definition, tools: [{ name: "search", description: "Search repos" }] } }),
  );

  it("does not register when permission capability is unavailable", () => {
    const register = vi.fn();

    expect(registerMcpPermissions({ letta: { capabilities: { permissions: false }, permissions: { register } } as never, runtime: fakeRuntime(state) })).toBeUndefined();
    expect(register).not.toHaveBeenCalled();
  });

  it("does not register when permissions API is missing", () => {
    expect(registerMcpPermissions({ letta: { capabilities: { permissions: true } } as never, runtime: fakeRuntime(state) })).toBeUndefined();
  });

  it("registers one permission overlay with a stable id", () => {
    const register = vi.fn<(permission: unknown) => () => void>(() => vi.fn());

    registerMcpPermissions({ letta: { capabilities: { permissions: true }, permissions: { register } } as never, runtime: fakeRuntime(state) });

    expect(register).toHaveBeenCalledTimes(1);
    expect(register.mock.calls[0]?.[0]).toMatchObject({
      id: "letta-mcp-adapter-permissions",
      description: expect.stringContaining("MCP"),
    });
  });

  it("registered check loads state for cwd without connecting or calling tools", async () => {
    const register = vi.fn<(permission: unknown) => () => void>(() => vi.fn());
    const runtime = fakeRuntime(state);

    registerMcpPermissions({ letta: { capabilities: { permissions: true }, permissions: { register } } as never, runtime });
    const check = (register.mock.calls[0]?.[0] as { check(event: LettaPermissionEvent): Promise<unknown> }).check;

    await expect(check(permissionEvent({ search: "repo" }, { cwd: "/tmp/project", workingDirectory: "/tmp/project" }))).resolves.toEqual({
      decision: "allow",
      reason: "MCP status/search/describe is read-only.",
    });
    expect(runtime.loadState).toHaveBeenCalledWith({ cwd: "/tmp/project" });
    expect(runtime.connectAndRefresh).not.toHaveBeenCalled();
    expect(runtime.callTool).not.toHaveBeenCalled();
  });

  it("denies safely when loadState fails", async () => {
    const register = vi.fn<(permission: unknown) => () => void>(() => vi.fn());
    const runtime = fakeRuntime(state);
    vi.mocked(runtime.loadState).mockImplementation(() => {
      throw new Error("bad config");
    });

    registerMcpPermissions({ letta: { capabilities: { permissions: true }, permissions: { register } } as never, runtime });
    const check = (register.mock.calls[0]?.[0] as { check(event: LettaPermissionEvent): Promise<unknown> }).check;

    await expect(check(permissionEvent({}))).resolves.toEqual({
      decision: "deny",
      reason: "MCP permission check failed: bad config",
    });
  });

  it("returns the permission disposer", () => {
    const dispose = vi.fn();
    const register = vi.fn<(permission: unknown) => () => void>(() => dispose);

    const registeredDispose = registerMcpPermissions({ letta: { capabilities: { permissions: true }, permissions: { register } } as never, runtime: fakeRuntime(state) });
    registeredDispose?.();

    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("permission check for search does not perform live MCP work", async () => {
    const register = vi.fn<(permission: unknown) => () => void>(() => vi.fn());
    const runtime = fakeRuntime(state);

    registerMcpPermissions({ letta: { capabilities: { permissions: true }, permissions: { register } } as never, runtime });
    const check = (register.mock.calls[0]?.[0] as { check(event: LettaPermissionEvent): Promise<unknown> }).check;

    await check(permissionEvent({ search: "repo" }));

    expect(runtime.connectAndRefresh).not.toHaveBeenCalled();
    expect(runtime.callTool).not.toHaveBeenCalled();
  });

  it("permission check for dangerous direct tool does not perform live MCP work", async () => {
    const serverDefinition: ServerEntry = { command: "node", directTools: true };
    const directState = stateWith(
      { mcpServers: { fs: serverDefinition } },
      cacheFor({ fs: { definition: serverDefinition, tools: [{ name: "delete_file", description: "Delete file" }] } }),
    );
    const register = vi.fn<(permission: unknown) => () => void>(() => vi.fn());
    const runtime = fakeRuntime(directState);

    registerMcpPermissions({ letta: { capabilities: { permissions: true }, permissions: { register } } as never, runtime });
    const check = (register.mock.calls[0]?.[0] as { check(event: LettaPermissionEvent): Promise<unknown> }).check;

    await expect(check(permissionEvent({ path: "README.md" }, { toolName: "fs_delete_file" }))).resolves.toEqual({
      decision: "ask",
      reason: 'MCP direct tool "fs_delete_file" is potentially dangerous.',
    });
    expect(runtime.connectAndRefresh).not.toHaveBeenCalled();
    expect(runtime.callTool).not.toHaveBeenCalled();
  });

  it("permission check for OAuth action does not start OAuth or call runtime live methods", async () => {
    const oauthState = stateWith({ mcpServers: { github: { url: "https://mcp.example.test", auth: "oauth" } } });
    const register = vi.fn<(permission: unknown) => () => void>(() => vi.fn());
    const runtime = fakeRuntime(oauthState);

    registerMcpPermissions({ letta: { capabilities: { permissions: true }, permissions: { register } } as never, runtime });
    const check = (register.mock.calls[0]?.[0] as { check(event: LettaPermissionEvent): Promise<unknown> }).check;

    await expect(check(permissionEvent({ action: "auth-start", server: "github" }))).resolves.toEqual({
      decision: "ask",
      reason: 'MCP OAuth action "auth-start" may change authentication state.',
    });
    expect(runtime.connectAndRefresh).not.toHaveBeenCalled();
    expect(runtime.callTool).not.toHaveBeenCalled();
  });

  it("permission check for HTTP server does not fetch or connect", async () => {
    const httpDefinition: ServerEntry = { url: "https://mcp.example.test" };
    const httpState = stateWith(
      { mcpServers: { remote: httpDefinition } },
      cacheFor({ remote: { definition: httpDefinition, tools: [{ name: "search", description: "Search remote" }] } }),
    );
    const register = vi.fn<(permission: unknown) => () => void>(() => vi.fn());
    const runtime = fakeRuntime(httpState);
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    try {
      registerMcpPermissions({ letta: { capabilities: { permissions: true }, permissions: { register } } as never, runtime });
      const check = (register.mock.calls[0]?.[0] as { check(event: LettaPermissionEvent): Promise<unknown> }).check;

      await expect(check(permissionEvent({ tool: "remote_search", args: "{}" }))).resolves.toEqual({
        decision: "allow",
        reason: 'MCP tool "remote_search" is allowed by policy.',
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(runtime.connectAndRefresh).not.toHaveBeenCalled();
      expect(runtime.callTool).not.toHaveBeenCalled();
    } finally {
      vi.stubGlobal("fetch", originalFetch);
    }
  });
});
