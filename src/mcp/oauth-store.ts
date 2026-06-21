import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";

export interface OAuthStorePaths {
  authDir: string;
  authFile: string;
}

export interface OAuthAuthStoreFile {
  version: 1;
  serverName: string;
  serverUrl: string;
  updatedAt: number;
  state?: string;
  authorizationUrl?: string;
  codeVerifier?: string;
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  discoveryState?: OAuthDiscoveryState;
}

export type OAuthCredentialScope = "all" | "client" | "tokens" | "verifier" | "discovery";

export interface OAuthStoreOptions {
  home?: string;
  serverName: string;
  serverUrl: string;
}

export function getOAuthAuthDir(home = homedir()): string {
  return join(home, ".letta", "mcp-adapter", "auth");
}

export function getOAuthStorePaths(options: OAuthStoreOptions): OAuthStorePaths {
  const authDir = getOAuthAuthDir(options.home ?? homedir());
  const readable = options.serverName.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "server";
  const hash = createHash("sha256").update(`${options.serverName}\n${options.serverUrl}`).digest("hex").slice(0, 16);
  return { authDir, authFile: join(authDir, `${readable}-${hash}.json`) };
}

export function loadOAuthStore(options: OAuthStoreOptions): OAuthAuthStoreFile | null {
  const { authFile } = getOAuthStorePaths(options);
  if (!existsSync(authFile)) return null;
  try {
    const parsed = JSON.parse(readFileSync(authFile, "utf8"));
    return isOAuthAuthStoreFile(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveOAuthStore(options: OAuthStoreOptions & { store: OAuthAuthStoreFile }): void {
  const { authDir, authFile } = getOAuthStorePaths(options);
  mkdirSync(authDir, { recursive: true, mode: 0o700 });
  const tempPath = `${authFile}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(sortValue(options.store), null, 2)}\n`, { mode: 0o600 });
  renameSync(tempPath, authFile);
}

export function updateOAuthStore(
  options: OAuthStoreOptions,
  update: (current: OAuthAuthStoreFile | null) => OAuthAuthStoreFile,
): OAuthAuthStoreFile {
  const next = update(loadOAuthStore(options));
  saveOAuthStore({ ...options, store: next });
  return next;
}

export function clearOAuthCredentials(options: OAuthStoreOptions & { scope: OAuthCredentialScope }): void {
  const current = loadOAuthStore(options);
  if (!current) return;
  const next: OAuthAuthStoreFile = { ...current, updatedAt: Date.now() };

  switch (options.scope) {
    case "all":
      delete next.state;
      delete next.authorizationUrl;
      delete next.codeVerifier;
      delete next.clientInformation;
      delete next.tokens;
      delete next.discoveryState;
      break;
    case "client":
      delete next.clientInformation;
      break;
    case "tokens":
      delete next.tokens;
      break;
    case "verifier":
      delete next.codeVerifier;
      delete next.state;
      delete next.authorizationUrl;
      break;
    case "discovery":
      delete next.discoveryState;
      break;
  }

  saveOAuthStore({ ...options, store: next });
}

export function redactOAuthMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/(access_token|refresh_token|client_secret|code_verifier|authorization_code|code)=([^\s&]+)/gi, "$1=<redacted>")
    .replace(/("(?:access_token|refresh_token|client_secret|code_verifier|authorization_code|code)"\s*:\s*")([^"]+)(")/gi, "$1<redacted>$3")
    .replace(/('(?:access_token|refresh_token|client_secret|code_verifier|authorization_code|code)'\s*:\s*')([^']+)(')/gi, "$1<redacted>$3");
}

function isOAuthAuthStoreFile(value: unknown): value is OAuthAuthStoreFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.version === 1 && typeof record.serverName === "string" && typeof record.serverUrl === "string" && typeof record.updatedAt === "number";
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortValue((value as Record<string, unknown>)[key]);
  }
  return sorted;
}
