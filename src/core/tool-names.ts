import type { Icon, ToolAnnotations } from "@modelcontextprotocol/client";

export type ToolPrefixMode = "server" | "short" | "none";
export type UiStreamMode = "eager" | "stream-first";

export interface ToolMetadata {
  name: string;
  originalName: string;
  title?: string;
  description: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: ToolAnnotations;
  icons?: Icon[];
  resourceUri?: string;
  uiResourceUri?: string;
  uiStreamMode?: UiStreamMode;
  serverName?: string;
}

export function getServerPrefix(serverName: string, mode: ToolPrefixMode): string {
  if (mode === "none") return "";
  if (mode === "short") {
    const stripped = serverName.replace(/-?mcp$/i, "").replace(/-/g, "_");
    return stripped || "mcp";
  }
  return serverName.replace(/-/g, "_");
}

export function formatToolName(toolName: string, serverName: string, mode: ToolPrefixMode): string {
  const prefix = getServerPrefix(serverName, mode);
  return prefix ? `${prefix}_${toolName}` : toolName;
}

export function normalizeToolName(value: string): string {
  return value.replace(/-/g, "_");
}

export function findToolByName(metadata: ToolMetadata[] | undefined, requestedName: string): ToolMetadata | undefined {
  if (!metadata) return undefined;
  const exact = metadata.find((tool) => tool.name === requestedName);
  if (exact) return exact;

  const normalized = normalizeToolName(requestedName);
  return metadata.find((tool) => normalizeToolName(tool.name) === normalized);
}

export function getToolNameCandidates(
  toolName: string,
  serverName: string,
  prefix: ToolPrefixMode,
): Set<string> {
  const normalizedTool = normalizeToolName(toolName);
  const normalizedServer = normalizeToolName(serverName);
  return new Set([
    normalizedTool,
    normalizeToolName(formatToolName(toolName, serverName, prefix)),
    normalizeToolName(formatToolName(toolName, serverName, "server")),
    normalizeToolName(formatToolName(toolName, serverName, "short")),
    `${normalizedServer}__${normalizedTool}`,
    `mcp/${normalizedServer}.${normalizedTool}`,
  ]);
}

export function matchesToolPattern(candidates: Iterable<string>, patterns?: unknown): boolean {
  if (!Array.isArray(patterns) || patterns.length === 0) return false;
  const normalizedCandidates = [...candidates].map(normalizeToolName);
  return patterns.some((pattern) => {
    if (typeof pattern !== "string") return false;
    const matcher = globToRegExp(normalizeToolName(pattern));
    return normalizedCandidates.some((candidate) => matcher.test(candidate));
  });
}

export function isToolIncluded(
  toolName: string,
  serverName: string,
  prefix: ToolPrefixMode,
  includeTools?: unknown,
): boolean {
  if (!Array.isArray(includeTools) || includeTools.length === 0) return true;
  return matchesToolPattern(getToolNameCandidates(toolName, serverName, prefix), includeTools);
}

export function isToolExcluded(
  toolName: string,
  serverName: string,
  prefix: ToolPrefixMode,
  excludeTools?: unknown,
): boolean {
  return matchesToolPattern(getToolNameCandidates(toolName, serverName, prefix), excludeTools);
}

export function isToolAllowed(
  toolName: string,
  serverName: string,
  prefix: ToolPrefixMode,
  includeTools?: unknown,
  excludeTools?: unknown,
): boolean {
  return isToolIncluded(toolName, serverName, prefix, includeTools)
    && !isToolExcluded(toolName, serverName, prefix, excludeTools);
}

export function resourceNameToToolName(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
  return normalized || "resource";
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (const character of pattern) {
    if (character === "*") {
      source += ".*";
    } else if (character === "?") {
      source += ".";
    } else {
      source += character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}
