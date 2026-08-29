import { homedir } from "node:os";
import {
  isInputRequiredResult,
  MissingRequiredClientCapabilityError,
  ProtocolError,
  ProtocolErrorCode,
  SdkError,
  SdkErrorCode,
  type InputRequiredResult,
  type PriorDiscovery,
  type Tool,
} from "@modelcontextprotocol/client";
import {
  emptyMetadataCache,
  getMetadataCachePath,
  getServerCacheEntry,
  invalidateServerCache,
  isServerCacheValid,
  loadMetadataCache,
  saveMetadataCache,
  updateServerCache,
  updateServerProtocolCache,
  type CachedResource,
  type CachedTool,
  type MetadataCache,
  type ServerCacheEntry,
} from "./core/cache.js";
import { guardMcpOutput } from "./core/output-guard.js";
import { renderCallToolResult, renderReadResourceResult } from "./core/result-renderer.js";
import { loadMcpConfig, type McpConfig, type ServerEntry } from "./core/config.js";
import { createProxyState, type ProxyState } from "./features/tool-catalog.js";
import { resolveCacheIdentityHash } from "./mcp/cache-identity.js";
import { InvalidServerConfigError, McpServerManager, UnsupportedTransportError } from "./mcp/manager.js";
import { discoverServerMetadata, mergeCachePolicies, readCachePolicy } from "./mcp/metadata.js";
import { inferServerHint, resolveToolTarget, type ToolTarget } from "./mcp/calls.js";

export interface RuntimeToolContext {
  cwd: string;
  serverName?: string;
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

export interface RuntimeCallOptions {
  maxOutput?: number;
}

export type CallToolResult =
  | { ok: true; target: ToolTarget; output: string; isError: boolean }
  | { ok: false; message: string };

export interface AdapterRuntime {
  manager: McpServerManager;
  loadState(ctx: RuntimeToolContext): ProxyState;
  connectAndRefresh(ctx: RuntimeToolContext, serverName: string): Promise<ConnectRefreshResult>;
  callTool(ctx: RuntimeToolContext, state: ProxyState, toolName: string, args: Record<string, unknown>, options?: RuntimeCallOptions): Promise<CallToolResult>;
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

  function invalidateLiveServerCache(serverName: string, definition: ServerEntry): void {
    const cache = loadMetadataCache({ home });
    if (!cache) return;
    const identityHash = resolveCacheIdentityHash({ serverName, definition, home, env });
    const invalidated = invalidateServerCache({ cache, serverName, identityHash });
    if (invalidated !== cache) saveMetadataCache({ home, cache: invalidated });
  }

  async function connectAndRefreshServer(ctx: RuntimeToolContext, serverName: string): Promise<ConnectRefreshResult> {
    const { config, cache, warnings } = loadConfigAndCache(ctx);
    const definition = config.mcpServers[serverName];
    if (!definition) throw new ServerNotConfiguredError(`Server "${serverName}" is not configured. Use /toolbox status to list configured servers.`);

    const initialIdentityHash = resolveCacheIdentityHash({ serverName, definition, home, env });
    const cacheEntry = getServerCacheEntry(cache, serverName, initialIdentityHash);
    const prior = isServerCacheValid(cacheEntry, definition, { now: now(), home, env })
      ? toPriorDiscovery(cacheEntry)
      : undefined;
    const connection = await manager.connect(serverName, definition, {
      cwd: ctx.cwd,
      home,
      env,
      signal: ctx.signal,
      timeoutMs,
      prior,
      onToolsChanged: () => invalidateLiveServerCache(serverName, definition),
    });
    let metadata: Awaited<ReturnType<typeof discoverServerMetadata>>;
    try {
      metadata = await discoverMetadataWithRetry(connection.client, {
        signal: ctx.signal,
        timeout: timeoutMs,
        cacheMode: "refresh",
      });
    } catch (error) {
      if (isConnectionFailure(error)) await manager.close(serverName).catch(() => undefined);
      throw error;
    }
    const identityHash = resolveCacheIdentityHash({ serverName, definition, home, env });
    const protocolPolicy = connection.protocol.era === "modern"
      ? readCachePolicy(connection.protocol.discover)
      : {};
    const cachePolicy = mergeCachePolicies(metadata.cachePolicy, protocolPolicy);
    const updatedCache = updateServerCache({
      cache,
      serverName,
      definition,
      identityHash,
      tools: metadata.tools,
      resources: metadata.resources,
      ttlMs: cachePolicy.ttlMs,
      cacheScope: cachePolicy.cacheScope,
      warnings: metadata.warnings.length > 0
        ? metadata.warnings.map((warning) => `Server "${serverName}": ${warning}`)
        : undefined,
      protocol: connection.protocol,
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
    const explicitServerName = ctx.serverName;
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
    async callTool(ctx, state, toolName, args, callOptions) {
      if (ctx.signal?.aborted) return { ok: false, message: "External tool request cancelled." };

      const resolved = await resolveTargetWithLazyRefresh(ctx, state, toolName);
      if (!resolved.ok) return { ok: false, message: resolved.message };

      const target = resolved.target;
      const definition = resolved.state.config.mcpServers[target.serverName];
      if (!definition) return { ok: false, message: `Server "${target.serverName}" is not configured. Use /toolbox status to list configured servers.` };
      const guardOutput = (output: string, rawResult: unknown) => guardMcpOutput(output, rawResult, {
        home,
        serverName: target.serverName,
        toolName: target.exposedName,
        settings: resolved.state.config.settings?.outputGuard,
        maxOutput: callOptions?.maxOutput,
        now: now(),
      });

      try {
        const serverState = resolved.state.servers.get(target.serverName);
        const connection = await manager.connect(target.serverName, definition, {
          cwd: ctx.cwd,
          home,
          env,
          signal: ctx.signal,
          timeoutMs,
          prior: serverState?.cacheValid ? toPriorDiscovery(serverState.cacheEntry) : undefined,
          onToolsChanged: () => invalidateLiveServerCache(target.serverName, definition),
        });
        if (!serverState?.cacheValid || !serverState.cacheEntry?.protocol) {
          const cache = loadMetadataCache({ home }) ?? emptyMetadataCache();
          saveMetadataCache({
            home,
            cache: updateServerProtocolCache({
              cache,
              serverName: target.serverName,
              definition,
              identityHash: resolveCacheIdentityHash({
                serverName: target.serverName,
                definition,
                home,
                env,
              }),
              protocol: connection.protocol,
              now: now(),
              home,
              env,
            }),
          });
        }
        if (target.isResource && target.resourceUri) {
          const result = await connection.client.readResource({ uri: target.resourceUri }, { signal: ctx.signal, timeout: timeoutMs });
          const rendered = renderReadResourceResult(result);
          const output = [`Read resource "${target.resourceUri}" from "${target.serverName}".`, "", rendered].join("\n").trimEnd();
          return { ok: true, target, output: await guardOutput(output, result), isError: false };
        }

        let result: Awaited<ReturnType<typeof connection.client.callTool>>;
        try {
          result = await connection.client.callTool(
            { name: target.originalName, arguments: args },
            {
              allowInputRequired: true,
              signal: ctx.signal,
              timeout: timeoutMs,
              toolDefinition: toSdkToolDefinition(target),
            },
          );
        } catch (error) {
          if (isStaleCatalogError(error)) {
            await connectAndRefreshServer(ctx, target.serverName).catch(() => undefined);
          }
          throw error;
        }
        if (isInputRequiredResult(result)) {
          return {
            ok: false,
            message: formatInputRequiredMessage(target, result),
          };
        }
        const rendered = renderCallToolResult(result);
        const heading = rendered.isError
          ? `External tool "${target.exposedName}" on "${target.serverName}" returned an error.`
          : `Called "${target.exposedName}" on "${target.serverName}".`;
        const output = [heading, "", rendered.text].join("\n").trimEnd();
        return { ok: true, target, output: await guardOutput(output, result), isError: rendered.isError };
      } catch (error) {
        if (isConnectionFailure(error)) await manager.close(target.serverName).catch(() => undefined);
        if (error instanceof ServerNotConfiguredError || error instanceof UnsupportedTransportError || error instanceof InvalidServerConfigError) {
          return { ok: false, message: error.message };
        }
        if (isUnfulfillableInputRequest(error)) {
          return {
            ok: false,
            message: `External tool "${target.exposedName}" on "${target.serverName}" requires additional input, but Letta Code's public mod API does not provide an interactive input handler for a running tool call. The call was not continued, and no continuation state or unresolved result was retained.`,
          };
        }
        if (isUnsupportedTaskResult(error)) {
          return {
            ok: false,
            message: `External tool "${target.exposedName}" on "${target.serverName}" returned an asynchronous task, but this build cannot consume the server's modern Tasks extension yet. The adapter did not opt in or poll the task. Upgrade after modelcontextprotocol/typescript-sdk#2189 is implemented.`,
          };
        }
        const message = error instanceof Error ? error.message : String(error);
        const output = `Failed to call external tool "${target.exposedName}" on "${target.serverName}": ${message}`;
        return { ok: false, message: await guardOutput(output, { error: message }) };
      }
    },
    async closeAll() {
      await manager.closeAll();
    },
  };
}

function toPriorDiscovery(entry: ServerCacheEntry | undefined): PriorDiscovery | undefined {
  if (entry?.protocol?.era === "legacy") return { kind: "legacy" };
  if (entry?.protocol?.era === "modern") return { kind: "modern", discover: entry.protocol.discover };
  return undefined;
}

function toSdkToolDefinition(target: ToolTarget): Tool {
  return {
    name: target.originalName,
    title: target.metadata.title,
    description: target.metadata.description || undefined,
    inputSchema: target.metadata.inputSchema ?? { type: "object" },
    outputSchema: target.metadata.outputSchema,
    annotations: target.metadata.annotations,
    icons: target.metadata.icons,
  } as Tool;
}

function formatInputRequiredMessage(target: ToolTarget, result: InputRequiredResult): string {
  const methods = [...new Set(Object.values(result.inputRequests ?? {}).map((request) => request.method))];
  const requestSummary = methods.length > 0 ? ` (${methods.join(", ")})` : "";
  return `External tool "${target.exposedName}" on "${target.serverName}" requires additional input${requestSummary}. Letta Code's public mod API does not provide an interactive input handler for a running tool call, so the call was not continued. No continuation state or unresolved result was retained.`;
}

function isUnsupportedTaskResult(error: unknown): boolean {
  if (!(error instanceof SdkError) || error.code !== SdkErrorCode.UnsupportedResultType) return false;
  if (!isRecord(error.data)) return false;
  return error.data.resultType === "task";
}

function isUnfulfillableInputRequest(error: unknown): boolean {
  if (!(error instanceof MissingRequiredClientCapabilityError)) return false;
  const required = error.requiredCapabilities;
  return error.message.startsWith("Cannot request input ")
    || "elicitation" in required
    || "sampling" in required
    || "roots" in required;
}

async function discoverMetadataWithRetry(
  client: Parameters<typeof discoverServerMetadata>[0],
  options: Parameters<typeof discoverServerMetadata>[1],
): ReturnType<typeof discoverServerMetadata> {
  try {
    return await discoverServerMetadata(client, options);
  } catch (error) {
    if (!isConnectionFailure(error)) throw error;
    return discoverServerMetadata(client, options);
  }
}

function isConnectionFailure(error: unknown): boolean {
  if (error instanceof SdkError) {
    return error.code === SdkErrorCode.ConnectionClosed || error.code === SdkErrorCode.SendFailed;
  }
  if (error instanceof TypeError) {
    return /fetch|network|socket|connection/i.test(error.message);
  }
  return false;
}

function isStaleCatalogError(error: unknown): boolean {
  if (error instanceof ProtocolError && error.code === ProtocolErrorCode.InvalidParams) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /unknown tool|tool .+ not found/i.test(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
