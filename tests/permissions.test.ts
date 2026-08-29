import { describe, expect, it, vi } from "vitest";
import { computeServerHash, type MetadataCache } from "../src/core/cache.js";
import type { McpConfig, McpSettings, ServerEntry } from "../src/core/config.js";
import { createProxyState, type ProxyState } from "../src/features/tool-catalog.js";
import {
  ApprovalTracker,
  decideMcpPermission,
  hasPathOutsideWorkingDirectory,
  normalizeApprovalSettings,
  registerMcpPermissions,
  type LettaPermissionEvent,
} from "../src/features/permissions.js";
import type { AdapterRuntime } from "../src/runtime.js";

function cacheFor(
  entries: Record<string, {
    definition: ServerEntry;
    tools?: Array<{ name: string; description?: string }>;
  }>,
): MetadataCache {
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
  return createProxyState({
    config,
    cache: cache ?? { version: 1, servers: {} },
    now: 1_000,
  });
}

function permissionEvent(
  toolName: string,
  args: Record<string, unknown>,
  overrides: Partial<LettaPermissionEvent> = {},
): LettaPermissionEvent {
  return {
    agentId: "agent-test",
    conversationId: "conv-test",
    toolCallId: "call-test",
    toolName,
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

describe("MCP permission settings", () => {
  it("uses safe defaults", () => {
    expect(normalizeApprovalSettings(undefined)).toEqual({
      approval: {
        dangerousTools: "ask",
        unknownServers: "deny",
        configWrites: "alwaysAsk",
      },
      warnings: [],
    });
  });

  it("preserves valid decisions", () => {
    expect(normalizeApprovalSettings({
      dangerousTools: "alwaysAsk",
      unknownServers: "ask",
      configWrites: "allow",
    })).toEqual({
      approval: {
        dangerousTools: "alwaysAsk",
        unknownServers: "ask",
        configWrites: "allow",
      },
      warnings: [],
    });
  });

  it("falls back for invalid decisions", () => {
    const result = normalizeApprovalSettings({
      dangerousTools: "maybe",
      unknownServers: false,
      configWrites: "deny",
    });

    expect(result.approval).toEqual({
      dangerousTools: "ask",
      unknownServers: "deny",
      configWrites: "deny",
    });
    expect(result.warnings).toHaveLength(2);
  });

  it("keeps approval settings typed", () => {
    const settings: McpSettings = {
      approval: { dangerousTools: "deny", unknownServers: "allow", configWrites: "alwaysAsk" },
    };
    expect(settings.approval?.dangerousTools).toBe("deny");
  });
});

describe("split model-tool permission decisions", () => {
  const definition: ServerEntry = { command: "node" };
  const state = stateWith(
    { mcpServers: { github: definition } },
    cacheFor({
      github: {
        definition,
        tools: [
          { name: "search", description: "Search repos" },
          { name: "delete_repo", description: "Delete a repo" },
        ],
      },
    }),
  );

  it("allows search_tools discovery", () => {
    expect(decideMcpPermission(permissionEvent("search_tools", { query: "repo" }), state)).toEqual({
      decision: "allow",
      reason: "External tool discovery is allowed.",
    });
  });

  it("allows a benign cached call", () => {
    expect(decideMcpPermission(permissionEvent("call_tool", {
      name: "github_search",
      args: { query: "adapter" },
    }), state)).toEqual({
      decision: "allow",
      reason: 'MCP tool "github_search" is allowed by policy.',
    });
  });

  it("asks for dangerous cached calls", () => {
    expect(decideMcpPermission(permissionEvent("call_tool", {
      name: "github_delete_repo",
      args: { name: "old" },
    }), state)).toMatchObject({
      decision: "ask",
      reason: expect.stringContaining("potentially dangerous"),
    });
  });

  it("honors the configured dangerous-tool decision", () => {
    const denied = stateWith(
      {
        mcpServers: { github: definition },
        settings: { approval: { dangerousTools: "deny" } },
      },
      cacheFor({ github: { definition, tools: [{ name: "delete_repo" }] } }),
    );

    expect(decideMcpPermission(permissionEvent("call_tool", {
      name: "github_delete_repo",
      args: {},
    }), denied)?.decision).toBe("deny");
  });

  it("asks for paths outside the working directory", () => {
    expect(decideMcpPermission(permissionEvent("call_tool", {
      name: "github_search",
      args: { path: "/etc/passwd" },
    }), state)).toMatchObject({
      decision: "ask",
      reason: expect.stringContaining("outside the working directory"),
    });
  });

  it("denies a missing call name", () => {
    expect(decideMcpPermission(permissionEvent("call_tool", { args: {} }), state)).toMatchObject({
      decision: "deny",
      reason: expect.stringContaining("requires a tool name"),
    });
  });

  it("asks before an uncached call attributable to one configured server", () => {
    const uncached = stateWith({ mcpServers: { github: definition } });

    expect(decideMcpPermission(permissionEvent("call_tool", {
      name: "github_search",
      args: { query: "adapter" },
    }), uncached)).toMatchObject({
      decision: "ask",
      reason: expect.stringContaining("metadata refresh"),
    });
  });

  it("denies an unknown call that cannot be attributed safely", () => {
    const uncached = stateWith({
      mcpServers: { github: definition, gitlab: definition },
    });

    expect(decideMcpPermission(permissionEvent("call_tool", {
      name: "missing",
      args: {},
    }), uncached)?.decision).toBe("deny");
  });

  it("returns no opinion for unrelated tools", () => {
    expect(decideMcpPermission(permissionEvent("read_file", { path: "README.md" }), state)).toBeUndefined();
  });
});

describe("direct-tool permission decisions", () => {
  it("preserves direct-tool policy", () => {
    const definition: ServerEntry = { command: "node", directTools: true };
    const state = stateWith(
      { mcpServers: { fixture: definition } },
      cacheFor({ fixture: { definition, tools: [{ name: "search" }, { name: "delete_all" }] } }),
    );

    expect(decideMcpPermission(permissionEvent("fixture_search", { query: "x" }), state)?.decision).toBe("allow");
    expect(decideMcpPermission(permissionEvent("fixture_delete_all", {}), state)?.decision).toBe("ask");
  });
});

describe("permission approval tracking", () => {
  it("allows matching approved execution once", () => {
    const definition: ServerEntry = { command: "node" };
    const state = stateWith(
      { mcpServers: { fixture: definition } },
      cacheFor({ fixture: { definition, tools: [{ name: "delete_all" }] } }),
    );
    const tracker = new ApprovalTracker();
    const approval = permissionEvent("call_tool", {
      name: "fixture_delete_all",
      args: { target: "one" },
    });
    const execution = { ...approval, phase: "execution" as const };

    expect(decideMcpPermission(approval, state, { tracker })?.decision).toBe("ask");
    expect(decideMcpPermission(execution, state, { tracker })?.decision).toBe("allow");
    expect(decideMcpPermission(execution, state, { tracker })?.decision).toBe("deny");
  });

  it("denies execution when arguments changed after approval", () => {
    const definition: ServerEntry = { command: "node" };
    const state = stateWith(
      { mcpServers: { fixture: definition } },
      cacheFor({ fixture: { definition, tools: [{ name: "delete_all" }] } }),
    );
    const tracker = new ApprovalTracker();
    const approval = permissionEvent("call_tool", {
      name: "fixture_delete_all",
      args: { target: "one" },
    });
    const execution = permissionEvent(
      "call_tool",
      { name: "fixture_delete_all", args: { target: "two" } },
      { phase: "execution" },
    );

    decideMcpPermission(approval, state, { tracker });
    expect(decideMcpPermission(execution, state, { tracker })?.decision).toBe("deny");
  });
});

describe("path inspection", () => {
  it("distinguishes paths inside and outside cwd", () => {
    expect(hasPathOutsideWorkingDirectory({ path: "src/mod.ts" }, "/tmp/workspace")).toBe(false);
    expect(hasPathOutsideWorkingDirectory({ path: "/etc/passwd" }, "/tmp/workspace")).toBe(true);
    expect(hasPathOutsideWorkingDirectory({ url: "https://example.com" }, "/tmp/workspace")).toBe(false);
  });
});

describe("permission overlay registration", () => {
  const state = stateWith({ mcpServers: {} });

  it("does not register without permission capability", () => {
    const runtime = fakeRuntime(state);
    expect(registerMcpPermissions({ letta: { capabilities: { permissions: false } }, runtime })).toBeUndefined();
  });

  it("registers a stable side-effect-free overlay", async () => {
    let check: ((event: LettaPermissionEvent) => unknown) | undefined;
    const disposer = vi.fn();
    const runtime = fakeRuntime(state);
    const letta = {
      capabilities: { permissions: true },
      permissions: {
        register: vi.fn((definition: { check(event: LettaPermissionEvent): unknown }) => {
          check = definition.check;
          return disposer;
        }),
      },
    };

    expect(registerMcpPermissions({ letta, runtime })).toBe(disposer);
    expect(letta.permissions.register).toHaveBeenCalledWith(expect.objectContaining({
      id: "letta-mcp-adapter-permissions",
    }));

    await check?.(permissionEvent("search_tools", { query: "echo" }));
    expect(runtime.loadState).toHaveBeenCalledWith({ cwd: "/tmp/workspace" });
    expect(runtime.connectAndRefresh).not.toHaveBeenCalled();
    expect(runtime.callTool).not.toHaveBeenCalled();
  });

  it("fails closed when state loading fails", async () => {
    let check: ((event: LettaPermissionEvent) => unknown) | undefined;
    const runtime = {
      ...fakeRuntime(state),
      loadState: vi.fn(() => {
        throw new Error("broken state");
      }),
    };
    const letta = {
      capabilities: { permissions: true },
      permissions: {
        register(definition: { check(event: LettaPermissionEvent): unknown }) {
          check = definition.check;
          return vi.fn();
        },
      },
    };
    registerMcpPermissions({ letta, runtime });

    await expect(check?.(permissionEvent("call_tool", {
      name: "fixture_echo",
      args: {},
    }))).resolves.toMatchObject({
      decision: "deny",
      reason: expect.stringContaining("broken state"),
    });
  });
});
