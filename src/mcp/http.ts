import type { ServerEntry } from "../core/config.js";
import { InvalidServerConfigError } from "./errors.js";

export type HttpTransportKind = "streamable-http" | "sse";
export type HttpTransportMode = "auto" | HttpTransportKind;

export function resolveHttpUrl(serverName: string, definition: ServerEntry): URL {
  const rawUrl = definition.url;
  if (!rawUrl) {
    throw new InvalidServerConfigError(`Server "${serverName}" is invalid: HTTP MCP servers require a url.`);
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new InvalidServerConfigError(`Server "${serverName}" has invalid URL "${rawUrl}": ${message}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new InvalidServerConfigError(`Server "${serverName}" uses unsupported URL protocol "${url.protocol}". HTTP MCP servers require http: or https:.`);
  }

  return url;
}

export function resolveHttpMode(definition: ServerEntry): HttpTransportMode {
  const mode = definition.transport ?? "auto";
  if (mode === "auto" || mode === "streamable-http" || mode === "sse") return mode;
  throw new InvalidServerConfigError(`HTTP MCP transport must be "auto", "streamable-http", or "sse".`);
}

export function resolveBearerToken(
  serverName: string,
  definition: ServerEntry,
  env: Record<string, string | undefined>,
): string | undefined {
  if (definition.bearerTokenEnv) {
    const token = env[definition.bearerTokenEnv];
    if (token) return token;
    throw new InvalidServerConfigError(`Server "${serverName}" references bearerTokenEnv "${definition.bearerTokenEnv}", but that environment variable is not set.`);
  }

  if (definition.bearerToken) return definition.bearerToken;

  if (definition.auth === "bearer") {
    throw new InvalidServerConfigError(`Server "${serverName}" requires bearer auth but no bearer token was resolved. Set bearerToken or bearerTokenEnv.`);
  }

  return undefined;
}

export function resolveHttpHeaders(
  serverName: string,
  definition: ServerEntry,
  env: Record<string, string | undefined>,
): Record<string, string> {
  const headers: Record<string, string> = { ...(definition.headers ?? {}) };
  const token = resolveBearerToken(serverName, definition, env);
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

export function mergeHeaders(base: ConstructorParameters<typeof Headers>[0] | undefined, extra: Record<string, string>): Headers {
  const headers = new Headers(base);
  for (const [name, value] of Object.entries(extra)) {
    headers.set(name, value);
  }
  return headers;
}
