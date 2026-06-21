export type ToolPrefixMode = "server" | "short" | "none";
export type UiStreamMode = "eager" | "stream-first";

export interface ToolMetadata {
  name: string;
  originalName: string;
  description: string;
  inputSchema?: unknown;
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

export function isToolExcluded(
  toolName: string,
  serverName: string,
  prefix: ToolPrefixMode,
  excludeTools?: unknown,
): boolean {
  if (!Array.isArray(excludeTools) || excludeTools.length === 0) return false;

  const candidates = new Set([
    normalizeToolName(toolName),
    normalizeToolName(formatToolName(toolName, serverName, prefix)),
    normalizeToolName(formatToolName(toolName, serverName, "server")),
    normalizeToolName(formatToolName(toolName, serverName, "short")),
  ]);

  return excludeTools.some((excluded) => typeof excluded === "string" && candidates.has(normalizeToolName(excluded)));
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
