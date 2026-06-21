import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeServerHash, loadMetadataCache } from "../src/core/cache.js";
import { executeMcpProxy } from "../src/features/proxy-tool.js";
import { loadOAuthStore } from "../src/mcp/oauth-store.js";
import { createAdapterRuntime } from "../src/runtime.js";
import { startOAuthFixture } from "./helpers/oauth-fixture.js";

function tempWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "letta-mcp-runtime-oauth-"));
  const home = join(root, "home");
  const cwd = join(root, "workspace");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return { home, cwd };
}

function writeConfig(cwd: string, fixture: { url: string; redirectUri: string }, oauth: Record<string, unknown> = {}) {
  writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({
    mcpServers: {
      remote: {
        url: fixture.url,
        auth: "oauth",
        oauth: { clientId: "client-id", clientSecret: "client-secret-test-value", redirectUri: fixture.redirectUri, ...oauth },
      },
    },
  }, null, 2));
}

describe("adapter runtime OAuth integration", () => {
  it("connect before auth returns auth-required guidance and does not write metadata cache", async () => {
    const fixture = await startOAuthFixture();
    const { home, cwd } = tempWorkspace();
    writeConfig(cwd, fixture);
    const runtime = createAdapterRuntime({ home, timeoutMs: 2_000 });
    try {
      const ctx = { cwd, args: { connect: "remote" }, signal: new AbortController().signal };
      const output = await executeMcpProxy({ connect: "remote" }, runtime.loadState(ctx), runtime, ctx);

      expect(output).toContain('Failed to connect to "remote"');
      expect(output).toMatch(/Unauthorized|auth-start|authorization/i);
      expect(loadMetadataCache({ home })?.servers.remote).toBeUndefined();
      expect(loadOAuthStore({ home, serverName: "remote", serverUrl: fixture.url })?.authorizationUrl).toContain(`${fixture.origin}/authorize?`);
    } finally {
      await runtime.closeAll();
      await fixture.stop();
    }
  });

  it("auth-complete enables connectAndRefresh and cached tool calls", async () => {
    const fixture = await startOAuthFixture();
    const { home, cwd } = tempWorkspace();
    writeConfig(cwd, fixture, { scope: "read write" });
    const runtime = createAdapterRuntime({ home, now: () => 1234, timeoutMs: 2_000 });
    try {
      const startArgs = { action: "auth-start", server: "remote" };
      const start = await executeMcpProxy(startArgs, runtime.loadState({ cwd, args: startArgs }), runtime, { cwd, args: startArgs });
      expect(start).toContain("OAuth authorization started");
      const authorizationUrl = loadOAuthStore({ home, serverName: "remote", serverUrl: fixture.url })?.authorizationUrl;
      const redirectUrl = await fixture.authorize(authorizationUrl!);
      const completeArgs = { action: "auth-complete", server: "remote", args: JSON.stringify({ redirectUrl }) };
      const complete = await executeMcpProxy(completeArgs, runtime.loadState({ cwd, args: completeArgs }), runtime, { cwd, args: completeArgs });
      expect(complete).toContain("OAuth authorization complete");
      expect(loadOAuthStore({ home, serverName: "remote", serverUrl: fixture.url })?.tokens?.access_token).toBe("fixture-access-token");

      const refreshed = await runtime.connectAndRefresh({ cwd, args: { connect: "remote" } }, "remote");
      expect(refreshed.tools.map((tool) => tool.name)).toEqual(["echo", "headers_seen"]);
      expect(loadMetadataCache({ home })?.servers.remote.cachedAt).toBe(1234);

      const cachedState = runtime.loadState({ cwd });
      expect(cachedState.servers.get("remote")?.tools.map((tool) => tool.name)).toContain("remote_echo");
      const called = await runtime.callTool({ cwd, args: { tool: "remote_echo" } }, cachedState, "remote_echo", JSON.stringify({ message: "hello oauth" }));
      expect(called).toMatchObject({ ok: true, output: "hello oauth" });
    } finally {
      await runtime.closeAll();
      await fixture.stop();
    }
  });

  it("OAuth config changes invalidate metadata cache without considering stored tokens", async () => {
    const fixture = await startOAuthFixture();
    const { home, cwd } = tempWorkspace();
    writeConfig(cwd, fixture, { scope: "read" });
    const runtime = createAdapterRuntime({ home, timeoutMs: 2_000 });
    try {
      const startArgs = { action: "auth-start", server: "remote" };
      await executeMcpProxy(startArgs, runtime.loadState({ cwd, args: startArgs }), runtime, { cwd, args: startArgs });
      const redirectUrl = await fixture.authorize(loadOAuthStore({ home, serverName: "remote", serverUrl: fixture.url })!.authorizationUrl!);
      const completeArgs = { action: "auth-complete", server: "remote", args: JSON.stringify({ redirectUrl }) };
      await executeMcpProxy(completeArgs, runtime.loadState({ cwd, args: completeArgs }), runtime, { cwd, args: completeArgs });
      await runtime.connectAndRefresh({ cwd }, "remote");
      const cache = loadMetadataCache({ home })!;
      expect(cache.servers.remote.configHash).toBe(computeServerHash({ url: fixture.url, auth: "oauth", oauth: { clientId: "client-id", clientSecret: "client-secret-test-value", redirectUri: fixture.redirectUri, scope: "read" } }));

      writeConfig(cwd, fixture, { scope: "write" });
      const stale = runtime.loadState({ cwd }).servers.get("remote");
      expect(stale?.cacheEntry).toBeDefined();
      expect(stale?.cacheValid).toBe(false);
      expect(stale?.tools).toEqual([]);
    } finally {
      await runtime.closeAll();
      await fixture.stop();
    }
  });
});
