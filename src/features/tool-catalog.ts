import { homedir } from "node:os";
import { emptyMetadataCache, getServerCacheEntry, isServerCacheValid, loadMetadataCache, reconstructToolMetadata, type MetadataCache, type ServerCacheEntry } from "../core/cache.js";
import { loadMcpConfig, type LoadedMcpConfig, type McpConfig, type ServerEntry } from "../core/config.js";
import { type ToolMetadata, type ToolPrefixMode } from "../core/tool-names.js";
import { resolveCacheIdentityHash } from "../mcp/cache-identity.js";
import type { CallToolResult } from "../runtime.js";

export interface SearchToolsArgs {
  query: string;
  limit?: number;
}

export interface ProxyServerState {
  name: string;
  definition: ServerEntry;
  identityHash: string;
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

export function createProxyState(options: CreateProxyStateOptions): ProxyState {
  const config = options.config;
  const cache = options.cache ?? emptyMetadataCache();
  const prefix = config.settings?.toolPrefix ?? "server";
  const servers = new Map<string, ProxyServerState>();
  const warnings = [...(options.warnings ?? [])];

  for (const [name, definition] of Object.entries(config.mcpServers ?? {})) {
    const identityHash = resolveCacheIdentityHash({
      serverName: name,
      definition,
      home: options.home,
      env: options.env,
    });
    const cacheEntry = getServerCacheEntry(cache, name, identityHash);
    const cacheValid = isServerCacheValid(cacheEntry, definition, {
      now: options.now,
      home: options.home,
      env: options.env,
    });
    const tools = cacheEntry && cacheValid ? reconstructToolMetadata(name, cacheEntry, prefix, definition) : [];
    if (cacheEntry?.warnings) warnings.push(...cacheEntry.warnings);
    servers.set(name, { name, definition, identityHash, cacheEntry, cacheValid, tools });
  }

  return { config, warnings, prefix, servers, home: options.home, env: options.env };
}

export function loadInvocationProxyState(ctx: { cwd: string }): ProxyState {
  const warnings: string[] = [];
  const loaded: LoadedMcpConfig = loadMcpConfig({ cwd: ctx.cwd, home: homedir() });
  warnings.push(...loaded.warnings);
  const cache = loadMetadataCache({ home: homedir(), warnings }) ?? emptyMetadataCache();
  return createProxyState({ config: loaded.config, cache, warnings });
}

export function executeStatus(state: ProxyState): string {
  const configured = state.servers.size;
  const cachedTools = [...state.servers.values()].reduce((count, server) => count + server.tools.length, 0);
  const lines = [`Toolbox: ${configured} configured servers, ${cachedTools} cached ${plural(cachedTools, "tool")}.`];

  if (state.warnings.length > 0) {
    lines.push("", "Warnings:", ...state.warnings.map((warning) => `- ${warning}`));
  }

  if (configured === 0) {
    lines.push("", "No integration servers configured.", "Run /toolbox setup for configuration guidance.");
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
  lines.push("", "Use /toolbox reconnect <server> to refresh cached metadata.");
  return lines.join("\n");
}

export function executeListServer(state: ProxyState, serverName: string): string {
  const server = state.servers.get(serverName);
  if (!server) return `Server "${serverName}" is not configured. Use /toolbox status to list configured servers.`;
  if (!server.cacheEntry) return `Server "${serverName}" is configured but has no metadata cache. Use /toolbox reconnect ${serverName} to create it.`;
  if (!server.cacheValid) return `Server "${serverName}" has a stale metadata cache. Use /toolbox reconnect ${serverName} to refresh it.`;
  if (server.tools.length === 0) return `${serverName} (0 cached tools).`;

  return [`${serverName} (${server.tools.length} cached ${plural(server.tools.length, "tool")}):`, "", ...server.tools.map(formatToolListItem)].join("\n");
}

export const DEFAULT_SEARCH_LIMIT = 10;
export const MAX_SEARCH_LIMIT = 50;

export function executeSearch(
  state: ProxyState,
  args: SearchToolsArgs,
  refreshFailures: string[] = [],
): string {
  const query = args.query.trim();
  if (!query) return "A search query is required.";
  if (state.servers.size === 0) {
    return "No external integrations are configured. Run /toolbox setup to configure an integration server.";
  }

  const limit = normalizeSearchLimit(args.limit);
  const normalizedQuery = query.toLowerCase();
  const terms = normalizedQuery.split(/\s+/).filter(Boolean);
  const matches: Array<{ server: ProxyServerState; tool: ToolMetadata; score: number }> = [];

  for (const server of state.servers.values()) {
    for (const tool of server.tools) {
      const score = scoreToolMatch(server.name, tool, normalizedQuery, terms);
      if (score > 0) matches.push({ server, tool, score });
    }
  }

  matches.sort((left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name));
  const selected = matches.slice(0, limit);
  const lines: string[] = [];

  if (selected.length === 0) {
    lines.push(`No external tools matched "${query}".`);
  } else {
    lines.push(`${matches.length} external ${plural(matches.length, "tool")} matched "${query}". Showing ${selected.length}:`);
    for (const match of selected) {
      lines.push(
        "",
        `${formatToolDisplayName(match.tool)} (${match.server.name})`,
        `  ${match.tool.description || "(no description)"}`,
      );
      const hint = formatAnnotationHint(match.tool);
      if (hint) lines.push(`  ${hint}`);
      if (match.tool.uiResourceUri) lines.push(`  UI resource: ${match.tool.uiResourceUri}`);
      lines.push("  Input schema:", formatInputSchema(match.tool.inputSchema, "    "));
    }
    lines.push("", "Call one with call_tool using the returned name and arguments matching its input schema.");
  }

  if (refreshFailures.length > 0) {
    lines.push("", "Some integrations were unavailable:", ...refreshFailures.map((failure) => `- ${failure}`));
  }
  return lines.join("\n");
}

function normalizeSearchLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_SEARCH_LIMIT;
  return Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.floor(value)));
}

function formatInputSchema(schema: unknown, indent: string): string {
  return JSON.stringify(schema ?? {}, null, 2)
    .split("\n")
    .map((line) => `${indent}${line}`)
    .join("\n");
}

function scoreToolMatch(serverName: string, tool: ToolMetadata, query: string, terms: string[]): number {
  const name = tool.name.toLowerCase();
  const originalName = tool.originalName.toLowerCase();
  const title = getToolTitle(tool)?.toLowerCase() ?? "";
  const description = tool.description.toLowerCase();
  const server = serverName.toLowerCase();
  let score = 0;

  if (name === query || originalName === query) score += 100;
  if (title === query) score += 90;
  for (const term of terms) {
    if (name.includes(term)) score += 20;
    if (originalName.includes(term)) score += 15;
    if (title.includes(term)) score += 10;
    if (description.includes(term)) score += 5;
    if (server.includes(term)) score += 2;
  }
  return score;
}

export function formatRuntimeCallToolResult(result: CallToolResult): string {
  if (!result.ok) return result.message;
  return result.output;
}

function formatToolListItem(tool: ToolMetadata): string {
  const ui = tool.uiResourceUri ? ` [UI resource: ${tool.uiResourceUri}]` : "";
  const hint = formatAnnotationHint(tool);
  return `- ${formatToolDisplayName(tool)} - ${tool.description || "(no description)"}${hint ? ` [${hint}]` : ""}${ui}`;
}

function formatToolDisplayName(tool: ToolMetadata): string {
  const title = getToolTitle(tool);
  return title && title !== tool.name ? `${tool.name} — ${title}` : tool.name;
}

function formatAnnotationHint(tool: ToolMetadata): string | undefined {
  if (tool.annotations?.destructiveHint === true) return "destructive";
  if (tool.annotations?.readOnlyHint === true) return "read-only";
  return undefined;
}

function getToolTitle(tool: ToolMetadata): string | undefined {
  return tool.title ?? tool.annotations?.title;
}

function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}
