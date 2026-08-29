import type { Client, RequestOptions, Resource, Tool } from "@modelcontextprotocol/client";
import type { CachedResource, CachedTool } from "../core/cache.js";

export interface DiscoveredMetadata {
  tools: CachedTool[];
  resources: CachedResource[];
}

export async function discoverServerMetadata(client: Client, options: RequestOptions = {}): Promise<DiscoveredMetadata> {
  const [toolResult, resourceResult] = await Promise.all([
    client.listTools(undefined, options),
    client.listResources(undefined, options).catch(() => ({ resources: [] })),
  ]);

  return {
    tools: normalizeTools(toolResult.tools),
    resources: normalizeResources(resourceResult.resources),
  };
}

export function normalizeTools(tools: Array<Pick<Tool, "name" | "description" | "inputSchema" | "_meta">>): CachedTool[] {
  return tools.filter((tool) => !!tool.name).map((tool) => {
    const cached: CachedTool = { name: tool.name };
    if (tool.description) cached.description = tool.description;
    if (tool.inputSchema !== undefined) cached.inputSchema = tool.inputSchema;
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

function readStringMeta(meta: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = meta?.[key];
  return typeof value === "string" ? value : undefined;
}
