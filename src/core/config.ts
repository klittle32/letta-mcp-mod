import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ImportKind = "cursor" | "claude-code" | "claude-desktop" | "vscode" | "windsurf" | "codex" | string;

export type ApprovalDecision = "allow" | "ask" | "alwaysAsk" | "deny";

export interface McpApprovalSettings {
  dangerousTools?: ApprovalDecision;
  unknownServers?: ApprovalDecision;
  configWrites?: ApprovalDecision;
}

export interface OAuthConfig {
  grantType?: "authorization_code" | "client_credentials";
  clientId?: string;
  clientSecret?: string;
  tokenUrl?: string;
  audience?: string;
  scope?: string;
  redirectUri?: string;
  clientName?: string;
  clientUri?: string;
}

export interface ServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  transport?: "auto" | "streamable-http" | "sse";
  headers?: Record<string, string>;
  auth?: "oauth" | "bearer" | false;
  bearerToken?: string;
  bearerTokenEnv?: string;
  oauth?: OAuthConfig | false;
  lifecycle?: "lazy" | "eager" | "keep-alive";
  idleTimeout?: number;
  exposeResources?: boolean;
  directTools?: boolean | string[];
  excludeTools?: string[];
  debug?: boolean;
  [key: string]: unknown;
}

export interface McpSettings {
  toolPrefix?: "server" | "short" | "none";
  idleTimeout?: number;
  directTools?: boolean;
  disableProxyTool?: boolean;
  autoAuth?: boolean;
  authRequiredMessage?: string;
  regexSearch?: boolean | { maxPatternLength?: number };
  ui?: { status?: boolean; panels?: boolean; panelTTLms?: number };
  sampling?: { enabled?: boolean; mode?: "disabled" | "summary-only" | "conversation-fork"; alwaysAsk?: boolean; maxPromptChars?: number };
  elicitation?: { enabled?: boolean; form?: boolean; url?: boolean; alwaysAsk?: boolean; timeoutMs?: number };
  approval?: McpApprovalSettings;
  [key: string]: unknown;
}

export interface McpConfig {
  mcpServers: Record<string, ServerEntry>;
  imports?: ImportKind[];
  settings?: McpSettings;
  [key: string]: unknown;
}

export interface ConfigSourceStatus {
  path: string;
  kind: "user-standard" | "letta-global" | "project-standard" | "project-letta";
  exists: boolean;
  loaded: boolean;
}

export interface LoadedMcpConfig {
  config: McpConfig;
  sources: ConfigSourceStatus[];
  warnings: string[];
}

export interface ConfigLoadOptions {
  cwd: string;
  home?: string;
  env?: Record<string, string | undefined>;
  globalOverridePath?: string;
  projectOverridePath?: string;
}

export function getConfigSources(options: Pick<ConfigLoadOptions, "cwd" | "home" | "globalOverridePath" | "projectOverridePath">): ConfigSourceStatus[] {
  const home = options.home ?? homedir();
  const candidates = [
    { path: join(home, ".config", "mcp", "mcp.json"), kind: "user-standard" as const },
    { path: options.globalOverridePath ?? join(home, ".letta", "mcp-adapter", "mcp.json"), kind: "letta-global" as const },
    { path: join(options.cwd, ".mcp.json"), kind: "project-standard" as const },
    { path: options.projectOverridePath ?? join(options.cwd, ".letta", "mcp.json"), kind: "project-letta" as const },
  ];

  return candidates.map((candidate) => ({ ...candidate, exists: existsSync(candidate.path), loaded: false }));
}

export function loadMcpConfig(options: ConfigLoadOptions): LoadedMcpConfig {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const sources = getConfigSources(options);
  const warnings: string[] = [];
  let config: McpConfig = { mcpServers: {} };

  for (const source of sources) {
    if (!source.exists) continue;
    const parsed = readConfigFile(source.path, warnings);
    if (!parsed) continue;
    const validated = validateConfig(parsed, source.path, warnings);
    if (!validated) continue;
    config = mergeConfigs(config, normalizeConfig(validated, home, env));
    source.loaded = true;
  }

  return { config, sources, warnings };
}

export function readConfigFile(path: string, warnings: string[]): unknown | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`Invalid JSON in ${path}: ${message}`);
    return null;
  }
}

export function validateConfig(raw: unknown, path = "<config>", warnings: string[] = []): McpConfig | null {
  if (!isRecord(raw)) {
    warnings.push(`Invalid config in ${path}: root must be an object.`);
    return null;
  }

  if (raw.mcpServers !== undefined && !isRecord(raw.mcpServers)) {
    warnings.push(`Invalid config in ${path}: mcpServers must be an object.`);
    return null;
  }

  const mcpServers: Record<string, ServerEntry> = {};
  if (isRecord(raw.mcpServers)) {
    for (const [name, value] of Object.entries(raw.mcpServers)) {
      if (!isRecord(value)) {
        warnings.push(`Invalid server "${name}" in ${path}: server entry must be an object.`);
        continue;
      }
      mcpServers[name] = { ...value } as ServerEntry;
    }
  }

  const config: McpConfig = { ...raw, mcpServers } as McpConfig;
  return config;
}

export function mergeConfigs(base: McpConfig, next: McpConfig): McpConfig {
  return {
    ...base,
    ...next,
    mcpServers: {
      ...(base.mcpServers ?? {}),
      ...(next.mcpServers ?? {}),
    },
    settings: base.settings || next.settings ? { ...(base.settings ?? {}), ...(next.settings ?? {}) } : undefined,
    imports: next.imports ?? base.imports,
  };
}

function normalizeConfig(config: McpConfig, home: string, env: Record<string, string | undefined>): McpConfig {
  const mcpServers: Record<string, ServerEntry> = {};
  for (const [name, server] of Object.entries(config.mcpServers ?? {})) {
    mcpServers[name] = normalizeServerEntry(server, home, env);
  }
  return { ...config, mcpServers };
}

function normalizeServerEntry(server: ServerEntry, home: string, env: Record<string, string | undefined>): ServerEntry {
  const normalized: ServerEntry = { ...server };
  if (server.cwd !== undefined) normalized.cwd = resolveConfigPath(server.cwd, home, env);
  if (server.env) normalized.env = interpolateEnvRecord(server.env, env);
  if (server.headers) normalized.headers = interpolateEnvRecord(server.headers, env);
  if (server.bearerToken !== undefined) normalized.bearerToken = interpolateEnvVars(server.bearerToken, env);
  if (server.oauth && isRecord(server.oauth)) normalized.oauth = normalizeOAuthConfig(server.oauth, env);
  return normalized;
}

function normalizeOAuthConfig(oauth: OAuthConfig, env: Record<string, string | undefined>): OAuthConfig {
  return {
    ...oauth,
    clientId: oauth.clientId !== undefined ? interpolateEnvVars(oauth.clientId, env) : undefined,
    clientSecret: oauth.clientSecret !== undefined ? interpolateEnvVars(oauth.clientSecret, env) : undefined,
    tokenUrl: oauth.tokenUrl !== undefined ? interpolateEnvVars(oauth.tokenUrl, env) : undefined,
    audience: oauth.audience !== undefined ? interpolateEnvVars(oauth.audience, env) : undefined,
    scope: oauth.scope !== undefined ? interpolateEnvVars(oauth.scope, env) : undefined,
    redirectUri: oauth.redirectUri !== undefined ? interpolateEnvVars(oauth.redirectUri, env) : undefined,
    clientName: oauth.clientName !== undefined ? interpolateEnvVars(oauth.clientName, env) : undefined,
    clientUri: oauth.clientUri !== undefined ? interpolateEnvVars(oauth.clientUri, env) : undefined,
  };
}

export function interpolateEnvRecord(values: Record<string, string>, env: Record<string, string | undefined> = process.env): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    result[key] = interpolateEnvVars(value, env);
  }
  return result;
}

export function interpolateEnvVars(value: string, env: Record<string, string | undefined> = process.env): string {
  return value
    .replace(/\$\{(\w+)\}/g, (_match, name: string) => env[name] ?? "")
    .replace(/\$env:(\w+)/g, (_match, name: string) => env[name] ?? "");
}

export function resolveConfigPath(value: string | undefined, home = homedir(), env: Record<string, string | undefined> = process.env): string | undefined {
  if (value === undefined) return undefined;
  const resolved = interpolateEnvVars(value, env);
  if (resolved === "~") return home;
  if (resolved.startsWith("~/") || resolved.startsWith("~\\")) {
    return join(home, resolved.slice(2));
  }
  return resolved;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
