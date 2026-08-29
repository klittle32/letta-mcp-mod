import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { DiscoverResult, Icon, ToolAnnotations } from "@modelcontextprotocol/client";
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
  title?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: ToolAnnotations;
  icons?: Icon[];
  uiResourceUri?: string;
  uiStreamMode?: UiStreamMode;
}

export interface CachedResource {
  uri: string;
  name: string;
  description?: string;
}

export type CachedProtocolNegotiation =
  | { era: "legacy"; version: string }
  | { era: "modern"; version: string; discover: DiscoverResult };

export interface ServerCacheEntry {
  configHash: string;
  tools: CachedTool[];
  resources: CachedResource[];
  cachedAt: number;
  ttlMs?: number;
  cacheScope?: CacheScope;
  warnings?: string[];
  protocol?: CachedProtocolNegotiation;
}

export type CacheScope = "public" | "private";

export interface ServerCacheBucket {
  public?: ServerCacheEntry;
  private: Record<string, ServerCacheEntry>;
}

export interface MetadataCache {
  version: 2;
  servers: Record<string, ServerCacheBucket>;
}

export interface CacheLoadOptions {
  home?: string;
  warnings?: string[];
}

export function getMetadataCachePath(home = homedir()): string {
  return join(home, ".letta", "mcp-adapter", "cache.json");
}

export function emptyMetadataCache(): MetadataCache {
  return { version: 2, servers: {} };
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
  identityHash: string;
  tools: CachedTool[];
  resources: CachedResource[];
  ttlMs?: number;
  cacheScope?: CacheScope;
  warnings?: string[];
  protocol?: CachedProtocolNegotiation;
  now?: number;
  home?: string;
  env?: Record<string, string | undefined>;
}): MetadataCache {
  const cacheScope = options.cacheScope ?? "private";
  const entry: ServerCacheEntry = {
    configHash: computeServerHash(options.definition, { home: options.home, env: options.env }),
    cachedAt: options.now ?? Date.now(),
    tools: options.tools,
    resources: options.resources,
    protocol: options.protocol,
    ttlMs: options.ttlMs,
    cacheScope,
    warnings: options.warnings,
  };
  const bucket = options.cache.servers[options.serverName] ?? { private: {} };

  return {
    version: 2,
    servers: {
      ...options.cache.servers,
      [options.serverName]: cacheScope === "public"
        ? { public: entry, private: withoutKey(bucket.private, options.identityHash) }
        : { private: { ...bucket.private, [options.identityHash]: entry } },
    },
  };
}

export function updateServerProtocolCache(options: {
  cache: MetadataCache;
  serverName: string;
  definition: ServerEntry;
  identityHash: string;
  protocol: CachedProtocolNegotiation;
  now?: number;
  home?: string;
  env?: Record<string, string | undefined>;
}): MetadataCache {
  const configHash = computeServerHash(options.definition, { home: options.home, env: options.env });
  const current = getServerCacheEntry(options.cache, options.serverName, options.identityHash);
  const reusable = current?.configHash === configHash ? current : undefined;
  return updateServerCache({
    ...options,
    tools: reusable?.tools ?? [],
    resources: reusable?.resources ?? [],
    cacheScope: reusable?.cacheScope ?? "private",
    ttlMs: reusable?.ttlMs,
    warnings: reusable?.warnings,
    now: reusable?.cachedAt ?? options.now ?? Date.now(),
  });
}

export function getServerCacheEntry(
  cache: MetadataCache,
  serverName: string,
  identityHash: string,
): ServerCacheEntry | undefined {
  const bucket = cache.servers[serverName];
  return bucket?.private[identityHash] ?? bucket?.public;
}

export function invalidateServerCache(options: {
  cache: MetadataCache;
  serverName: string;
  identityHash: string;
}): MetadataCache {
  const bucket = options.cache.servers[options.serverName];
  if (!bucket) return options.cache;

  const nextBucket: ServerCacheBucket = bucket.private[options.identityHash]
    ? { ...bucket, private: withoutKey(bucket.private, options.identityHash) }
    : { private: bucket.private };
  const servers = { ...options.cache.servers };
  if (!nextBucket.public && Object.keys(nextBucket.private).length === 0) {
    delete servers[options.serverName];
  } else {
    servers[options.serverName] = nextBucket;
  }
  return { version: 2, servers };
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
    protocolVersion: definition.protocolVersion,
    headers: definition.headers ? omitAuthorizationHeader(interpolateEnvRecord(definition.headers, env)) : undefined,
    auth: definition.auth,
    bearerTokenEnv: definition.bearerTokenEnv,
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
    clientSecret: oauth.clientSecret === undefined ? undefined : "<configured>",
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

  const maxAgeMs = entry.ttlMs ?? options.maxAgeMs ?? 7 * 24 * 60 * 60 * 1000;
  if (maxAgeMs > 0 && (options.now ?? Date.now()) - entry.cachedAt > maxAgeMs) return false;
  if (maxAgeMs === 0 && (options.now ?? Date.now()) >= entry.cachedAt) return false;

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
      title: tool.title,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      annotations: tool.annotations,
      icons: tool.icons,
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
  if (!isRecord(value) || value.version !== 2 || !isRecord(value.servers)) return false;
  return Object.values(value.servers).every((bucket) => {
    if (!isRecord(bucket) || !isRecord(bucket.private)) return false;
    if (bucket.public !== undefined && !isValidServerCacheEntry(bucket.public)) return false;
    return Object.values(bucket.private).every(isValidServerCacheEntry);
  });
}

function isValidServerCacheEntry(entry: unknown): entry is ServerCacheEntry {
  return isRecord(entry)
    && typeof entry.configHash === "string"
    && typeof entry.cachedAt === "number"
    && (entry.ttlMs === undefined || (typeof entry.ttlMs === "number" && entry.ttlMs >= 0))
    && (entry.cacheScope === undefined || entry.cacheScope === "public" || entry.cacheScope === "private")
    && (entry.warnings === undefined || (Array.isArray(entry.warnings) && entry.warnings.every((warning) => typeof warning === "string")))
    && Array.isArray(entry.tools)
    && Array.isArray(entry.resources)
    && isValidProtocolNegotiation(entry.protocol);
}

function isValidProtocolNegotiation(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value) || typeof value.version !== "string") return false;
  if (value.era === "legacy") return true;
  return value.era === "modern" && isRecord(value.discover);
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

function omitAuthorizationHeader(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== "authorization"));
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}
