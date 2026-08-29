import type { CacheableRequestOptions, Client, Resource, Tool, ToolAnnotations } from "@modelcontextprotocol/client";
import type { CacheScope, CachedResource, CachedTool } from "../core/cache.js";

export interface DiscoveredMetadata {
  tools: CachedTool[];
  resources: CachedResource[];
  cachePolicy: CachePolicy;
  warnings: string[];
}

export interface CachePolicy {
  ttlMs?: number;
  cacheScope?: CacheScope;
}

export async function discoverServerMetadata(
  client: Client,
  options: CacheableRequestOptions = {},
): Promise<DiscoveredMetadata> {
  const [toolResult, resourceResult] = await Promise.all([
    client.listTools(undefined, options),
    client.listResources(undefined, options).catch(() => ({ resources: [] })),
  ]);
  const warnings: string[] = [];

  return {
    tools: normalizeTools(toolResult.tools, warnings),
    resources: normalizeResources(resourceResult.resources),
    cachePolicy: mergeCachePolicies(readCachePolicy(toolResult), readCachePolicy(resourceResult)),
    warnings,
  };
}

export function normalizeTools(
  tools: Array<Pick<Tool, "name" | "title" | "description" | "inputSchema" | "outputSchema" | "annotations" | "icons" | "_meta">>,
  warnings: string[] = [],
): CachedTool[] {
  return tools.filter((tool) => {
    if (!tool.name) return false;
    if (tool.annotations === undefined) return true;
    if (isValidToolAnnotations(tool.annotations)) return true;
    warnings.push(`Dropped MCP tool "${tool.name}" because its annotations are invalid.`);
    return false;
  }).map((tool) => {
    const cached: CachedTool = { name: tool.name };
    if (tool.title) cached.title = tool.title;
    if (tool.description) cached.description = tool.description;
    if (tool.inputSchema !== undefined) cached.inputSchema = tool.inputSchema;
    if (tool.outputSchema !== undefined) cached.outputSchema = tool.outputSchema;
    if (tool.annotations !== undefined) cached.annotations = tool.annotations;
    if (tool.icons !== undefined) cached.icons = tool.icons;
    const uiResourceUri = readStringMeta(tool._meta, "openai/outputTemplate") ?? readStringMeta(tool._meta, "uiResourceUri");
    if (uiResourceUri) cached.uiResourceUri = uiResourceUri;
    return cached;
  });
}

export function normalizeResources(resources: Array<Pick<Resource, "uri" | "name" | "description">>): CachedResource[] {
  return resources.filter((resource) => !!resource.uri && !!resource.name).map((resource) => {
    const cached: CachedResource = { uri: resource.uri, name: resource.name };
    if (resource.description) cached.description = resource.description;
    return cached;
  });
}

export function mergeCachePolicies(...policies: CachePolicy[]): CachePolicy {
  const ttlValues = policies.map((policy) => policy.ttlMs).filter((value): value is number => value !== undefined);
  const scopes = policies.map((policy) => policy.cacheScope).filter((value): value is CacheScope => value !== undefined);
  return {
    ttlMs: ttlValues.length > 0 ? Math.min(...ttlValues) : undefined,
    cacheScope: scopes.includes("private") ? "private" : scopes.includes("public") ? "public" : undefined,
  };
}

export function readCachePolicy(value: unknown): CachePolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = value as Record<string, unknown>;
  return {
    ttlMs: typeof result.ttlMs === "number" && Number.isFinite(result.ttlMs) && result.ttlMs >= 0
      ? result.ttlMs
      : undefined,
    cacheScope: result.cacheScope === "public" || result.cacheScope === "private"
      ? result.cacheScope
      : undefined,
  };
}

function readStringMeta(meta: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = meta?.[key];
  return typeof value === "string" ? value : undefined;
}

function isValidToolAnnotations(value: unknown): value is ToolAnnotations {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const allowed = new Set(["title", "readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]);
  return Object.entries(record).every(([key, child]) => {
    if (!allowed.has(key)) return false;
    return key === "title" ? typeof child === "string" : typeof child === "boolean";
  });
}
