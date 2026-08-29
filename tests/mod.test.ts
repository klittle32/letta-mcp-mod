import { describe, expect, it, vi } from "vitest";
import activate, {
  createCallToolTool,
  createSearchToolsTool,
  type LettaModApi,
  type LettaToolDefinition,
} from "../src/mod.js";
import { computeServerHash, type MetadataCache } from "../src/core/cache.js";
import type { ServerEntry } from "../src/core/config.js";
import { createProxyState } from "../src/features/tool-catalog.js";
import type { AdapterRuntime } from "../src/runtime.js";

function createFakeLetta(
  capabilities: { tools?: boolean; commands?: boolean; permissions?: boolean; ui?: { statusValues?: boolean } } = {
    tools: true,
    commands: false,
  },
) {
  const registeredTools: LettaToolDefinition[] = [];
  const registeredCommands: unknown[] = [];
  const registeredPermissions: unknown[] = [];
  const disposeCalls: string[] = [];
  const toolDisposer = vi.fn(() => disposeCalls.push("tool"));
  const commandDisposer = vi.fn(() => disposeCalls.push("command"));
  const permissionDisposer = vi.fn(() => disposeCalls.push("permission"));
  const letta = {
    capabilities,
    tools: {
      register(tool: LettaToolDefinition) {
        registeredTools.push(tool);
        return toolDisposer;
      },
    },
    commands: {
      register(command: unknown) {
        registeredCommands.push(command);
        return commandDisposer;
      },
    },
    permissions: {
      register(permission: unknown) {
        registeredPermissions.push(permission);
        return permissionDisposer;
      },
    },
    ui: {
      setStatus: vi.fn(),
      clearStatus: vi.fn(),
    },
    diagnostics: { report: vi.fn() },
  } satisfies LettaModApi;

  return {
    letta,
    registeredTools,
    registeredCommands,
    registeredPermissions,
    toolDisposer,
    commandDisposer,
    permissionDisposer,
    disposeCalls,
  };
}

function createFakeRuntime(
  state = createProxyState({ config: { mcpServers: {} }, warnings: [] }),
): AdapterRuntime {
  return {
    manager: { closeAll: vi.fn(), connect: vi.fn(), getConnection: vi.fn(), close: vi.fn() } as never,
    loadState: vi.fn(() => state),
    connectAndRefresh: vi.fn(),
    callTool: vi.fn(),
    closeAll: vi.fn(async () => undefined),
  };
}

function directState() {
  const definition: ServerEntry = { command: "node", directTools: true };
  const cache: MetadataCache = {
    version: 2,
    servers: {
      fixture: {
        public: {
          configHash: computeServerHash(definition),
          cachedAt: 1_000,
          cacheScope: "public",
          tools: [{ name: "echo", description: "Echo text", inputSchema: { type: "object" } }],
          resources: [],
        },
        private: {},
      },
    },
  };
  return createProxyState({ config: { mcpServers: { fixture: definition } }, cache, now: 1_000 });
}

describe("Letta mod registration", () => {
  it("registers only search_tools and call_tool when direct tools are not configured", () => {
    const { letta, registeredTools } = createFakeLetta();

    activate(letta, createFakeRuntime());

    expect(registeredTools.map((tool) => tool.name)).toEqual(["search_tools", "call_tool"]);
    expect(registeredTools.some((tool) => tool.name === "mcp")).toBe(false);
  });

  it("does not register tools when capabilities.tools is false", () => {
    const { letta, registeredTools } = createFakeLetta({ tools: false, commands: false });

    activate(letta, createFakeRuntime());

    expect(registeredTools).toHaveLength(0);
  });

  it("registers the lmcp command independently of model tools", () => {
    const { letta, registeredCommands } = createFakeLetta({ tools: false, commands: true });

    activate(letta, createFakeRuntime());

    expect(registeredCommands).toHaveLength(1);
    expect(registeredCommands[0]).toMatchObject({ id: "lmcp" });
  });

  it("registers the permission overlay when available", () => {
    const { letta, registeredPermissions } = createFakeLetta({
      tools: false,
      commands: false,
      permissions: true,
    });

    activate(letta, createFakeRuntime());

    expect(registeredPermissions).toHaveLength(1);
    expect(registeredPermissions[0]).toMatchObject({ id: "letta-mcp-adapter-permissions" });
  });

  it("registers cache-backed direct tools after both catalog tools", () => {
    const { letta, registeredTools } = createFakeLetta();
    const runtime = createFakeRuntime(directState());

    activate(letta, runtime, { activationCwd: "/tmp/activation" });

    expect(runtime.loadState).toHaveBeenCalledWith({ cwd: "/tmp/activation" });
    expect(registeredTools.map((tool) => tool.name)).toEqual([
      "search_tools",
      "call_tool",
      "fixture_echo",
    ]);
  });

  it("registers and clears MCP UI status values when available", async () => {
    const { letta } = createFakeLetta({
      tools: false,
      commands: false,
      ui: { statusValues: true },
    });

    const dispose = activate(letta, createFakeRuntime(directState()), {
      activationCwd: "/tmp/activation",
    });

    expect(letta.ui?.setStatus).toHaveBeenCalledWith("mcp", "1 server, 1 tool");
    await dispose?.();
    expect(letta.ui?.clearStatus).toHaveBeenCalledWith("mcp");
  });

  it("activation reads cached state but performs no live MCP work", () => {
    const { letta } = createFakeLetta({ tools: true, commands: true, permissions: true });
    const runtime = createFakeRuntime();

    activate(letta, runtime, { activationCwd: "/tmp/activation" });

    expect(runtime.loadState).toHaveBeenCalledWith({ cwd: "/tmp/activation" });
    expect(runtime.connectAndRefresh).not.toHaveBeenCalled();
    expect(runtime.callTool).not.toHaveBeenCalled();
  });

  it("disposes registrations in reverse order and closes the runtime", async () => {
    const { letta, toolDisposer, commandDisposer, permissionDisposer, disposeCalls } =
      createFakeLetta({ tools: true, commands: true, permissions: true });
    const runtime = createFakeRuntime();
    const dispose = activate(letta, runtime);

    await dispose?.();

    expect(commandDisposer).toHaveBeenCalledTimes(1);
    expect(toolDisposer).toHaveBeenCalledTimes(2);
    expect(permissionDisposer).toHaveBeenCalledTimes(1);
    expect(disposeCalls).toEqual(["command", "tool", "tool", "permission"]);
    expect(runtime.closeAll).toHaveBeenCalledTimes(1);
  });
});

describe("split model tool definitions", () => {
  it("search_tools has a focused query schema without management operations", () => {
    const tool = createSearchToolsTool(createFakeRuntime());

    expect(tool.name).toBe("search_tools");
    expect(tool.description).toContain("call_tool");
    expect(tool.description).not.toContain("OAuth");
    expect(tool.parameters).toMatchObject({
      type: "object",
      required: ["query"],
      additionalProperties: false,
      properties: {
        query: { type: "string" },
        limit: { type: "integer" },
      },
    });
    expect(tool.requiresApproval).toBe(false);
    expect(tool.parallelSafe).toBe(false);
  });

  it("call_tool requires an object-valued args field", () => {
    const tool = createCallToolTool(createFakeRuntime());

    expect(tool.name).toBe("call_tool");
    expect(tool.parameters).toMatchObject({
      type: "object",
      required: ["name", "args"],
      additionalProperties: false,
      properties: {
        name: { type: "string" },
        args: { type: "object", additionalProperties: true },
        maxOutput: { type: "integer", minimum: 1_000, maximum: 1_000_000 },
      },
    });
    expect(tool.requiresApproval).toBe(true);
    expect(tool.parallelSafe).toBe(false);
  });
});
