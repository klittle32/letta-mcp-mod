import { createHash } from "node:crypto";
import type { ServerEntry } from "../core/config.js";
import { interpolateEnvVars } from "../core/config.js";
import { getOAuthCredentials, loadOAuthStore } from "./oauth-store.js";

export interface CacheIdentityOptions {
  serverName: string;
  definition: ServerEntry;
  home?: string;
  env?: Record<string, string | undefined>;
}

export function resolveCacheIdentityHash(options: CacheIdentityOptions): string {
  const env = options.env ?? process.env;

  if (isOAuthDefinition(options.definition) && options.definition.url) {
    const store = loadOAuthStore({
      home: options.home,
      serverName: options.serverName,
      serverUrl: options.definition.url,
    });
    const credentials = getOAuthCredentials(store);
    const accessToken = credentials?.tokens?.access_token;
    if (accessToken) {
      const tokenRecord = credentials?.tokens as unknown as Record<string, unknown>;
      const discoveryRecord = store?.discoveryState as unknown as Record<string, unknown> | undefined;
      const claims = readJwtClaims(accessToken);
      const issuer = readString(tokenRecord?.issuer)
        ?? readString(discoveryRecord?.authorizationServerUrl)
        ?? claims?.issuer
        ?? options.definition.url;
      const subject = claims?.subject ?? fingerprint("opaque-oauth-token", accessToken);
      return fingerprint("oauth", `${issuer}\n${subject}`);
    }
  }

  const bearerToken = options.definition.bearerTokenEnv
    ? env[options.definition.bearerTokenEnv]
    : options.definition.bearerToken
      ? interpolateEnvVars(options.definition.bearerToken, env)
      : undefined;
  if (bearerToken) return fingerprint("bearer", bearerToken);

  const authorization = findAuthorizationHeader(options.definition.headers);
  if (authorization) return fingerprint("authorization", interpolateEnvVars(authorization, env));

  return fingerprint("anonymous", "");
}

function findAuthorizationHeader(headers: Record<string, string> | undefined): string | undefined {
  return Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === "authorization")?.[1];
}

function isOAuthDefinition(definition: ServerEntry): boolean {
  return definition.auth === "oauth" || (!!definition.oauth && typeof definition.oauth === "object");
}

function readJwtClaims(token: string): { issuer?: string; subject?: string } | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return {
      issuer: readString(parsed?.iss),
      subject: readString(parsed?.sub),
    };
  } catch {
    return undefined;
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function fingerprint(kind: string, value: string): string {
  return createHash("sha256").update(`${kind}\0${value}`).digest("hex");
}
