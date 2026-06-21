import { getServerPrefix, normalizeToolName, type ToolMetadata } from "../core/tool-names.js";
import type { ProxyState, ProxyServerState } from "../features/proxy-tool.js";

export interface ToolTarget {
  serverName: string;
  requestedName: string;
  exposedName: string;
  originalName: string;
  metadata: ToolMetadata;
  isResource: boolean;
  resourceUri?: string;
}

export type ToolTargetResolution =
  | { ok: true; target: ToolTarget }
  | { ok: false; kind: "unknown_server" | "unknown_tool" | "ambiguous_tool" | "invalid_tool"; message: string; serverHint?: string };

export function resolveToolTarget(state: ProxyState, options: { toolName: string; serverName?: string }): ToolTargetResolution {
  const requestedName = options.toolName.trim();
  if (!requestedName) {
    return { ok: false, kind: "invalid_tool", message: "MCP tool name is required." };
  }

  if (options.serverName && !state.servers.has(options.serverName)) {
    return {
      ok: false,
      kind: "unknown_server",
      message: `Server "${options.serverName}" is not configured. Use mcp({}) to list configured servers.`,
    };
  }

  const serverHint = inferServerHint(state, requestedName, options.serverName);
  const servers = options.serverName ? [state.servers.get(options.serverName)!] : [...state.servers.values()];
  const matches = findMatches(servers, requestedName);

  if (matches.length === 1) return { ok: true, target: matches[0] };
  if (matches.length > 1) {
    const names = matches.map((match) => match.exposedName).sort().join(", ");
    return {
      ok: false,
      kind: "ambiguous_tool",
      message: `Tool "${requestedName}" is ambiguous. Use one of: ${names}.`,
      serverHint,
    };
  }

  return {
    ok: false,
    kind: "unknown_tool",
    message: `Tool "${requestedName}" was not found in cached MCP metadata. Use mcp({ search: "${requestedName}" }) or mcp({ connect: "server" }) first.`,
    serverHint,
  };
}

export function inferServerHint(state: ProxyState, toolName: string, explicitServerName?: string): string | undefined {
  if (explicitServerName && state.servers.has(explicitServerName)) return explicitServerName;
  if (state.prefix !== "server") return undefined;

  const normalizedToolName = normalizeToolName(toolName);
  const matchingServers = [...state.servers.keys()]
    .filter((serverName) => normalizedToolName.startsWith(`${normalizeToolName(getServerPrefix(serverName, "server"))}_`))
    .sort((a, b) => b.length - a.length);
  return matchingServers[0];
}

function findMatches(servers: ProxyServerState[], requestedName: string): ToolTarget[] {
  const normalized = normalizeToolName(requestedName);
  const exactExposed: ToolTarget[] = [];
  const normalizedExposed: ToolTarget[] = [];
  const original: ToolTarget[] = [];

  for (const server of servers) {
    for (const metadata of server.tools) {
      const target = toTarget(server.name, requestedName, metadata);
      if (metadata.name === requestedName) exactExposed.push(target);
      else if (normalizeToolName(metadata.name) === normalized) normalizedExposed.push(target);
      else if (normalizeToolName(metadata.originalName) === normalized) original.push(target);
    }
  }

  return exactExposed.length > 0 ? exactExposed : normalizedExposed.length > 0 ? normalizedExposed : original;
}

function toTarget(serverName: string, requestedName: string, metadata: ToolMetadata): ToolTarget {
  return {
    serverName,
    requestedName,
    exposedName: metadata.name,
    originalName: metadata.originalName,
    metadata,
    isResource: !!metadata.resourceUri,
    resourceUri: metadata.resourceUri,
  };
}
