import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import type { AdapterRuntime, RuntimeToolContext } from "../runtime.js";
import { InvalidServerConfigError } from "../mcp/errors.js";
import { resolveHttpUrl } from "../mcp/http.js";
import { createOAuthProvider, isOAuthEnabled, parseOAuthRedirectUrl } from "../mcp/oauth-provider.js";
import { loadOAuthStore, redactOAuthMessage } from "../mcp/oauth-store.js";
import type { ProxyState } from "./proxy-tool.js";

export type OAuthAction = "auth-start" | "auth-complete" | "auth-status" | "auth-clear";

export async function executeOAuthAction(options: {
  action: OAuthAction;
  serverName: string | undefined;
  rawArgs?: string | undefined;
  runtime: AdapterRuntime;
  ctx: RuntimeToolContext;
  state: ProxyState;
}): Promise<string> {
  switch (options.action) {
    case "auth-start":
      return executeAuthStart(options);
    case "auth-complete":
      return executeAuthComplete(options);
    case "auth-status":
      return executeAuthStatus(options);
    case "auth-clear":
      return "OAuth auth-clear is not implemented in Slice 6.";
  }
}

export async function executeAuthStart(options: {
  serverName: string | undefined;
  runtime: AdapterRuntime;
  ctx: RuntimeToolContext;
  state: ProxyState;
}): Promise<string> {
  const prepared = prepareOAuthServer(options.state, options.serverName);
  if (!prepared.ok) return prepared.message;

  try {
    const provider = createOAuthProvider({
      serverName: prepared.serverName,
      serverUrl: prepared.serverUrl,
      definition: prepared.definition,
      home: options.state.home,
    });
    const result = await auth(provider, { serverUrl: prepared.serverUrl });
    if (result === "AUTHORIZED") {
      return [`OAuth authorization is available for "${prepared.serverName}".`, "", `Next: run mcp({ connect: "${prepared.serverName}" }) or /mcp reconnect ${prepared.serverName}.`].join("\n");
    }
    const authorizationUrl = provider.authorizationUrl;
    if (!authorizationUrl) return `OAuth authorization started for "${prepared.serverName}", but no authorization URL was returned. Run auth-start again.`;
    return [
      `OAuth authorization started for "${prepared.serverName}".`,
      "",
      "Open this URL in a browser and complete the login:",
      authorizationUrl,
      "",
      "After login, copy the full redirected URL and run:",
      `mcp({ action: "auth-complete", server: "${prepared.serverName}", args: "{\\\"redirectUrl\\\":\\\"<full redirected URL>\\\"}" })`,
      "",
      `Then reconnect with mcp({ connect: "${prepared.serverName}" }) or /mcp reconnect ${prepared.serverName}.`,
    ].join("\n");
  } catch (error) {
    return redactOAuthMessage(error);
  }
}

export async function executeAuthComplete(options: {
  serverName: string | undefined;
  rawArgs?: string | undefined;
  runtime: AdapterRuntime;
  ctx: RuntimeToolContext;
  state: ProxyState;
}): Promise<string> {
  const prepared = prepareOAuthServer(options.state, options.serverName);
  if (!prepared.ok) return prepared.message;
  const parsedArgs = parseAuthCompleteArgs(options.rawArgs);
  if (!parsedArgs.ok) return parsedArgs.message;

  try {
    const provider = createOAuthProvider({ serverName: prepared.serverName, serverUrl: prepared.serverUrl, definition: prepared.definition, home: options.state.home });
    const parsedRedirect = parsedArgs.code ? { code: parsedArgs.code, state: parsedArgs.state } : parseOAuthRedirectUrl(parsedArgs.redirectUrl!);
    if ("error" in parsedRedirect) {
      return `OAuth authorization failed for "${prepared.serverName}": ${parsedRedirect.error}${parsedRedirect.errorDescription ? ` (${parsedRedirect.errorDescription})` : ""}.`;
    }
    const expectedState = loadOAuthStore({ home: options.state.home, serverName: prepared.serverName, serverUrl: prepared.serverUrl.toString() })?.state;
    if (expectedState && parsedRedirect.state !== expectedState) {
      return `OAuth authorization failed for "${prepared.serverName}": state mismatch. Run auth-start again and complete the newest authorization URL.`;
    }

    await auth(provider, { serverUrl: prepared.serverUrl, authorizationCode: parsedRedirect.code });
    const tokens = await provider.tokens();
    if (!tokens?.access_token) return `OAuth authorization did not return an access token for "${prepared.serverName}". Run auth-start again.`;
    return [`OAuth authorization complete for "${prepared.serverName}".`, "", `Next: run mcp({ connect: "${prepared.serverName}" }) or /mcp reconnect ${prepared.serverName}.`].join("\n");
  } catch (error) {
    return redactOAuthMessage(error);
  }
}

function executeAuthStatus(options: { serverName: string | undefined; state: ProxyState }): string {
  const prepared = prepareOAuthServer(options.state, options.serverName);
  if (!prepared.ok) return prepared.message;
  const store = loadOAuthStore({ home: options.state.home, serverName: prepared.serverName, serverUrl: prepared.serverUrl.toString() });
  return [
    `OAuth status for "${prepared.serverName}":`,
    `- configured: yes`,
    `- tokens: ${store?.tokens ? "present" : "missing"}`,
    `- client information: ${store?.clientInformation ? "present" : "missing"}`,
    `- pending authorization: ${store?.authorizationUrl ? "present" : "missing"}`,
    `- discovery state: ${store?.discoveryState ? "present" : "missing"}`,
  ].join("\n");
}

function prepareOAuthServer(
  state: ProxyState,
  serverName: string | undefined,
): { ok: true; serverName: string; definition: NonNullable<ReturnType<ProxyState["servers"]["get"]>>["definition"]; serverUrl: URL } | { ok: false; message: string } {
  if (!serverName) return { ok: false, message: "OAuth server is required. Use mcp({ action: \"auth-start\", server: \"server\" })." };
  const server = state.servers.get(serverName);
  if (!server) return { ok: false, message: `Server "${serverName}" is not configured. Use mcp({}) to list configured servers.` };
  if (!server.definition.url) return { ok: false, message: `Server "${serverName}" requires an HTTP URL for OAuth authentication.` };
  if (!isOAuthEnabled(server.definition)) return { ok: false, message: `OAuth is not configured for server "${serverName}". Set auth: "oauth" and oauth.redirectUri in .mcp.json.` };
  try {
    return { ok: true, serverName, definition: server.definition, serverUrl: resolveHttpUrl(serverName, server.definition) };
  } catch (error) {
    if (error instanceof InvalidServerConfigError) return { ok: false, message: error.message };
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function parseAuthCompleteArgs(rawArgs: string | undefined):
  | { ok: true; redirectUrl?: string; code?: string; state?: string }
  | { ok: false; message: string } {
  if (!rawArgs) return { ok: false, message: 'OAuth auth-complete requires args JSON: {"redirectUrl":"<full redirected URL>"}.' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArgs);
  } catch {
    return { ok: false, message: 'OAuth auth-complete args must be valid JSON: {"redirectUrl":"<full redirected URL>"}.' };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, message: 'OAuth auth-complete args must be a JSON object with "redirectUrl".' };
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.redirectUrl === "string" && record.redirectUrl.trim()) return { ok: true, redirectUrl: record.redirectUrl };
  if (typeof record.code === "string" && record.code.trim()) return { ok: true, code: record.code, state: typeof record.state === "string" ? record.state : undefined };
  return { ok: false, message: 'OAuth auth-complete requires "redirectUrl" in args JSON.' };
}
