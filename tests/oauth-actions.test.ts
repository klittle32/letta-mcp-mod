import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdapterRuntime } from "../src/runtime.js";
import { executeOAuthAction } from "../src/features/oauth-actions.js";
import { loadOAuthStore } from "../src/mcp/oauth-store.js";
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
      expect(output).toContain('mcp({ action: "auth-complete", server: "linear"');
      expect(output).not.toContain("client-secret-test-value");
      const store = loadOAuthStore({ home, serverName: "linear", serverUrl: fixture.url });
      expect(store?.state).toBeTruthy();
      expect(store?.codeVerifier).toBeTruthy();
      expect(store?.authorizationUrl).toContain(`${fixture.origin}/authorize?`);
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
      expect(output).toContain('mcp({ connect: "linear" })');
      expect(output).not.toContain("fixture-access-token");
      expect(output).not.toContain("fixture-refresh-token");
      expect(output).not.toContain("client-secret-test-value");
      const store = loadOAuthStore({ home, serverName: "linear", serverUrl: fixture.url });
      expect(store?.tokens).toMatchObject({ access_token: "fixture-access-token", refresh_token: "fixture-refresh-token" });
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
      expect(loadOAuthStore({ home, serverName: "linear", serverUrl: fixture.url })?.tokens).toBeUndefined();
    } finally {
      await fixture.stop();
    }
  });
});
