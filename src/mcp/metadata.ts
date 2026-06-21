import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { Resource, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { CachedResource, CachedTool } from "../core/cache.js";

export interface DiscoveredMetadata {
  tools: CachedTool[];
  resources: CachedResource[];
}

export async function discoverServerMetadata(client: Client, options: RequestOptions = {}): Promise<DiscoveredMetadata> {
  const [tools, resources] = await Promise.all([
    listAllTools(client, options),
    listAllResources(client, options).catch(() => []),
  ]);

  return { tools: normalizeTools(tools), resources: normalizeResources(resources) };
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

async function listAllTools(client: Client, options: RequestOptions): Promise<Tool[]> {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  do {
    const result = await client.listTools(cursor ? { cursor } : undefined, options);
    tools.push(...result.tools);
    cursor = result.nextCursor;
  } while (cursor);
  return tools;
}

async function listAllResources(client: Client, options: RequestOptions): Promise<Resource[]> {
  const resources: Resource[] = [];
  let cursor: string | undefined;
  do {
    const result = await client.listResources(cursor ? { cursor } : undefined, options);
    resources.push(...result.resources);
    cursor = result.nextCursor;
  } while (cursor);
  return resources;
}

function readStringMeta(meta: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = meta?.[key];
  return typeof value === "string" ? value : undefined;
}
