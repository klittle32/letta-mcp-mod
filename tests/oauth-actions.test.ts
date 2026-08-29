import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdapterRuntime } from "../src/runtime.js";
import { executeOAuthAction } from "../src/features/oauth-actions.js";
import { getOAuthCredentials, loadOAuthStore, saveOAuthStore } from "../src/mcp/oauth-store.js";
import { startOAuthFixture } from "./helpers/oauth-fixture.js";

function tempWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "letta-mcp-oauth-actions-"));
  const home = join(root, "home");
  const cwd = join(root, "workspace");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return { home, cwd };
}

function writeConfig(cwd: string, value: unknown) {
  writeFileSync(join(cwd, ".mcp.json"), JSON.stringify(value, null, 2));
}

describe("OAuth actions", () => {
  it("requires a server name", async () => {
    const { home, cwd } = tempWorkspace();
    const runtime = createAdapterRuntime({ home });
    const state = runtime.loadState({ cwd });

    await expect(executeOAuthAction({ action: "auth-start", serverName: undefined, runtime, ctx: { cwd }, state })).resolves.toContain("server is required");
  });

  it("reports unknown, non-HTTP, non-OAuth, and missing redirect URI configuration", async () => {
    const { home, cwd } = tempWorkspace();
    writeConfig(cwd, {
      mcpServers: {
        local: { command: "node", auth: "oauth" },
        plain: { url: "http://127.0.0.1:1/mcp" },
        missingRedirect: { url: "http://127.0.0.1:1/mcp", auth: "oauth", oauth: { clientId: "client" } },
      },
    });
    const runtime = createAdapterRuntime({ home });
    const state = runtime.loadState({ cwd });

    await expect(executeOAuthAction({ action: "auth-start", serverName: "unknown", runtime, ctx: { cwd }, state })).resolves.toContain("not configured");
    await expect(executeOAuthAction({ action: "auth-start", serverName: "local", runtime, ctx: { cwd }, state })).resolves.toContain("requires an HTTP URL");
    await expect(executeOAuthAction({ action: "auth-start", serverName: "plain", runtime, ctx: { cwd }, state })).resolves.toContain("OAuth is not configured");
    await expect(executeOAuthAction({ action: "auth-start", serverName: "missingRedirect", runtime, ctx: { cwd }, state })).resolves.toContain("redirectUri");
  });

  it("starts OAuth, persists pending state, and returns manual completion instructions", async () => {
    const fixture = await startOAuthFixture();
    const { home, cwd } = tempWorkspace();
    try {
      writeConfig(cwd, {
        mcpServers: {
          linear: {
            url: fixture.url,
            auth: "oauth",
            oauth: { clientId: "client-id", clientSecret: "client-secret-test-value", redirectUri: fixture.redirectUri, scope: "read write" },
          },
        },
      });
      const runtime = createAdapterRuntime({ home, now: () => 123 });
      const state = runtime.loadState({ cwd });

      const output = await executeOAuthAction({ action: "auth-start", serverName: "linear", runtime, ctx: { cwd }, state });

      expect(output).toContain("OAuth authorization started for \"linear\"");
      expect(output).toContain(`${fixture.origin}/authorize?`);
      expect(output).toContain("/toolbox auth-complete linear <full redirected URL>");
      expect(output).not.toContain("client-secret-test-value");
      const store = loadOAuthStore({ home, serverName: "linear", serverUrl: fixture.url });
      expect(store?.state).toBeTruthy();
      expect(store?.codeVerifier).toBeTruthy();
      expect(store?.authorizationUrl).toContain(`${fixture.origin}/authorize?`);
      expect(new URL(store!.authorizationUrl!).searchParams.get("resource")).toBe(fixture.url);
      expect((await fixture.observations()).resourceMetadataRequests).toEqual(["/.well-known/oauth-protected-resource"]);
    } finally {
      await fixture.stop();
    }
  });

  it("auth-complete exchanges a valid redirect, persists tokens, and suggests reconnect", async () => {
    const fixture = await startOAuthFixture();
    const { home, cwd } = tempWorkspace();
    try {
      writeConfig(cwd, {
        mcpServers: {
          linear: {
            url: fixture.url,
            auth: "oauth",
            oauth: { clientId: "client-id", clientSecret: "client-secret-test-value", redirectUri: fixture.redirectUri, scope: "read write" },
          },
        },
      });
      const runtime = createAdapterRuntime({ home, now: () => 123 });
      const state = runtime.loadState({ cwd });
      await executeOAuthAction({ action: "auth-start", serverName: "linear", runtime, ctx: { cwd }, state });
      const authorizationUrl = loadOAuthStore({ home, serverName: "linear", serverUrl: fixture.url })?.authorizationUrl;
      const redirectUrl = await fixture.authorize(authorizationUrl!);

      const output = await executeOAuthAction({
        action: "auth-complete",
        serverName: "linear",
        rawArgs: JSON.stringify({ redirectUrl }),
        runtime,
        ctx: { cwd },
        state,
      });

      expect(output).toContain("OAuth authorization complete for \"linear\"");
      expect(output).toContain("/toolbox reconnect linear");
      expect(output).not.toContain("fixture-access-token");
      expect(output).not.toContain("fixture-refresh-token");
      expect(output).not.toContain("client-secret-test-value");
      const store = loadOAuthStore({ home, serverName: "linear", serverUrl: fixture.url });
      expect(getOAuthCredentials(store)?.tokens).toMatchObject({
        access_token: "fixture-access-token",
        refresh_token: "fixture-refresh-token",
        issuer: fixture.origin,
      });
      expect((await fixture.observations()).tokenRequests[0]).toMatchObject({ resource: fixture.url });
    } finally {
      await fixture.stop();
    }
  });

  it("auth-complete handles invalid JSON, missing redirect, OAuth errors, and state mismatch", async () => {
    const fixture = await startOAuthFixture();
    const { home, cwd } = tempWorkspace();
    try {
      writeConfig(cwd, {
        mcpServers: {
          linear: { url: fixture.url, auth: "oauth", oauth: { clientId: "client-id", clientSecret: "client-secret-test-value", redirectUri: fixture.redirectUri } },
        },
      });
      const runtime = createAdapterRuntime({ home });
      const state = runtime.loadState({ cwd });
      await executeOAuthAction({ action: "auth-start", serverName: "linear", runtime, ctx: { cwd }, state });

      await expect(executeOAuthAction({ action: "auth-complete", serverName: "linear", rawArgs: "not json", runtime, ctx: { cwd }, state })).resolves.toContain("valid JSON");
      await expect(executeOAuthAction({ action: "auth-complete", serverName: "linear", rawArgs: "{}", runtime, ctx: { cwd }, state })).resolves.toContain("redirectUrl");
      await expect(executeOAuthAction({ action: "auth-complete", serverName: "linear", rawArgs: JSON.stringify({ redirectUrl: `${fixture.redirectUri}?error=access_denied&error_description=Nope` }), runtime, ctx: { cwd }, state })).resolves.toContain("access_denied");
      await expect(executeOAuthAction({ action: "auth-complete", serverName: "linear", rawArgs: JSON.stringify({ redirectUrl: `${fixture.redirectUri}?code=authorization-code-test-value&state=wrong` }), runtime, ctx: { cwd }, state })).resolves.toContain("state mismatch");
      expect(getOAuthCredentials(loadOAuthStore({ home, serverName: "linear", serverUrl: fixture.url }))?.tokens).toBeUndefined();
    } finally {
      await fixture.stop();
    }
  });

  it("rejects a mismatched authorization-response issuer without redeeming or echoing it", async () => {
    const fixture = await startOAuthFixture();
    const { home, cwd } = tempWorkspace();
    try {
      writeConfig(cwd, {
        mcpServers: {
          linear: {
            url: fixture.url,
            auth: "oauth",
            oauth: { clientId: "client-id", clientSecret: "client-secret-test-value", redirectUri: fixture.redirectUri },
          },
        },
      });
      const runtime = createAdapterRuntime({ home });
      const state = runtime.loadState({ cwd });
      await executeOAuthAction({ action: "auth-start", serverName: "linear", runtime, ctx: { cwd }, state });
      const authorizationUrl = loadOAuthStore({ home, serverName: "linear", serverUrl: fixture.url })!.authorizationUrl!;
      const redirectUrl = new URL(await fixture.authorize(authorizationUrl));
      redirectUrl.searchParams.set("iss", "https://attacker.invalid/issuer");

      const output = await executeOAuthAction({
        action: "auth-complete",
        serverName: "linear",
        rawArgs: JSON.stringify({ redirectUrl: redirectUrl.toString() }),
        runtime,
        ctx: { cwd },
        state,
      });

      expect(output).toContain("authorization-server issuer mismatch");
      expect(output).not.toContain("attacker.invalid");
      expect((await fixture.observations()).tokenRequests).toEqual([]);
      expect(getOAuthCredentials(loadOAuthStore({ home, serverName: "linear", serverUrl: fixture.url }))?.tokens).toBeUndefined();
    } finally {
      await fixture.stop();
    }
  });

  it("prefers CIMD when advertised and falls back to native DCR", async () => {
    const fixture = await startOAuthFixture();
    const { home, cwd } = tempWorkspace();
    try {
      writeConfig(cwd, {
        mcpServers: {
          cimd: {
            url: fixture.url,
            auth: "oauth",
            oauth: {
              redirectUri: fixture.redirectUri,
              clientMetadataUrl: "https://client.example.com/oauth/client.json",
            },
          },
        },
      });
      const runtime = createAdapterRuntime({ home });
      let state = runtime.loadState({ cwd });

      await executeOAuthAction({ action: "auth-start", serverName: "cimd", runtime, ctx: { cwd }, state });

      const cimdStore = loadOAuthStore({ home, serverName: "cimd", serverUrl: fixture.url });
      expect(new URL(cimdStore!.authorizationUrl!).searchParams.get("client_id")).toBe("https://client.example.com/oauth/client.json");
      expect((await fixture.observations()).registrations).toEqual([]);

      writeConfig(cwd, {
        mcpServers: {
          dcr: {
            url: fixture.url,
            auth: "oauth",
            oauth: { redirectUri: fixture.redirectUri },
          },
        },
      });
      state = runtime.loadState({ cwd });
      await executeOAuthAction({ action: "auth-start", serverName: "dcr", runtime, ctx: { cwd }, state });

      const dcrStore = loadOAuthStore({ home, serverName: "dcr", serverUrl: fixture.url });
      expect(new URL(dcrStore!.authorizationUrl!).searchParams.get("client_id")).toBe("fixture-dynamic-client");
      expect((await fixture.observations()).registrations).toContainEqual(expect.objectContaining({
        application_type: "native",
      }));
    } finally {
      await fixture.stop();
    }
  });

  it("auth-start supports client_credentials by fetching and storing a token", async () => {
    const fixture = await startOAuthFixture();
    const { home, cwd } = tempWorkspace();
    try {
      writeConfig(cwd, {
        mcpServers: {
          machine: {
            url: fixture.url,
            auth: "oauth",
            oauth: {
              grantType: "client_credentials",
              clientId: "client-id",
              clientSecret: "client-secret-test-value",
              scope: "read",
            },
          },
        },
      });
      const runtime = createAdapterRuntime({ home, now: () => 123 });
      const state = runtime.loadState({ cwd });

      const output = await executeOAuthAction({ action: "auth-start", serverName: "machine", runtime, ctx: { cwd }, state });

      expect(output).toContain('OAuth client_credentials token stored for "machine"');
      expect(output).toContain("/toolbox reconnect machine");
      expect(output).not.toContain("fixture-client-credentials-token");
      expect(output).not.toContain("client-secret-test-value");
      const store = loadOAuthStore({ home, serverName: "machine", serverUrl: fixture.url });
      expect(getOAuthCredentials(store)?.tokens).toMatchObject({
        access_token: "fixture-client-credentials-token",
        token_type: "Bearer",
        scope: "read",
        issuer: fixture.origin,
      });
      expect((await fixture.observations()).tokenRequests[0]).toMatchObject({
        grant_type: "client_credentials",
        resource: fixture.url,
        scope: "read",
      });

      const refreshed = await runtime.connectAndRefresh({ cwd }, "machine");
      expect(refreshed.tools.map((tool) => tool.name)).toContain("echo");
    } finally {
      await fixture.stop();
    }
  });

  it("client_credentials reports missing required configuration", async () => {
    const { home, cwd } = tempWorkspace();
    writeConfig(cwd, {
      mcpServers: {
        machine: { url: "http://127.0.0.1:1/mcp", auth: "oauth", oauth: { grantType: "client_credentials", clientId: "client-id" } },
      },
    });
    const runtime = createAdapterRuntime({ home });
    const state = runtime.loadState({ cwd });

    await expect(executeOAuthAction({ action: "auth-start", serverName: "machine", runtime, ctx: { cwd }, state })).resolves.toContain("oauth.clientSecret");
  });

  it("auth-clear removes persisted OAuth credentials for a server", async () => {
    const { home, cwd } = tempWorkspace();
    writeConfig(cwd, {
      mcpServers: {
        linear: { url: "http://127.0.0.1:1/mcp", auth: "oauth", oauth: { clientId: "client-id", redirectUri: "http://127.0.0.1:3334/callback" } },
      },
    });
    saveOAuthStore({
      home,
      serverName: "linear",
      serverUrl: "http://127.0.0.1:1/mcp",
      store: {
        version: 2,
        serverName: "linear",
        serverUrl: "http://127.0.0.1:1/mcp",
        updatedAt: 1,
        state: "state-test-value",
        authorizationUrl: "http://auth.example/authorize",
        codeVerifier: "verifier-test-value",
        discoveryState: { authorizationServerUrl: "http://auth.example" },
        activeIssuer: "http://auth.example",
        credentials: {
          "http://auth.example": {
            clientInformation: {
              client_id: "client-id",
              client_secret: "client-secret-test-value",
              issuer: "http://auth.example",
            },
            tokens: {
              access_token: "access-token-test-value",
              refresh_token: "refresh-token-test-value",
              token_type: "Bearer",
              issuer: "http://auth.example",
            },
          },
        },
      },
    });
    const runtime = createAdapterRuntime({ home });
    const state = runtime.loadState({ cwd });

    const output = await executeOAuthAction({ action: "auth-clear", serverName: "linear", runtime, ctx: { cwd }, state });

    expect(output).toContain('OAuth credentials cleared for "linear"');
    expect(output).not.toContain("access-token-test-value");
    expect(output).not.toContain("client-secret-test-value");
    const store = loadOAuthStore({ home, serverName: "linear", serverUrl: "http://127.0.0.1:1/mcp" });
    expect(store?.state).toBeUndefined();
    expect(store?.authorizationUrl).toBeUndefined();
    expect(store?.codeVerifier).toBeUndefined();
    expect(store?.credentials).toEqual({});
    expect(store?.discoveryState).toBeUndefined();
  });
});
