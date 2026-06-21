import { homedir } from "node:os";
import type { AdapterRuntime, CallToolResult, RuntimeToolContext } from "../runtime.js";
import { ServerNotConfiguredError } from "../runtime.js";
import { InvalidServerConfigError, UnsupportedTransportError } from "../mcp/manager.js";
import { emptyMetadataCache, isServerCacheValid, loadMetadataCache, reconstructToolMetadata, type MetadataCache, type ServerCacheEntry } from "../core/cache.js";
import { loadMcpConfig, type LoadedMcpConfig, type McpConfig, type ServerEntry } from "../core/config.js";
import { formatSchema } from "../core/schema-format.js";
import { findToolByName, formatToolName, resourceNameToToolName, type ToolMetadata, type ToolPrefixMode } from "../core/tool-names.js";
import { executeOAuthAction, type OAuthAction } from "./oauth-actions.js";

export interface McpProxyArgs {
  tool?: string;
  args?: string;
  connect?: string;
  describe?: string;
  search?: string;
  regex?: boolean;
  includeSchemas?: boolean;
  server?: string;
  action?: string;
}

export interface ProxyServerState {
  name: string;
  definition: ServerEntry;
  cacheEntry?: ServerCacheEntry;
  cacheValid: boolean;
  tools: ToolMetadata[];
}

export interface ProxyState {
  config: McpConfig;
  warnings: string[];
  prefix: ToolPrefixMode;
  servers: Map<string, ProxyServerState>;
  home?: string;
  env?: Record<string, string | undefined>;
}

export interface CreateProxyStateOptions {
  config: McpConfig;
  cache?: MetadataCache;
  warnings?: string[];
  now?: number;
  home?: string;
  env?: Record<string, string | undefined>;
}

export const MCP_PROXY_PARAMETERS = {
  type: "object",
  properties: {
    tool: {
      type: "string",
      description: "Tool name to call, e.g. filesystem_read_file.",
    },
    args: {
      type: "string",
      description: "Arguments as JSON string, e.g. '{\"path\":\"README.md\"}'.",
    },
    connect: {
      type: "string",
      description: "Server name to connect and refresh cached metadata.",
    },
    describe: {
      type: "string",
      description: "Tool name to describe from cached metadata.",
    },
    search: {
      type: "string",
      description: "Search cached MCP tools by name or description.",
    },
    regex: {
      type: "boolean",
      description: "Treat search as a regex. Regex search is deferred in this slice.",
    },
    includeSchemas: {
      type: "boolean",
      description: "Include parameter schemas in search results. Defaults to true.",
    },
    server: {
      type: "string",
      description: "Filter to or list tools from a specific server.",
    },
    action: {
      type: "string",
      description: "Supported actions: auth-start, auth-complete, auth-status. Other actions are unsupported.",
    },
  },
  additionalProperties: false,
} as const;

export function createProxyState(options: CreateProxyStateOptions): ProxyState {
  const config = options.config;
  const cache = options.cache ?? emptyMetadataCache();
  const prefix = config.settings?.toolPrefix ?? "server";
  const servers = new Map<string, ProxyServerState>();

  for (const [name, definition] of Object.entries(config.mcpServers ?? {})) {
    const cacheEntry = cache.servers[name];
    const cacheValid = isServerCacheValid(cacheEntry, definition, {
      now: options.now,
      home: options.home,
      env: options.env,
    });
    const tools = cacheEntry && cacheValid ? reconstructToolMetadata(name, cacheEntry, prefix, definition) : [];
    servers.set(name, { name, definition, cacheEntry, cacheValid, tools });
  }

  return { config, warnings: options.warnings ?? [], prefix, servers, home: options.home, env: options.env };
}

export function loadInvocationProxyState(ctx: { cwd: string }): ProxyState {
  const warnings: string[] = [];
  const loaded: LoadedMcpConfig = loadMcpConfig({ cwd: ctx.cwd, home: homedir() });
  warnings.push(...loaded.warnings);
  const cache = loadMetadataCache({ home: homedir(), warnings }) ?? emptyMetadataCache();
  return createProxyState({ config: loaded.config, cache, warnings });
}

export function executeMcpProxy(args: McpProxyArgs, state: ProxyState): string;
export function executeMcpProxy(args: McpProxyArgs, state: ProxyState, runtime: AdapterRuntime, ctx: RuntimeToolContext): Promise<string>;
export function executeMcpProxy(args: McpProxyArgs, state: ProxyState, runtime?: AdapterRuntime, ctx?: RuntimeToolContext): string | Promise<string> {
  if (args.action) {
    if (isOAuthAction(args.action)) {
      if (!runtime || !ctx) return `MCP OAuth action "${args.action}" requires the adapter runtime.`;
      return executeOAuthAction({ action: args.action, serverName: args.server, rawArgs: args.args, runtime, ctx, state });
    }
    return executeUnsupportedAction(args.action);
  }
  if (args.tool) {
    if (!runtime || !ctx) return executeToolCallUnavailable(args.tool);
    return executeToolCall(runtime, ctx, args.tool, args.args);
  }
  if (args.connect) {
    if (!runtime || !ctx) return executeConnectUnavailable(args.connect);
    return executeConnect(runtime, ctx, state, args.connect);
  }
  if (args.describe) return executeDescribe(state, args.describe);
  if (args.search !== undefined) return executeSearch(state, args.search, args);
  if (args.server) return executeListServer(state, args.server);
  return executeStatus(state);
}

export function executeStatus(state: ProxyState): string {
  const configured = state.servers.size;
  const cachedTools = [...state.servers.values()].reduce((count, server) => count + server.tools.length, 0);
  const lines = [`MCP: ${configured} configured servers, ${cachedTools} cached ${plural(cachedTools, "tool")}.`];

  if (state.warnings.length > 0) {
    lines.push("", "Warnings:", ...state.warnings.map((warning) => `- ${warning}`));
  }

  if (configured === 0) {
    lines.push("", "No MCP servers configured.", "Create a .mcp.json in this workspace or configure ~/.config/mcp/mcp.json.");
    return lines.join("\n");
  }

  lines.push("");
  for (const server of state.servers.values()) {
    if (!server.cacheEntry) {
      lines.push(`- ${server.name} (configured, no cache)`);
    } else if (!server.cacheValid) {
      lines.push(`- ${server.name} (configured, stale cache)`);
    } else {
      lines.push(`- ${server.name} (${server.tools.length} cached ${plural(server.tools.length, "tool")})`);
    }
  }
  lines.push("", 'Use mcp({ connect: "server" }) to connect and refresh cached metadata.');
  return lines.join("\n");
}

export function executeListServer(state: ProxyState, serverName: string): string {
  const server = state.servers.get(serverName);
  if (!server) return `Server "${serverName}" is not configured. Use mcp({}) to list configured servers.`;
  if (!server.cacheEntry) return `Server "${serverName}" is configured but has no metadata cache. Use mcp({ connect: "server" }) to create metadata cache first.`;
  if (!server.cacheValid) return `Server "${serverName}" has a stale metadata cache. Use mcp({ connect: "server" }) to create metadata cache first.`;
  if (server.tools.length === 0) return `${serverName} (0 cached tools).`;

  return [`${serverName} (${server.tools.length} cached ${plural(server.tools.length, "tool")}):`, "", ...server.tools.map(formatToolListItem)].join("\n");
}

export function executeSearch(state: ProxyState, rawQuery: string, args: Pick<McpProxyArgs, "server" | "regex" | "includeSchemas"> = {}): string {
  const query = rawQuery.trim();
  if (!query) return "MCP search query is required.";
  if (args.regex) return "Regex search is not implemented in Slice 1. Use a plain text query.";

  const servers = args.server ? [state.servers.get(args.server)] : [...state.servers.values()];
  if (args.server && !servers[0]) return `Server "${args.server}" is not configured. Use mcp({}) to list configured servers.`;

  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches: Array<{ server: ProxyServerState; tool: ToolMetadata }> = [];
  for (const server of servers) {
    if (!server) continue;
    for (const tool of server.tools) {
      const haystack = `${tool.name} ${tool.description}`.toLowerCase();
      if (terms.some((term) => haystack.includes(term))) matches.push({ server, tool });
    }
  }

  if (matches.length === 0) return `No cached MCP tools matched "${query}".`;

  const includeSchemas = args.includeSchemas !== false;
  const lines = [`${matches.length} cached MCP ${plural(matches.length, "tool")} matched "${query}":`];
  for (const match of matches) {
    lines.push("", `${match.tool.name} (${match.server.name})`, `  ${match.tool.description || "(no description)"}`);
    if (includeSchemas) lines.push("  Parameters:", formatSchema(match.tool.inputSchema, "    "));
  }
  return lines.join("\n");
}

export function executeDescribe(state: ProxyState, requestedName: string): string {
  for (const server of state.servers.values()) {
    const tool = findToolByName(server.tools, requestedName);
    if (!tool) continue;

    const lines = [
      `Tool: ${tool.name}`,
      `Server: ${server.name}`,
      `Original name: ${tool.originalName}`,
      `Description: ${tool.description || "(no description)"}`,
    ];
    if (tool.resourceUri) lines.push(`Resource URI: ${tool.resourceUri}`);
    lines.push("Parameters:", formatSchema(tool.inputSchema, "  "));
    return lines.join("\n");
  }
  return `Tool "${requestedName}" not found in cached metadata. Use mcp({ search: "${requestedName}" }) to search cached tools.`;
}

function executeUnsupportedAction(action: string): string {
  return `Unsupported MCP action "${action}". Supported actions: auth-start, auth-complete, auth-status. This adapter also supports MCP tool calls plus connect, status, server listing from cache, search, and describe.`;
}

function isOAuthAction(action: string): action is OAuthAction {
  return action === "auth-start" || action === "auth-complete" || action === "auth-status" || action === "auth-clear";
}

async function executeToolCall(runtime: AdapterRuntime, ctx: RuntimeToolContext, toolName: string, rawArgs: string | undefined): Promise<string> {
  const result = await runtime.callTool(ctx, runtime.loadState(ctx), toolName, rawArgs);
  return formatRuntimeCallToolResult(result);
}

export function formatRuntimeCallToolResult(result: CallToolResult): string {
  if (!result.ok) return result.message;
  if (result.target.isResource && result.target.resourceUri) {
    return [`Read resource "${result.target.resourceUri}" from "${result.target.serverName}".`, "", result.output].join("\n").trimEnd();
  }
  if (result.isError) {
    return [`MCP tool "${result.target.exposedName}" on "${result.target.serverName}" returned an error.`, "", result.output].join("\n").trimEnd();
  }
  return [`Called "${result.target.exposedName}" on "${result.target.serverName}".`, "", result.output].join("\n").trimEnd();
}

function executeToolCallUnavailable(tool: string): string {
  return `MCP tool calls for "${tool}" require the adapter runtime.`;
}

async function executeConnect(runtime: AdapterRuntime, ctx: RuntimeToolContext, state: ProxyState, serverName: string): Promise<string> {
  if (!state.servers.has(serverName)) return `Server "${serverName}" is not configured. Use mcp({}) to list configured servers.`;

  try {
    const result = await runtime.connectAndRefresh(ctx, serverName);
    const prefix = result.config.settings?.toolPrefix ?? state.prefix;
    const lines = [
      `Connected to "${serverName}" and cached ${result.tools.length} ${plural(result.tools.length, "tool")}, ${result.resources.length} ${plural(result.resources.length, "resource")}.`,
      "",
    ];

    if (result.tools.length > 0) {
      lines.push("Tools:");
      for (const tool of result.tools.slice(0, 20)) {
        lines.push(`- ${formatToolName(tool.name, serverName, prefix)} - ${tool.description || "(no description)"}`);
      }
      if (result.tools.length > 20) lines.push(`... ${result.tools.length - 20} more tools omitted.`);
      lines.push("");
    }

    if (result.resources.length > 0) {
      lines.push("Resources:");
      for (const resource of result.resources.slice(0, 20)) {
        const name = formatToolName(`get_${resourceNameToToolName(resource.name)}`, serverName, prefix);
        lines.push(`- ${name} - ${resource.description ?? `Read resource: ${resource.uri}`}`);
      }
      if (result.resources.length > 20) lines.push(`... ${result.resources.length - 20} more resources omitted.`);
      lines.push("");
    }

    lines.push(`Metadata cache updated: ${result.cachePath}`);
    return lines.join("\n").trimEnd();
  } catch (error) {
    if (error instanceof ServerNotConfiguredError || error instanceof UnsupportedTransportError || error instanceof InvalidServerConfigError) {
      return error.message;
    }
    return error instanceof Error ? error.message : `Failed to connect to "${serverName}": ${String(error)}`;
  }
}

function executeConnectUnavailable(server: string): string {
  return `Live MCP connection for "${server}" requires the adapter runtime.`;
}

function formatToolListItem(tool: ToolMetadata): string {
  return `- ${tool.name} - ${tool.description || "(no description)"}`;
}

function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}
