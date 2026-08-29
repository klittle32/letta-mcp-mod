import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  clearOAuthCredentials,
  getOAuthCredentials,
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
    version: 2,
    serverName: "linear",
    serverUrl: "https://example.com/mcp",
    updatedAt: 123,
    credentials: {},
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
    const store = sampleStore({
      activeIssuer: "https://auth.example.com",
      credentials: {
        "https://auth.example.com": {
          tokens: {
            access_token: "access-token-test-value",
            token_type: "Bearer",
            issuer: "https://auth.example.com",
          },
        },
      },
    });

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
        activeIssuer: "https://auth.example.com",
        credentials: {
          "https://auth.example.com": {
            clientInformation: { client_id: "client", issuer: "https://auth.example.com" },
            tokens: {
              access_token: "access-token-test-value",
              refresh_token: "refresh-token-test-value",
              token_type: "Bearer",
              issuer: "https://auth.example.com",
            },
          },
        },
        discoveryState: { authorizationServerUrl: "https://auth.example.com" },
      }),
    });

    clearOAuthCredentials({ home, serverName: "linear", serverUrl: "https://example.com/mcp", scope: "tokens" });

    const loaded = loadOAuthStore({ home, serverName: "linear", serverUrl: "https://example.com/mcp" });
    expect(getOAuthCredentials(loaded)?.tokens).toBeUndefined();
    expect(getOAuthCredentials(loaded)?.clientInformation).toEqual({
      client_id: "client",
      issuer: "https://auth.example.com",
    });
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
        activeIssuer: "https://auth.example.com",
        credentials: {
          "https://auth.example.com": {
            clientInformation: { client_id: "client", issuer: "https://auth.example.com" },
            tokens: {
              access_token: "access-token-test-value",
              refresh_token: "refresh-token-test-value",
              token_type: "Bearer",
              issuer: "https://auth.example.com",
            },
          },
        },
        discoveryState: { authorizationServerUrl: "https://auth.example.com" },
      }),
    });

    clearOAuthCredentials({ home, serverName: "linear", serverUrl: "https://example.com/mcp", scope: "all" });

    const loaded = loadOAuthStore({ home, serverName: "linear", serverUrl: "https://example.com/mcp" });
    expect(loaded).toMatchObject({ version: 2, serverName: "linear", serverUrl: "https://example.com/mcp", credentials: {} });
    expect(loaded?.state).toBeUndefined();
    expect(loaded?.authorizationUrl).toBeUndefined();
    expect(loaded?.codeVerifier).toBeUndefined();
    expect(getOAuthCredentials(loaded)?.clientInformation).toBeUndefined();
    expect(getOAuthCredentials(loaded)?.tokens).toBeUndefined();
    expect(loaded?.discoveryState).toBeUndefined();
  });

  it("migrates issuer-bound version 1 credentials once", () => {
    const home = tempHome();
    const options = { home, serverName: "linear", serverUrl: "https://example.com/mcp" };
    const paths = getOAuthStorePaths(options);
    saveOAuthStore({ ...options, store: sampleStore() });
    writeFileSync(paths.authFile, JSON.stringify({
      version: 1,
      serverName: "linear",
      serverUrl: "https://example.com/mcp",
      updatedAt: 123,
      state: "pending-state",
      clientInformation: { client_id: "legacy-client" },
      tokens: { access_token: "legacy-token", token_type: "Bearer" },
      discoveryState: { authorizationServerUrl: "https://auth.example.com/" },
    }));

    const migrated = loadOAuthStore(options);

    expect(migrated).toMatchObject({
      version: 2,
      activeIssuer: "https://auth.example.com/",
      state: "pending-state",
    });
    expect(getOAuthCredentials(migrated, "https://auth.example.com")).toEqual({
      clientInformation: { client_id: "legacy-client", issuer: "https://auth.example.com/" },
      tokens: { access_token: "legacy-token", token_type: "Bearer", issuer: "https://auth.example.com/" },
    });
    expect(JSON.parse(readFileSync(paths.authFile, "utf8")).version).toBe(2);
  });

  it("drops unbound version 1 credentials instead of guessing an issuer", () => {
    const home = tempHome();
    const options = { home, serverName: "linear", serverUrl: "https://example.com/mcp" };
    const paths = getOAuthStorePaths(options);
    saveOAuthStore({ ...options, store: sampleStore() });
    writeFileSync(paths.authFile, JSON.stringify({
      version: 1,
      serverName: "linear",
      serverUrl: "https://example.com/mcp",
      updatedAt: 123,
      codeVerifier: "pending-verifier",
      tokens: { access_token: "unbound-token", token_type: "Bearer" },
    }));

    const migrated = loadOAuthStore(options);

    expect(migrated?.credentials).toEqual({});
    expect(migrated?.codeVerifier).toBe("pending-verifier");
  });
});
