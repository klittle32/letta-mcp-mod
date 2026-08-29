import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileOAuthClientProvider,
  assertOAuthServerConfig,
  createOAuthProvider,
  isOAuthEnabled,
  parseOAuthRedirectUrl,
} from "../src/mcp/oauth-provider.js";
import { loadOAuthStore } from "../src/mcp/oauth-store.js";
import { InvalidServerConfigError } from "../src/mcp/errors.js";
import type { ServerEntry } from "../src/core/config.js";

function tempHome() {
  return mkdtempSync(join(tmpdir(), "letta-mcp-oauth-provider-"));
}

function oauthDefinition(overrides: Partial<ServerEntry> = {}): ServerEntry {
  return {
    url: "https://example.com/mcp",
    auth: "oauth",
    oauth: {
      clientId: "client-id",
      clientSecret: "client-secret-test-value",
      redirectUri: "http://127.0.0.1:3334/callback",
      scope: "read write",
      clientName: "Letta MCP Adapter",
      clientUri: "https://client.example.com/app",
    },
    ...overrides,
  };
}

describe("OAuth provider", () => {
  it("detects OAuth by auth mode or OAuth config object", () => {
    expect(isOAuthEnabled({ auth: "oauth" })).toBe(true);
    expect(isOAuthEnabled({ oauth: { redirectUri: "http://127.0.0.1/callback" } })).toBe(true);
    expect(isOAuthEnabled({ auth: "bearer", bearerToken: "token" })).toBe(false);
    expect(isOAuthEnabled({ auth: false, oauth: false })).toBe(false);
  });

  it("rejects mixed bearer and OAuth auth", () => {
    const definition = oauthDefinition({ bearerToken: "access-token-test-value" });

    expect(() => assertOAuthServerConfig("linear", definition)).toThrow(InvalidServerConfigError);
    expect(() => assertOAuthServerConfig("linear", definition)).toThrow(/cannot combine OAuth and bearer/i);
  });

  it("rejects non-HTTP OAuth servers", () => {
    expect(() => assertOAuthServerConfig("local", { command: "node", auth: "oauth" })).toThrow(/requires an HTTP URL/i);
  });

  it("requires redirect URI for authorization-code OAuth provider", () => {
    expect(() => createOAuthProvider({ serverName: "linear", serverUrl: new URL("https://example.com/mcp"), definition: oauthDefinition({ oauth: { clientId: "client-id" } }) })).toThrow(/redirectUri/i);
  });

  it("builds client metadata from config", () => {
    const provider = createOAuthProvider({ serverName: "linear", serverUrl: new URL("https://example.com/mcp"), definition: oauthDefinition(), home: tempHome() });

    expect(provider.clientMetadata).toMatchObject({
      redirect_uris: ["http://127.0.0.1:3334/callback"],
      client_name: "Letta MCP Adapter",
      client_uri: "https://client.example.com/app",
      scope: "read write",
      application_type: "native",
    });
  });

  it("returns static client information from config", async () => {
    const provider = createOAuthProvider({ serverName: "linear", serverUrl: new URL("https://example.com/mcp"), definition: oauthDefinition(), home: tempHome() });

    await expect(provider.clientInformation({ issuer: "https://auth.example.com" })).resolves.toEqual({
      client_id: "client-id",
      client_secret: "client-secret-test-value",
      issuer: "https://auth.example.com",
    });
  });

  it("saves and reloads dynamic client information", async () => {
    const home = tempHome();
    const definition = oauthDefinition({ oauth: { redirectUri: "http://127.0.0.1:3334/callback" } });
    const provider = createOAuthProvider({ serverName: "linear", serverUrl: new URL("https://example.com/mcp"), definition, home });

    await provider.saveClientInformation(
      { client_id: "dynamic-client", issuer: "https://auth.example.com" },
      { issuer: "https://auth.example.com" },
    );

    const reloaded = createOAuthProvider({ serverName: "linear", serverUrl: new URL("https://example.com/mcp"), definition, home });
    await expect(reloaded.clientInformation({ issuer: "https://auth.example.com" })).resolves.toEqual({
      client_id: "dynamic-client",
      issuer: "https://auth.example.com",
    });
    await expect(reloaded.clientInformation({ issuer: "https://other.example.com" })).resolves.toBeUndefined();
  });

  it("persists state, authorization URL, code verifier, tokens, and discovery state", async () => {
    const home = tempHome();
    const provider = createOAuthProvider({ serverName: "linear", serverUrl: new URL("https://example.com/mcp"), definition: oauthDefinition(), home, now: () => 111 });

    const state = await provider.state();
    await provider.redirectToAuthorization(new URL("https://auth.example.com/authorize?state=abc"));
    await provider.saveCodeVerifier("code-verifier-test-value");
    await provider.saveDiscoveryState({ authorizationServerUrl: "https://auth.example.com" });
    await provider.saveTokens(
      { access_token: "access-token-test-value", refresh_token: "refresh-token-test-value", token_type: "Bearer", issuer: "https://auth.example.com" },
      { issuer: "https://auth.example.com" },
    );

    const reloaded = new FileOAuthClientProvider({ serverName: "linear", serverUrl: new URL("https://example.com/mcp"), definition: oauthDefinition(), home });
    await expect(reloaded.state()).resolves.toBe(state);
    await expect(reloaded.codeVerifier()).resolves.toBe("code-verifier-test-value");
    await expect(reloaded.tokens()).resolves.toMatchObject({ access_token: "access-token-test-value", refresh_token: "refresh-token-test-value" });
    await expect(reloaded.discoveryState()).resolves.toEqual({ authorizationServerUrl: "https://auth.example.com" });
    expect(loadOAuthStore({ home, serverName: "linear", serverUrl: "https://example.com/mcp" })?.authorizationUrl).toBe("https://auth.example.com/authorize?state=abc");
  });

  it("invalidates credential scopes", async () => {
    const home = tempHome();
    const provider = createOAuthProvider({ serverName: "linear", serverUrl: new URL("https://example.com/mcp"), definition: oauthDefinition(), home });
    await provider.saveCodeVerifier("code-verifier-test-value");
    await provider.saveTokens(
      { access_token: "access-token-test-value", token_type: "Bearer", issuer: "https://auth.example.com" },
      { issuer: "https://auth.example.com" },
    );

    await provider.invalidateCredentials("tokens");

    expect(await provider.tokens()).toBeUndefined();
    await expect(provider.codeVerifier()).resolves.toBe("code-verifier-test-value");
  });

  it("keeps token records isolated when an MCP resource changes authorization issuers", async () => {
    const home = tempHome();
    const provider = createOAuthProvider({
      serverName: "linear",
      serverUrl: new URL("https://example.com/mcp"),
      definition: oauthDefinition(),
      home,
    });
    await provider.saveTokens(
      { access_token: "issuer-a-token", token_type: "Bearer", issuer: "https://auth-a.example.com/" },
      { issuer: "https://auth-a.example.com" },
    );
    await provider.saveTokens(
      { access_token: "issuer-b-token", token_type: "Bearer", issuer: "https://auth-b.example.com" },
      { issuer: "https://auth-b.example.com" },
    );

    await expect(provider.tokens({ issuer: "https://auth-a.example.com" })).resolves.toMatchObject({
      access_token: "issuer-a-token",
    });
    await expect(provider.tokens({ issuer: "https://auth-b.example.com/" })).resolves.toMatchObject({
      access_token: "issuer-b-token",
    });
    await expect(provider.tokens()).resolves.toMatchObject({ access_token: "issuer-b-token" });
  });

  it("parses redirect URLs and OAuth redirect errors", () => {
    expect(parseOAuthRedirectUrl("http://127.0.0.1/callback?code=authorization-code-test-value&state=state-value&iss=https%3A%2F%2Fauth.example.com")).toEqual({
      code: "authorization-code-test-value",
      state: "state-value",
      iss: "https://auth.example.com",
    });
    expect(parseOAuthRedirectUrl("http://127.0.0.1/callback?error=access_denied&error_description=Nope")).toEqual({
      error: "access_denied",
      errorDescription: "Nope",
    });
  });

  it("supports CIMD and rejects unsafe metadata document URLs", () => {
    const provider = createOAuthProvider({
      serverName: "linear",
      serverUrl: new URL("https://example.com/mcp"),
      definition: oauthDefinition({ oauth: {
        redirectUri: "http://127.0.0.1:3334/callback",
        clientMetadataUrl: "https://client.example.com/oauth/client.json",
      } }),
    });

    expect(provider.clientMetadataUrl).toBe("https://client.example.com/oauth/client.json");
    expect(() => createOAuthProvider({
      serverName: "linear",
      serverUrl: new URL("https://example.com/mcp"),
      definition: oauthDefinition({ oauth: {
        redirectUri: "http://127.0.0.1:3334/callback",
        clientMetadataUrl: "http://client.example.com/client.json",
      } }),
    })).toThrow(/clientMetadataUrl/i);
  });

  it("uses non-interactive native metadata for client credentials", () => {
    const provider = createOAuthProvider({
      serverName: "machine",
      serverUrl: new URL("https://example.com/mcp"),
      definition: oauthDefinition({ oauth: {
        grantType: "client_credentials",
        clientId: "client-id",
        clientSecret: "client-secret-test-value",
        audience: "api",
        scope: "read",
      } }),
    });

    expect(provider.redirectUrl).toBeUndefined();
    expect(provider.clientMetadata).toMatchObject({
      redirect_uris: [],
      grant_types: ["client_credentials"],
      application_type: "native",
    });
    expect(Object.fromEntries(provider.prepareTokenRequest("read")!)).toEqual({
      grant_type: "client_credentials",
      scope: "read",
      audience: "api",
    });
  });
});
