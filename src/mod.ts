import { createMcpCommand, type LettaCommandDefinition } from "./features/mcp-command.js";
import { registerCachedDirectTools } from "./features/direct-tools.js";
import { registerMcpPermissions, type LettaPermissionEvent, type PermissionCheckResult } from "./features/permissions.js";
import { executeMcpProxy, MCP_PROXY_PARAMETERS, type McpProxyArgs } from "./features/proxy-tool.js";
import { createAdapterRuntime, type AdapterRuntime } from "./runtime.js";

export interface LettaToolRunContext {
  cwd: string;
  args?: Record<string, unknown>;
  signal?: AbortSignal;
  [key: string]: unknown;
}

export interface LettaToolDefinition {
  name: string;
  description: string;
  parameters: unknown;
  requiresApproval: boolean;
  parallelSafe: boolean;
  run(ctx: LettaToolRunContext): Promise<string> | string;
}

export interface LettaModApi {
  capabilities?: {
    tools?: boolean;
    commands?: boolean;
    permissions?: boolean;
    [key: string]: unknown;
  };
  tools?: {
    register(tool: LettaToolDefinition): () => void;
  };
  commands?: {
    register(command: LettaCommandDefinition): () => void;
  };
  permissions?: {
    register(permission: {
      id: string;
      description: string;
      check(event: LettaPermissionEvent, ctx?: { signal?: AbortSignal; [key: string]: unknown }): PermissionCheckResult | undefined | Promise<PermissionCheckResult | undefined>;
    }): () => void;
  };
  diagnostics?: {
    report(message: unknown): void;
  };
  [key: string]: unknown;
}

export interface ActivateOptions {
  activationCwd?: string;
}

export function createMcpTool(runtime: AdapterRuntime = createAdapterRuntime()): LettaToolDefinition {
  return {
    name: "mcp",
    description: "Use this compact MCP proxy to connect MCP servers, manage OAuth login, refresh cached metadata, search/list/describe cached MCP tools, and call MCP tools with JSON-string args.",
    parameters: MCP_PROXY_PARAMETERS,
    requiresApproval: true,
    parallelSafe: false,
    async run(ctx) {
      if (ctx.signal?.aborted) return "MCP request cancelled.";
      const proxyArgs = (ctx.args ?? {}) as McpProxyArgs;
      const runtimeCtx = { cwd: ctx.cwd, args: proxyArgs, signal: ctx.signal };
      const state = runtime.loadState(runtimeCtx);
      return await executeMcpProxy(proxyArgs, state, runtime, runtimeCtx);
    },
  };
}

export default function activate(
  letta: LettaModApi,
  runtime: AdapterRuntime = createAdapterRuntime(),
  options: ActivateOptions = {},
): (() => Promise<void>) | undefined {
  const disposers: Array<() => void> = [];
  const activationCwd = options.activationCwd ?? process.cwd();

  const disposePermissions = registerMcpPermissions({ letta, runtime });
  if (disposePermissions) disposers.push(disposePermissions);

  if (letta.capabilities?.tools && letta.tools) {
    disposers.push(letta.tools.register(createMcpTool(runtime)));
    disposers.push(...registerCachedDirectTools({ letta, runtime, activationCwd }));
  }

  if (letta.capabilities?.commands && letta.commands) {
    disposers.push(letta.commands.register(createMcpCommand(runtime)));
  }

  return async () => {
    for (const dispose of disposers.reverse()) {
      dispose();
    }
    await runtime.closeAll();
  };
}
