import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getMetadataCachePath, loadMetadataCache } from "../src/core/cache.js";
import { executeSearch } from "../src/features/tool-catalog.js";
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
    writeConfig(cwd, { remote: { url: fixture.url, protocolVersion: "auto" } });
    const runtime = createAdapterRuntime({ home, now: () => 1234, timeoutMs: 2_000 });
    try {
      const result = await runtime.connectAndRefresh({ cwd, signal: new AbortController().signal }, "remote");

      expect(result.tools.map((tool) => tool.name)).toEqual(["echo", "headers_seen", "fail_soft"]);
      expect(result.resources.map((resource) => resource.uri)).toEqual(["fixture://http-readme"]);
      expect(result.cachePath).toBe(getMetadataCachePath(home));
      expect(result.state.servers.get("remote")?.cacheEntry).toMatchObject({
        cachedAt: 1234,
        ttlMs: 60_000,
        cacheScope: "private",
      });
      expect(result.state.servers.get("remote")?.tools.find((tool) => tool.originalName === "echo")).toMatchObject({
        title: "HTTP Echo",
        annotations: { readOnlyHint: true, destructiveHint: false },
        icons: [{ src: "https://example.test/echo.svg", mimeType: "image/svg+xml" }],
      });
      expect(runtime.loadState({ cwd }).servers.get("remote")?.tools.map((tool) => tool.name)).toContain("remote_echo");
    } finally {
      await runtime.closeAll();
      await fixture.stop();
    }
  });

  it("catalog search uses refreshed HTTP cache", async () => {
    const fixture = await startHttpFixture(join(process.cwd(), "tests/fixtures/http-streamable-fixture.mjs"));
    const { home, cwd } = tempWorkspace();
    writeConfig(cwd, { remote: { url: fixture.url } });
    const runtime = createAdapterRuntime({ home, now: () => 1_000, timeoutMs: 2_000 });
    try {
      const ctx = { cwd, signal: new AbortController().signal };
      const connected = await runtime.connectAndRefresh(ctx, "remote");
      const searched = executeSearch(runtime.loadState(ctx), { query: "echo" });

      expect(connected.tools).toHaveLength(3);
      expect(connected.resources).toHaveLength(1);
      expect(searched).toContain("remote_echo");
      expect(searched).toContain("HTTP Echo");
      expect(searched).toContain("read-only");
    } finally {
      await runtime.closeAll();
      await fixture.stop();
    }
  });

  it("uses the disk-cached tool definition for SDK x-mcp-header mirroring", async () => {
    const fixture = await startHttpFixture(join(process.cwd(), "tests/fixtures/http-streamable-fixture.mjs"));
    const { home, cwd } = tempWorkspace();
    writeConfig(cwd, { remote: { url: fixture.url, protocolVersion: "auto" } });
    const firstRuntime = createAdapterRuntime({ home, timeoutMs: 2_000 });
    const secondRuntime = createAdapterRuntime({ home, timeoutMs: 2_000 });
    try {
      await firstRuntime.connectAndRefresh({ cwd }, "remote");
      await firstRuntime.closeAll();

      const result = await secondRuntime.callTool(
        { cwd },
        secondRuntime.loadState({ cwd }),
        "remote_headers_seen",
        { trace: "trace-value" },
      );

      expect(result).toMatchObject({ ok: true });
      if (result.ok) expect(result.output).toContain('"param":"trace-value"');
    } finally {
      await firstRuntime.closeAll();
      await secondRuntime.closeAll();
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

  it("private HTTP cache selection isolates bearer identities", async () => {
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
      expect(stale?.cacheEntry).toBeUndefined();
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
