import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { OAuthConfig, ServerEntry } from "./config.js";
import { interpolateEnvRecord, interpolateEnvVars, resolveConfigPath } from "./config.js";
import {
  formatToolName,
  isToolExcluded,
  resourceNameToToolName,
  type ToolMetadata,
  type ToolPrefixMode,
  type UiStreamMode,
} from "./tool-names.js";

export interface CachedTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  uiResourceUri?: string;
  uiStreamMode?: UiStreamMode;
}

export interface CachedResource {
  uri: string;
  name: string;
  description?: string;
}

export interface ServerCacheEntry {
  configHash: string;
  tools: CachedTool[];
  resources: CachedResource[];
  cachedAt: number;
}

export interface MetadataCache {
  version: 1;
  servers: Record<string, ServerCacheEntry>;
}

export interface CacheLoadOptions {
  home?: string;
  warnings?: string[];
}

export function getMetadataCachePath(home = homedir()): string {
  return join(home, ".letta", "mcp-adapter", "cache.json");
}

export function emptyMetadataCache(): MetadataCache {
  return { version: 1, servers: {} };
}

export function loadMetadataCache(options: CacheLoadOptions = {}): MetadataCache | null {
  const path = getMetadataCachePath(options.home ?? homedir());
  if (!existsSync(path)) return null;

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!isValidCache(parsed)) {
      options.warnings?.push(`Invalid cache shape in ${path}.`);
      return null;
    }
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.warnings?.push(`Invalid cache JSON in ${path}: ${message}`);
    return null;
  }
}

export function saveMetadataCache(options: { home?: string; cache: MetadataCache }): void {
  const path = getMetadataCachePath(options.home ?? homedir());
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(sortValue(options.cache), null, 2)}\n`);
  renameSync(tempPath, path);
}

export function updateServerCache(options: {
  cache: MetadataCache;
  serverName: string;
  definition: ServerEntry;
  tools: CachedTool[];
  resources: CachedResource[];
  now?: number;
  home?: string;
  env?: Record<string, string | undefined>;
}): MetadataCache {
  return {
    version: 1,
    servers: {
      ...options.cache.servers,
      [options.serverName]: {
        configHash: computeServerHash(options.definition, { home: options.home, env: options.env }),
        cachedAt: options.now ?? Date.now(),
        tools: options.tools,
        resources: options.resources,
      },
    },
  };
}

export function computeServerHash(
  definition: ServerEntry,
  options: { home?: string; env?: Record<string, string | undefined> } = {},
): string {
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const identity = {
    command: definition.command,
    args: definition.args,
    env: definition.env ? interpolateEnvRecord(definition.env, env) : undefined,
    cwd: definition.cwd ? resolveConfigPath(definition.cwd, home, env) : undefined,
    url: definition.url,
    transport: definition.transport,
    headers: definition.headers ? interpolateEnvRecord(definition.headers, env) : undefined,
    auth: definition.auth,
    bearerToken: definition.bearerToken ? interpolateEnvVars(definition.bearerToken, env) : undefined,
    bearerTokenEnv: definition.bearerTokenEnv,
    bearerTokenEnvValue: definition.bearerTokenEnv ? env[definition.bearerTokenEnv] : undefined,
    oauth: normalizeOAuthForHash(definition.oauth, env),
    exposeResources: definition.exposeResources,
    excludeTools: definition.excludeTools,
  };

  return createHash("sha256").update(stableStringify(identity)).digest("hex");
}

function normalizeOAuthForHash(oauth: ServerEntry["oauth"], env: Record<string, string | undefined>): OAuthConfig | false | undefined {
  if (!oauth || typeof oauth !== "object" || Array.isArray(oauth)) return oauth;
  return {
    ...oauth,
    clientId: oauth.clientId !== undefined ? interpolateEnvVars(oauth.clientId, env) : undefined,
    clientSecret: oauth.clientSecret !== undefined ? interpolateEnvVars(oauth.clientSecret, env) : undefined,
    scope: oauth.scope !== undefined ? interpolateEnvVars(oauth.scope, env) : undefined,
    redirectUri: oauth.redirectUri !== undefined ? interpolateEnvVars(oauth.redirectUri, env) : undefined,
    clientName: oauth.clientName !== undefined ? interpolateEnvVars(oauth.clientName, env) : undefined,
    clientUri: oauth.clientUri !== undefined ? interpolateEnvVars(oauth.clientUri, env) : undefined,
  };
}

export function isServerCacheValid(
  entry: ServerCacheEntry | undefined,
  definition: ServerEntry,
  options: { now?: number; maxAgeMs?: number; home?: string; env?: Record<string, string | undefined> } = {},
): boolean {
  if (!entry) return false;
  const expectedHash = computeServerHash(definition, { home: options.home, env: options.env });
  if (entry.configHash !== expectedHash) return false;

  const maxAgeMs = options.maxAgeMs ?? 7 * 24 * 60 * 60 * 1000;
  if (maxAgeMs > 0 && (options.now ?? Date.now()) - entry.cachedAt > maxAgeMs) return false;

  return true;
}

export function reconstructToolMetadata(
  serverName: string,
  entry: ServerCacheEntry | undefined,
  prefix: ToolPrefixMode,
  definition: Pick<ServerEntry, "excludeTools" | "exposeResources">,
): ToolMetadata[] {
  if (!entry) return [];

  const metadata: ToolMetadata[] = [];
  for (const tool of entry.tools ?? []) {
    if (!tool?.name) continue;
    if (isToolExcluded(tool.name, serverName, prefix, definition.excludeTools)) continue;
    metadata.push({
      name: formatToolName(tool.name, serverName, prefix),
      originalName: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema,
      uiResourceUri: tool.uiResourceUri,
      uiStreamMode: tool.uiStreamMode,
    });
  }

  if (definition.exposeResources !== false) {
    for (const resource of entry.resources ?? []) {
      if (!resource?.name || !resource.uri) continue;
      const originalName = `get_${resourceNameToToolName(resource.name)}`;
      if (isToolExcluded(originalName, serverName, prefix, definition.excludeTools)) continue;
      metadata.push({
        name: formatToolName(originalName, serverName, prefix),
        originalName,
        description: resource.description ?? `Read resource: ${resource.uri}`,
        resourceUri: resource.uri,
      });
    }
  }

  return metadata;
}

function isValidCache(value: unknown): value is MetadataCache {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.servers)) return false;
  return Object.values(value.servers).every((entry) => {
    return isRecord(entry)
      && typeof entry.configHash === "string"
      && typeof entry.cachedAt === "number"
      && Array.isArray(entry.tools)
      && Array.isArray(entry.resources);
  });
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!isRecord(value)) return value;

  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const child = value[key];
    if (child !== undefined) sorted[key] = sortValue(child);
  }
  return sorted;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
