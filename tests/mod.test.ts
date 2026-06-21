import { describe, expect, it, vi } from "vitest";
import activate, { createMcpTool, type LettaModApi } from "../src/mod.js";
import { createProxyState } from "../src/features/proxy-tool.js";
import type { AdapterRuntime } from "../src/runtime.js";
import { computeServerHash, type MetadataCache } from "../src/core/cache.js";
import type { ServerEntry } from "../src/core/config.js";

function createFakeLetta(capabilities: { tools?: boolean; commands?: boolean; permissions?: boolean } = { tools: true, commands: false }) {
  const registeredTools: unknown[] = [];
  const registeredCommands: unknown[] = [];
  const registeredPermissions: unknown[] = [];
  const disposeCalls: string[] = [];
  const toolDisposer = vi.fn(() => disposeCalls.push("tool"));
  const commandDisposer = vi.fn(() => disposeCalls.push("command"));
  const permissionDisposer = vi.fn(() => disposeCalls.push("permission"));
  const letta = {
    capabilities,
    tools: {
      register(tool: unknown) {
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
    diagnostics: { report: vi.fn() },
  } satisfies LettaModApi & { registeredTools?: unknown[] };

  return { letta, registeredTools, registeredCommands, registeredPermissions, toolDisposer, commandDisposer, permissionDisposer, disposeCalls };
}

function createFakeRuntime(state = createProxyState({ config: { mcpServers: {} }, warnings: [] })): AdapterRuntime {
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
    version: 1,
    servers: {
      fixture: {
        configHash: computeServerHash(definition),
        cachedAt: 1_000,
        tools: [{ name: "echo", description: "Echo text", inputSchema: { type: "object" } }],
        resources: [],
      },
    },
  };
  return createProxyState({ config: { mcpServers: { fixture: definition } }, cache, now: 1_000 });
}

describe("Letta mod registration", () => {
  it("does not register tool when capabilities.tools is false", () => {
    const { letta, registeredTools } = createFakeLetta({ tools: false, commands: false });
    const runtime = createFakeRuntime();

    const dispose = activate(letta, runtime);

    expect(registeredTools).toHaveLength(0);
    expect(typeof dispose).toBe("function");
  });

  it("does not register command when capabilities.commands is false", () => {
    const { letta, registeredCommands } = createFakeLetta({ tools: false, commands: false });

    activate(letta, createFakeRuntime());

    expect(registeredCommands).toHaveLength(0);
  });

  it("registers exactly one tool named mcp when direct tools are not configured", () => {
    const { letta, registeredTools } = createFakeLetta({ tools: true, commands: false });

    activate(letta, createFakeRuntime());

    expect(registeredTools).toHaveLength(1);
    expect(registeredTools[0]).toMatchObject({ name: "mcp" });
  });

  it("does not register permissions when capabilities.permissions is false", () => {
    const { letta, registeredPermissions } = createFakeLetta({ tools: true, commands: true, permissions: false });

    activate(letta, createFakeRuntime());

    expect(registeredPermissions).toHaveLength(0);
  });

  it("registers permissions when the capability and API are available", () => {
    const { letta, registeredPermissions } = createFakeLetta({ tools: false, commands: false, permissions: true });

    activate(letta, createFakeRuntime());

    expect(registeredPermissions).toHaveLength(1);
    expect(registeredPermissions[0]).toMatchObject({ id: "letta-mcp-adapter-permissions" });
  });

  it("registers exactly one command id mcp when commands are available", () => {
    const { letta, registeredCommands } = createFakeLetta({ tools: false, commands: true });

    activate(letta, createFakeRuntime());

    expect(registeredCommands).toHaveLength(1);
    expect(registeredCommands[0]).toMatchObject({ id: "mcp" });
  });

  it("registers both tool and command in the same activation", () => {
    const { letta, registeredTools, registeredCommands } = createFakeLetta({ tools: true, commands: true });

    activate(letta, createFakeRuntime());

    expect(registeredTools).toHaveLength(1);
    expect(registeredCommands).toHaveLength(1);
  });

  it("registers cache-backed direct tools after the compact proxy tool using activation cwd", () => {
    const { letta, registeredTools } = createFakeLetta({ tools: true, commands: false });
    const runtime = createFakeRuntime(directState());

    activate(letta, runtime, { activationCwd: "/tmp/activation" });

    expect(runtime.loadState).toHaveBeenCalledWith({ cwd: "/tmp/activation" });
    expect(registeredTools).toHaveLength(2);
    expect(registeredTools[0]).toMatchObject({ name: "mcp" });
    expect(registeredTools[1]).toMatchObject({ name: "fixture_echo" });
  });

  it("tool description explains when to use it", () => {
    const tool = createMcpTool(createFakeRuntime());

    expect(tool.description).toContain("MCP");
    expect(tool.description).toContain("OAuth");
    expect(tool.description).toContain("search");
    expect(tool.description).toContain("connect");
    expect(tool.description).toContain("JSON-string args");
  });

  it("tool parameters are an object schema with additionalProperties false", () => {
    const tool = createMcpTool(createFakeRuntime());

    expect(tool.parameters).toMatchObject({ type: "object", additionalProperties: false });
  });

  it("registered tool exposes OAuth action parameters", () => {
    const tool = createMcpTool(createFakeRuntime());

    expect(tool.parameters).toMatchObject({
      properties: {
        action: { description: expect.stringContaining("auth-start") },
        server: { type: "string" },
        args: { type: "string" },
      },
    });
  });

  it("tool requires approval and is not parallel-safe", () => {
    const tool = createMcpTool(createFakeRuntime());

    expect(tool.requiresApproval).toBe(true);
    expect(tool.parallelSafe).toBe(false);
  });

  it("command registration does not add approval fields, permission overlays, or UI dependencies", () => {
    const { letta, registeredCommands } = createFakeLetta({ tools: false, commands: true });

    activate(letta, createFakeRuntime());

    expect(registeredCommands[0]).not.toHaveProperty("requiresApproval");
    expect(registeredCommands[0]).not.toHaveProperty("parallelSafe");
    expect(registeredCommands[0]).not.toHaveProperty("runWhenBusy");
  });

  it("returned disposer calls registered disposers in reverse order and closes runtime once", async () => {
    const { letta, toolDisposer, commandDisposer, permissionDisposer, disposeCalls } = createFakeLetta({ tools: true, commands: true, permissions: true });
    const runtime = createFakeRuntime();
    const dispose = activate(letta, runtime);

    await dispose?.();

    expect(commandDisposer).toHaveBeenCalledTimes(1);
    expect(toolDisposer).toHaveBeenCalledTimes(1);
    expect(permissionDisposer).toHaveBeenCalledTimes(1);
    expect(disposeCalls).toEqual(["command", "tool", "permission"]);
    expect(runtime.closeAll).toHaveBeenCalledTimes(1);
  });

  it("activation may read cache-backed state for direct tools but does not connect or call tools", () => {
    const { letta } = createFakeLetta({ tools: true, commands: true, permissions: true });
    const runtime = createFakeRuntime();

    activate(letta, runtime, { activationCwd: "/tmp/activation" });

    expect(runtime.loadState).toHaveBeenCalledWith({ cwd: "/tmp/activation" });
    expect(runtime.connectAndRefresh).not.toHaveBeenCalled();
    expect(runtime.callTool).not.toHaveBeenCalled();
  });

  it("registers permissions alongside proxy, direct tools, and command according to guards", () => {
    const { letta, registeredTools, registeredCommands, registeredPermissions } = createFakeLetta({ tools: true, commands: true, permissions: true });
    const runtime = createFakeRuntime(directState());

    activate(letta, runtime, { activationCwd: "/tmp/activation" });

    expect(registeredPermissions).toHaveLength(1);
    expect(registeredTools.map((tool) => (tool as { name: string }).name)).toEqual(["mcp", "fixture_echo"]);
    expect(registeredCommands).toHaveLength(1);
  });

  it("command metadata documents OAuth aliases without invoking runtime", () => {
    const { letta, registeredCommands } = createFakeLetta({ tools: false, commands: true });
    const runtime = createFakeRuntime();

    activate(letta, runtime);

    expect(registeredCommands[0]).toMatchObject({
      description: expect.stringContaining("OAuth"),
      args: expect.stringContaining("auth-start <server>"),
    });
    expect(runtime.loadState).not.toHaveBeenCalled();
    expect(runtime.connectAndRefresh).not.toHaveBeenCalled();
  });

  it("tool run uses ctx.cwd, ctx.args, and ctx.signal through runtime/proxy", async () => {
    const runtime = createFakeRuntime();
    const tool = createMcpTool(runtime);
    const signal = new AbortController().signal;

    const result = await tool.run({ cwd: "/tmp/workspace", args: {}, signal });

    expect(runtime.loadState).toHaveBeenCalledWith({ cwd: "/tmp/workspace", args: {}, signal });
    expect(result).toContain("MCP: 0 configured servers");
  });
});
