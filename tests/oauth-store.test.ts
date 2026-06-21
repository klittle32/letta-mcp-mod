import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  clearOAuthCredentials,
  getOAuthAuthDir,
  getOAuthStorePaths,
  loadOAuthStore,
  saveOAuthStore,
  updateOAuthStore,
  type OAuthAuthStoreFile,
} from "../src/mcp/oauth-store.js";

function tempHome() {
  return mkdtempSync(join(tmpdir(), "letta-mcp-oauth-store-"));
}

function sampleStore(overrides: Partial<OAuthAuthStoreFile> = {}): OAuthAuthStoreFile {
  return {
    version: 1,
    serverName: "linear",
    serverUrl: "https://example.com/mcp",
    updatedAt: 123,
    ...overrides,
  };
}

describe("OAuth auth store", () => {
  it("auth dir defaults under ~/.letta/mcp-adapter/auth with injectable home", () => {
    const home = tempHome();

    expect(getOAuthAuthDir(home)).toBe(join(home, ".letta", "mcp-adapter", "auth"));
  });

  it("per-server auth file stays inside auth dir for unsafe server names", () => {
    const home = tempHome();
    const paths = getOAuthStorePaths({ home, serverName: "../evil/server", serverUrl: "https://example.com/mcp" });

    expect(dirname(paths.authFile)).toBe(paths.authDir);
    expect(paths.authFile.startsWith(paths.authDir)).toBe(true);
    expect(basename(paths.authFile)).not.toContain("/");
    expect(basename(paths.authFile)).not.toContain("..");
    expect(basename(paths.authFile).endsWith(".json")).toBe(true);
  });

  it("missing store loads as null", () => {
    expect(loadOAuthStore({ home: tempHome(), serverName: "linear", serverUrl: "https://example.com/mcp" })).toBeNull();
  });

  it("saved store round-trips and creates auth directory", () => {
    const home = tempHome();
    const store = sampleStore({ tokens: { access_token: "access-token-test-value", token_type: "Bearer" } });

    saveOAuthStore({ home, serverName: "linear", serverUrl: "https://example.com/mcp", store });

    const paths = getOAuthStorePaths({ home, serverName: "linear", serverUrl: "https://example.com/mcp" });
    expect(existsSync(paths.authDir)).toBe(true);
    expect(loadOAuthStore({ home, serverName: "linear", serverUrl: "https://example.com/mcp" })).toEqual(store);
  });

  it("successful save does not leave temp files", () => {
    const home = tempHome();
    saveOAuthStore({ home, serverName: "linear", serverUrl: "https://example.com/mcp", store: sampleStore() });
    const { authDir } = getOAuthStorePaths({ home, serverName: "linear", serverUrl: "https://example.com/mcp" });

    expect(readdirSync(authDir).filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  it("malformed JSON loads as null", () => {
    const home = tempHome();
    const paths = getOAuthStorePaths({ home, serverName: "linear", serverUrl: "https://example.com/mcp" });
    saveOAuthStore({ home, serverName: "linear", serverUrl: "https://example.com/mcp", store: sampleStore() });
    writeFileSync(paths.authFile, "not json");

    expect(loadOAuthStore({ home, serverName: "linear", serverUrl: "https://example.com/mcp" })).toBeNull();
  });

  it("updateOAuthStore writes an updated store", () => {
    const home = tempHome();
    const updated = updateOAuthStore({ home, serverName: "linear", serverUrl: "https://example.com/mcp" }, (current) => ({
      ...(current ?? sampleStore()),
      authorizationUrl: "https://auth.example.com/authorize",
    }));

    expect(updated.authorizationUrl).toBe("https://auth.example.com/authorize");
    expect(loadOAuthStore({ home, serverName: "linear", serverUrl: "https://example.com/mcp" })?.authorizationUrl).toBe("https://auth.example.com/authorize");
  });

  it("clears tokens without removing client or discovery state", () => {
    const home = tempHome();
    saveOAuthStore({
      home,
      serverName: "linear",
      serverUrl: "https://example.com/mcp",
      store: sampleStore({
        clientInformation: { client_id: "client" },
        tokens: { access_token: "access-token-test-value", refresh_token: "refresh-token-test-value", token_type: "Bearer" },
        discoveryState: { authorizationServerUrl: "https://auth.example.com" },
      }),
    });

    clearOAuthCredentials({ home, serverName: "linear", serverUrl: "https://example.com/mcp", scope: "tokens" });

    const loaded = loadOAuthStore({ home, serverName: "linear", serverUrl: "https://example.com/mcp" });
    expect(loaded?.tokens).toBeUndefined();
    expect(loaded?.clientInformation).toEqual({ client_id: "client" });
    expect(loaded?.discoveryState).toEqual({ authorizationServerUrl: "https://auth.example.com" });
  });

  it("clears all sensitive fields", () => {
    const home = tempHome();
    saveOAuthStore({
      home,
      serverName: "linear",
      serverUrl: "https://example.com/mcp",
      store: sampleStore({
        state: "state",
        authorizationUrl: "https://auth.example.com/authorize",
        codeVerifier: "code-verifier-test-value",
        clientInformation: { client_id: "client" },
        tokens: { access_token: "access-token-test-value", refresh_token: "refresh-token-test-value", token_type: "Bearer" },
        discoveryState: { authorizationServerUrl: "https://auth.example.com" },
      }),
    });

    clearOAuthCredentials({ home, serverName: "linear", serverUrl: "https://example.com/mcp", scope: "all" });

    const loaded = loadOAuthStore({ home, serverName: "linear", serverUrl: "https://example.com/mcp" });
    expect(loaded).toMatchObject({ version: 1, serverName: "linear", serverUrl: "https://example.com/mcp" });
    expect(loaded?.state).toBeUndefined();
    expect(loaded?.authorizationUrl).toBeUndefined();
    expect(loaded?.codeVerifier).toBeUndefined();
    expect(loaded?.clientInformation).toBeUndefined();
    expect(loaded?.tokens).toBeUndefined();
    expect(loaded?.discoveryState).toBeUndefined();
  });
});
