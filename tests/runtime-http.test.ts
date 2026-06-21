import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getMetadataCachePath, loadMetadataCache } from "../src/core/cache.js";
import { executeMcpProxy } from "../src/features/proxy-tool.js";
import { createAdapterRuntime } from "../src/runtime.js";
import { startHttpFixture } from "./helpers/http-fixture.js";

function tempWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "letta-mcp-runtime-http-"));
  const home = join(root, "home");
  const cwd = join(root, "workspace");
  mkdirSync(cwd, { recursive: true });
  return { root, home, cwd };
}

function writeConfig(cwd: string, mcpServers: Record<string, unknown>) {
  writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers }, null, 2));
}

describe("adapter runtime HTTP integration", () => {
  it("connectAndRefresh against streamable HTTP fixture caches tools/resources", async () => {
    const fixture = await startHttpFixture(join(process.cwd(), "tests/fixtures/http-streamable-fixture.mjs"));
    const { home, cwd } = tempWorkspace();
    writeConfig(cwd, { remote: { url: fixture.url } });
    const runtime = createAdapterRuntime({ home, now: () => 1234, timeoutMs: 2_000 });
    try {
      const result = await runtime.connectAndRefresh({ cwd, args: { connect: "remote" }, signal: new AbortController().signal }, "remote");

      expect(result.tools.map((tool) => tool.name)).toEqual(["echo", "headers_seen", "fail_soft"]);
      expect(result.resources.map((resource) => resource.uri)).toEqual(["fixture://http-readme"]);
      expect(result.cachePath).toBe(getMetadataCachePath(home));
      expect(loadMetadataCache({ home })?.servers.remote.cachedAt).toBe(1234);
      expect(runtime.loadState({ cwd }).servers.get("remote")?.tools.map((tool) => tool.name)).toContain("remote_echo");
    } finally {
      await runtime.closeAll();
      await fixture.stop();
    }
  });

  it("mcp connect/search uses refreshed HTTP cache", async () => {
    const fixture = await startHttpFixture(join(process.cwd(), "tests/fixtures/http-streamable-fixture.mjs"));
    const { home, cwd } = tempWorkspace();
    writeConfig(cwd, { remote: { url: fixture.url } });
    const runtime = createAdapterRuntime({ home, now: () => 1_000, timeoutMs: 2_000 });
    try {
      const ctx = { cwd, args: {}, signal: new AbortController().signal };
      const connected = await executeMcpProxy({ connect: "remote" }, runtime.loadState(ctx), runtime, { ...ctx, args: { connect: "remote" } });
      const searched = executeMcpProxy({ search: "echo" }, runtime.loadState(ctx));

      expect(connected).toContain('Connected to "remote" and cached 3 tools, 1 resource.');
      expect(connected).toContain("- remote_echo - Echo a message over HTTP");
      expect(searched).toContain("remote_echo");
    } finally {
      await runtime.closeAll();
      await fixture.stop();
    }
  });

  it("config hash invalidates HTTP cache when URL changes", async () => {
    const fixture = await startHttpFixture(join(process.cwd(), "tests/fixtures/http-streamable-fixture.mjs"));
    const { home, cwd } = tempWorkspace();
    writeConfig(cwd, { remote: { url: fixture.url } });
    const runtime = createAdapterRuntime({ home, now: () => 1_000, timeoutMs: 2_000 });
    try {
      await runtime.connectAndRefresh({ cwd }, "remote");
      expect(runtime.loadState({ cwd }).servers.get("remote")?.cacheValid).toBe(true);

      writeConfig(cwd, { remote: { url: "http://127.0.0.1:9/mcp" } });
      const stale = runtime.loadState({ cwd }).servers.get("remote");

      expect(stale?.cacheEntry).toBeDefined();
      expect(stale?.cacheValid).toBe(false);
      expect(stale?.tools).toEqual([]);
    } finally {
      await runtime.closeAll();
      await fixture.stop();
    }
  });

  it("config hash invalidates HTTP cache when bearer env value changes", async () => {
    const fixture = await startHttpFixture(join(process.cwd(), "tests/fixtures/http-streamable-fixture.mjs"), { env: { REQUIRE_BEARER: "one" } });
    const { home, cwd } = tempWorkspace();
    writeConfig(cwd, { remote: { url: fixture.url, auth: "bearer", bearerTokenEnv: "MY_TOKEN" } });
    const runtimeOne = createAdapterRuntime({ home, env: { MY_TOKEN: "one" }, now: () => 1_000, timeoutMs: 2_000 });
    try {
      await runtimeOne.connectAndRefresh({ cwd }, "remote");
      expect(runtimeOne.loadState({ cwd }).servers.get("remote")?.cacheValid).toBe(true);
    } finally {
      await runtimeOne.closeAll();
      await fixture.stop();
    }

    const runtimeTwo = createAdapterRuntime({ home, env: { MY_TOKEN: "two" }, now: () => 1_000, timeoutMs: 2_000 });
    try {
      const stale = runtimeTwo.loadState({ cwd }).servers.get("remote");
      expect(stale?.cacheEntry).toBeDefined();
      expect(stale?.cacheValid).toBe(false);
      expect(stale?.tools).toEqual([]);
    } finally {
      await runtimeTwo.closeAll();
    }
  });

  it("failed HTTP auth does not write successful metadata cache", async () => {
    const fixture = await startHttpFixture(join(process.cwd(), "tests/fixtures/http-streamable-fixture.mjs"), { env: { REQUIRE_BEARER: "expected" } });
    const { home, cwd } = tempWorkspace();
    writeConfig(cwd, { remote: { url: fixture.url, auth: "bearer", bearerToken: "wrong" } });
    const runtime = createAdapterRuntime({ home, timeoutMs: 2_000 });
    try {
      await expect(runtime.connectAndRefresh({ cwd }, "remote")).rejects.toThrow(/Failed to connect to "remote"/);

      expect(loadMetadataCache({ home })?.servers.remote).toBeUndefined();
      expect(runtime.loadState({ cwd }).servers.get("remote")?.tools).toEqual([]);
    } finally {
      await runtime.closeAll();
      await fixture.stop();
    }
  });
});
