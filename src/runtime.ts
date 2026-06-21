import { homedir } from "node:os";
import { emptyMetadataCache, getMetadataCachePath, loadMetadataCache, saveMetadataCache, updateServerCache, type CachedResource, type CachedTool, type MetadataCache } from "./core/cache.js";
import { parseProxyArgs } from "./core/args.js";
import { renderCallToolResult, renderReadResourceResult } from "./core/result-renderer.js";
import { loadMcpConfig, type McpConfig, type ServerEntry } from "./core/config.js";
import { createProxyState, type McpProxyArgs, type ProxyState } from "./features/proxy-tool.js";
import { InvalidServerConfigError, McpServerManager, UnsupportedTransportError } from "./mcp/manager.js";
import { discoverServerMetadata } from "./mcp/metadata.js";
import { inferServerHint, resolveToolTarget, type ToolTarget } from "./mcp/calls.js";

export interface RuntimeToolContext {
  cwd: string;
  args?: McpProxyArgs;
  signal?: AbortSignal;
}

export interface AdapterRuntimeOptions {
  home?: string;
  env?: Record<string, string | undefined>;
  now?: () => number;
  timeoutMs?: number;
  manager?: McpServerManager;
}

export interface ConnectRefreshResult {
  serverName: string;
  definition: ServerEntry;
  config: McpConfig;
  cache: MetadataCache;
  cachePath: string;
  tools: CachedTool[];
  resources: CachedResource[];
  state: ProxyState;
}

export type CallToolResult =
  | { ok: true; target: ToolTarget; output: string; isError: boolean }
  | { ok: false; message: string };

export interface AdapterRuntime {
  manager: McpServerManager;
  loadState(ctx: RuntimeToolContext): ProxyState;
  connectAndRefresh(ctx: RuntimeToolContext, serverName: string): Promise<ConnectRefreshResult>;
  callTool(ctx: RuntimeToolContext, state: ProxyState, toolName: string, rawArgs: string | undefined): Promise<CallToolResult>;
  closeAll(): Promise<void>;
}

export class ServerNotConfiguredError extends Error {}

export function createAdapterRuntime(options: AdapterRuntimeOptions = {}): AdapterRuntime {
  const home = options.home ?? homedir();
  const manager = options.manager ?? new McpServerManager();
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const now = options.now ?? Date.now;

  function loadConfigAndCache(ctx: RuntimeToolContext): { config: McpConfig; cache: MetadataCache; warnings: string[] } {
    const warnings: string[] = [];
    const loaded = loadMcpConfig({ cwd: ctx.cwd, home, env });
    warnings.push(...loaded.warnings);
    const cache = loadMetadataCache({ home, warnings }) ?? emptyMetadataCache();
    return { config: loaded.config, cache, warnings };
  }

  async function connectAndRefreshServer(ctx: RuntimeToolContext, serverName: string): Promise<ConnectRefreshResult> {
    const { config, cache, warnings } = loadConfigAndCache(ctx);
    const definition = config.mcpServers[serverName];
    if (!definition) throw new ServerNotConfiguredError(`Server "${serverName}" is not configured. Use mcp({}) to list configured servers.`);

    const connection = await manager.connect(serverName, definition, { cwd: ctx.cwd, home, env, signal: ctx.signal, timeoutMs });
    const metadata = await discoverServerMetadata(connection.client, { signal: ctx.signal, timeout: timeoutMs });
    const updatedCache = updateServerCache({
      cache,
      serverName,
      definition,
      tools: metadata.tools,
      resources: metadata.resources,
      now: now(),
      home,
      env,
    });
    saveMetadataCache({ home, cache: updatedCache });
    return {
      serverName,
      definition,
      config,
      cache: updatedCache,
      cachePath: getMetadataCachePath(home),
      tools: metadata.tools,
      resources: metadata.resources,
      state: createProxyState({ config, cache: updatedCache, warnings, home, env, now: now() }),
    };
  }

  async function resolveTargetWithLazyRefresh(ctx: RuntimeToolContext, state: ProxyState, toolName: string): Promise<{ ok: true; target: ToolTarget; state: ProxyState } | { ok: false; message: string }> {
    const explicitServerName = ctx.args?.server;
    let resolved = resolveToolTarget(state, { toolName, serverName: explicitServerName });
    if (resolved.ok) return { ok: true, target: resolved.target, state };
    if (resolved.kind === "unknown_server" || resolved.kind === "ambiguous_tool" || resolved.kind === "invalid_tool") return { ok: false, message: resolved.message };

    let serverHint = resolved.serverHint ?? inferServerHint(state, toolName, explicitServerName);
    if (!serverHint && state.servers.size === 1) serverHint = [...state.servers.keys()][0];
    if (!serverHint) return { ok: false, message: resolved.message };

    try {
      const refreshed = await connectAndRefreshServer(ctx, serverHint);
      resolved = resolveToolTarget(refreshed.state, { toolName, serverName: explicitServerName });
      if (resolved.ok) return { ok: true, target: resolved.target, state: refreshed.state };
      return { ok: false, message: resolved.message };
    } catch (error) {
      if (error instanceof ServerNotConfiguredError || error instanceof UnsupportedTransportError || error instanceof InvalidServerConfigError) {
        return { ok: false, message: error.message };
      }
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  return {
    manager,
    loadState(ctx) {
      const { config, cache, warnings } = loadConfigAndCache(ctx);
      return createProxyState({ config, cache, warnings, home, env, now: now() });
    },
    async connectAndRefresh(ctx, serverName) {
      return connectAndRefreshServer(ctx, serverName);
    },
    async callTool(ctx, state, toolName, rawArgs) {
      if (ctx.signal?.aborted) return { ok: false, message: "MCP request cancelled." };
      const parsedArgs = parseProxyArgs(rawArgs, toolName);
      if (!parsedArgs.ok) return { ok: false, message: parsedArgs.message };

      const resolved = await resolveTargetWithLazyRefresh(ctx, state, toolName);
      if (!resolved.ok) return { ok: false, message: resolved.message };

      const target = resolved.target;
      const definition = resolved.state.config.mcpServers[target.serverName];
      if (!definition) return { ok: false, message: `Server "${target.serverName}" is not configured. Use mcp({}) to list configured servers.` };

      try {
        const connection = await manager.connect(target.serverName, definition, { cwd: ctx.cwd, home, env, signal: ctx.signal, timeoutMs });
        if (target.isResource && target.resourceUri) {
          const result = await connection.client.readResource({ uri: target.resourceUri }, { signal: ctx.signal, timeout: timeoutMs });
          return { ok: true, target, output: renderReadResourceResult(result), isError: false };
        }

        const result = await connection.client.callTool(
          { name: target.originalName, arguments: parsedArgs.value },
          undefined,
          { signal: ctx.signal, timeout: timeoutMs },
        );
        const rendered = renderCallToolResult(result);
        return { ok: true, target, output: rendered.text, isError: rendered.isError };
      } catch (error) {
        if (error instanceof ServerNotConfiguredError || error instanceof UnsupportedTransportError || error instanceof InvalidServerConfigError) {
          return { ok: false, message: error.message };
        }
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, message: `Failed to call MCP tool "${target.exposedName}" on "${target.serverName}": ${message}` };
      }
    },
    async closeAll() {
      await manager.closeAll();
    },
  };
}
