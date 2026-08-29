import {
  AuthorizationServerMismatchError,
  IssuerMismatchError,
  auth,
} from "@modelcontextprotocol/client";
import type { AdapterRuntime, RuntimeToolContext } from "../runtime.js";
import { InvalidServerConfigError } from "../mcp/errors.js";
import { resolveHttpUrl } from "../mcp/http.js";
import { createOAuthProvider, isOAuthEnabled, parseOAuthRedirectUrl } from "../mcp/oauth-provider.js";
import {
  clearOAuthCredentials,
  getOAuthCredentials,
  hasOAuthCredential,
  loadOAuthStore,
  redactOAuthMessage,
} from "../mcp/oauth-store.js";
import type { ProxyState } from "./tool-catalog.js";

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
      return executeAuthClear(options);
  }
}

function executeAuthClear(options: { serverName: string | undefined; state: ProxyState }): string {
  const prepared = prepareOAuthServer(options.state, options.serverName);
  if (!prepared.ok) return prepared.message;
  clearOAuthCredentials({ home: options.state.home, serverName: prepared.serverName, serverUrl: prepared.serverUrl.toString(), scope: "all" });
  return [
    `OAuth credentials cleared for "${prepared.serverName}".`,
    "",
    `Run /toolbox auth-start ${prepared.serverName} to start a new login if needed.`,
  ].join("\n");
}

export async function executeAuthStart(options: {
  serverName: string | undefined;
  runtime: AdapterRuntime;
  ctx: RuntimeToolContext;
  state: ProxyState;
}): Promise<string> {
  const prepared = prepareOAuthServer(options.state, options.serverName);
  if (!prepared.ok) return prepared.message;
  if (getOAuthGrantType(prepared.definition) === "client_credentials") return executeClientCredentialsAuthStart(prepared, options.state);

  try {
    const provider = createOAuthProvider({
      serverName: prepared.serverName,
      serverUrl: prepared.serverUrl,
      definition: prepared.definition,
      home: options.state.home,
    });
    const result = await auth(provider, {
      serverUrl: prepared.serverUrl,
      scope: getOAuthConfig(prepared.definition).scope,
    });
    if (result === "AUTHORIZED") {
      return [`OAuth authorization is available for "${prepared.serverName}".`, "", `Next: run /toolbox reconnect ${prepared.serverName}.`].join("\n");
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
      `/toolbox auth-complete ${prepared.serverName} <full redirected URL>`,
      "",
      `Then reconnect with /toolbox reconnect ${prepared.serverName}.`,
    ].join("\n");
  } catch (error) {
    return formatOAuthFailure(prepared.serverName, error);
  }
}

async function executeClientCredentialsAuthStart(
  prepared: { serverName: string; definition: NonNullable<ReturnType<ProxyState["servers"]["get"]>>["definition"]; serverUrl: URL },
  state: ProxyState,
): Promise<string> {
  const config = getOAuthConfig(prepared.definition);
  if (!config.clientId) return `Server "${prepared.serverName}" OAuth client_credentials flow requires oauth.clientId.`;
  if (!config.clientSecret) return `Server "${prepared.serverName}" OAuth client_credentials flow requires oauth.clientSecret.`;

  try {
    const provider = createOAuthProvider({
      serverName: prepared.serverName,
      serverUrl: prepared.serverUrl,
      definition: prepared.definition,
      home: state.home,
    });
    const result = await auth(provider, { serverUrl: prepared.serverUrl, scope: config.scope });
    const tokens = await provider.tokens();
    if (result !== "AUTHORIZED" || !tokens?.access_token) {
      return `OAuth client_credentials token response for "${prepared.serverName}" did not include an access token.`;
    }
    return [`OAuth client_credentials token stored for "${prepared.serverName}".`, "", `Next: run /toolbox reconnect ${prepared.serverName}.`].join("\n");
  } catch (error) {
    return formatOAuthFailure(prepared.serverName, error);
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
    const parsedRedirect = parseOAuthRedirectUrl(parsedArgs.redirectUrl);
    if ("error" in parsedRedirect) {
      return `OAuth authorization failed for "${prepared.serverName}": ${parsedRedirect.error}.`;
    }
    const expectedState = loadOAuthStore({ home: options.state.home, serverName: prepared.serverName, serverUrl: prepared.serverUrl.toString() })?.state;
    if (expectedState && parsedRedirect.state !== expectedState) {
      return `OAuth authorization failed for "${prepared.serverName}": state mismatch. Run auth-start again and complete the newest authorization URL.`;
    }

    await auth(provider, {
      serverUrl: prepared.serverUrl,
      authorizationCode: parsedRedirect.code,
      iss: parsedRedirect.iss,
    });
    const tokens = await provider.tokens();
    if (!tokens?.access_token) return `OAuth authorization did not return an access token for "${prepared.serverName}". Run auth-start again.`;
    return [`OAuth authorization complete for "${prepared.serverName}".`, "", `Next: run /toolbox reconnect ${prepared.serverName}.`].join("\n");
  } catch (error) {
    return formatOAuthFailure(prepared.serverName, error);
  }
}

function executeAuthStatus(options: { serverName: string | undefined; state: ProxyState }): string {
  const prepared = prepareOAuthServer(options.state, options.serverName);
  if (!prepared.ok) return prepared.message;
  const store = loadOAuthStore({ home: options.state.home, serverName: prepared.serverName, serverUrl: prepared.serverUrl.toString() });
  const activeCredentials = getOAuthCredentials(store);
  const hasClientInformation = !!getOAuthConfig(prepared.definition).clientId
    || !!activeCredentials?.clientInformation
    || hasOAuthCredential(store, "clientInformation");
  return [
    `OAuth status for "${prepared.serverName}":`,
    `- configured: yes`,
    `- active issuer: ${store?.activeIssuer ?? "missing"}`,
    `- tokens: ${activeCredentials?.tokens ? "present" : "missing"}`,
    `- client information: ${hasClientInformation ? "present" : "missing"}`,
    `- pending authorization: ${store?.authorizationUrl ? "present" : "missing"}`,
    `- discovery state: ${store?.discoveryState ? "present" : "missing"}`,
  ].join("\n");
}

function prepareOAuthServer(
  state: ProxyState,
  serverName: string | undefined,
): { ok: true; serverName: string; definition: NonNullable<ReturnType<ProxyState["servers"]["get"]>>["definition"]; serverUrl: URL } | { ok: false; message: string } {
  if (!serverName) return { ok: false, message: "OAuth server is required. Use /toolbox auth-start <server>." };
  const server = state.servers.get(serverName);
  if (!server) return { ok: false, message: `Server "${serverName}" is not configured. Use /toolbox status to list configured servers.` };
  if (!server.definition.url) return { ok: false, message: `Server "${serverName}" requires an HTTP URL for OAuth authentication.` };
  if (!isOAuthEnabled(server.definition)) return { ok: false, message: `OAuth is not configured for server "${serverName}". Set auth: "oauth" and oauth settings in .mcp.json.` };
  try {
    return { ok: true, serverName, definition: server.definition, serverUrl: resolveHttpUrl(serverName, server.definition) };
  } catch (error) {
    if (error instanceof InvalidServerConfigError) return { ok: false, message: error.message };
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function getOAuthConfig(definition: { oauth?: unknown }): { grantType?: string; clientId?: string; clientSecret?: string; scope?: string; audience?: string } {
  return definition.oauth && typeof definition.oauth === "object" && !Array.isArray(definition.oauth) ? definition.oauth as Record<string, string | undefined> : {};
}

function getOAuthGrantType(definition: { oauth?: unknown }): string {
  return getOAuthConfig(definition).grantType ?? "authorization_code";
}

function parseAuthCompleteArgs(rawArgs: string | undefined):
  | { ok: true; redirectUrl: string }
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
  return { ok: false, message: 'OAuth auth-complete requires "redirectUrl" in args JSON.' };
}

function formatOAuthFailure(serverName: string, error: unknown): string {
  if (error instanceof IssuerMismatchError) {
    return `OAuth authorization failed for "${serverName}": authorization-server issuer mismatch. Run auth-clear, then start a new authorization.`;
  }
  if (error instanceof AuthorizationServerMismatchError) {
    return `OAuth authorization failed for "${serverName}": the authorization server changed during login. Run auth-clear, then start a new authorization.`;
  }
  return redactOAuthMessage(error);
}
