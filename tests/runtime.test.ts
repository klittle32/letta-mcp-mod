import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMetadataCachePath, loadMetadataCache } from "../src/core/cache.js";
import { createAdapterRuntime } from "../src/runtime.js";
import { startHttpFixture } from "./helpers/http-fixture.js";

function tempWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "letta-mcp-runtime-"));
  const home = join(root, "home");
  const cwd = join(root, "workspace");
  return { root, home, cwd };
}

function writeWorkspaceConfig(cwd: string) {
  writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({
    mcpServers: {
      fixture: {
        command: process.execPath,
        args: [join(process.cwd(), "tests/fixtures/stdio-mcp-fixture.mjs")],
      },
    },
  }, null, 2));
}

function writeHttpConfig(cwd: string, url: string, extra: Record<string, unknown> = {}) {
  writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({
    mcpServers: {
      remote: { url, ...extra },
    },
  }, null, 2));
}

async function fixtureStats(url: string): Promise<{
  methods: Record<string, number>;
  requestIds: Array<string | number>;
  dropped: boolean;
}> {
  const response = await fetch(new URL("/stats", url));
  return response.json() as Promise<{
    methods: Record<string, number>;
    requestIds: Array<string | number>;
    dropped: boolean;
  }>;
}

describe("adapter runtime", () => {
  it("loadState reads config/cache but does not connect", async () => {
    const { home, cwd } = tempWorkspace();
    await import("node:fs").then(({ mkdirSync }) => mkdirSync(cwd, { recursive: true }));
    writeWorkspaceConfig(cwd);
    const runtime = createAdapterRuntime({ home });

    const state = runtime.loadState({ cwd, signal: new AbortController().signal });

    expect(state.servers.get("fixture")?.cacheEntry).toBeUndefined();
    expect(runtime.manager.getConnection("fixture")).toBeUndefined();
    await runtime.closeAll();
  });

  it("connectAndRefresh connects, discovers metadata, updates cache object, and saves cache", async () => {
    const { home, cwd } = tempWorkspace();
    await import("node:fs").then(({ mkdirSync }) => mkdirSync(cwd, { recursive: true }));
    writeWorkspaceConfig(cwd);
    const runtime = createAdapterRuntime({ home, now: () => 1234, timeoutMs: 2_000 });

    const result = await runtime.connectAndRefresh({ cwd, signal: new AbortController().signal }, "fixture");

    expect(result.serverName).toBe("fixture");
    expect(result.tools.map((tool) => tool.name)).toEqual(["echo", "list_items", "structured_status", "fail_soft", "throw_error"]);
    expect(result.resources.map((resource) => resource.uri)).toEqual(["fixture://readme", "fixture://blob"]);
    expect(result.cachePath).toBe(getMetadataCachePath(home));
    expect(loadMetadataCache({ home })?.servers.fixture.cachedAt).toBe(1234);
    expect(runtime.loadState({ cwd }).servers.get("fixture")?.tools.map((tool) => tool.name)).toContain("fixture_echo");
    await runtime.closeAll();
  });

  it("reloads config per invocation", async () => {
    const { home, cwd } = tempWorkspace();
    await import("node:fs").then(({ mkdirSync }) => mkdirSync(cwd, { recursive: true }));
    const runtime = createAdapterRuntime({ home });

    expect(runtime.loadState({ cwd }).servers.size).toBe(0);
    writeWorkspaceConfig(cwd);
    expect(runtime.loadState({ cwd }).servers.size).toBe(1);
    await runtime.closeAll();
  });

  it("closeAll delegates to manager and is safe to call multiple times", async () => {
    const { home, cwd } = tempWorkspace();
    await import("node:fs").then(({ mkdirSync }) => mkdirSync(cwd, { recursive: true }));
    writeWorkspaceConfig(cwd);
    const runtime = createAdapterRuntime({ home, timeoutMs: 2_000 });

    await runtime.connectAndRefresh({ cwd }, "fixture");
    expect(runtime.manager.getConnection("fixture")?.status).toBe("connected");

    await runtime.closeAll();
    await runtime.closeAll();

    expect(runtime.manager.getConnection("fixture")).toBeUndefined();
  });

  it("caches auto negotiation and invalidates it when connection configuration changes", async () => {
    const fixture = await startHttpFixture(join(process.cwd(), "tests/fixtures/http-streamable-fixture.mjs"));
    const { home, cwd } = tempWorkspace();
    mkdirSync(cwd, { recursive: true });
    writeHttpConfig(cwd, fixture.url, { protocolVersion: "auto" });
    const firstRuntime = createAdapterRuntime({ home, timeoutMs: 2_000 });
    const secondRuntime = createAdapterRuntime({ home, timeoutMs: 2_000 });
    const thirdRuntime = createAdapterRuntime({ home, timeoutMs: 2_000 });
    try {
      await firstRuntime.connectAndRefresh({ cwd }, "remote");
      await firstRuntime.closeAll();
      expect(loadMetadataCache({ home })?.servers.remote.protocol?.era).toBe("modern");
      expect((await fixtureStats(fixture.url)).methods["server/discover"]).toBe(1);

      await secondRuntime.connectAndRefresh({ cwd }, "remote");
      await secondRuntime.closeAll();
      expect((await fixtureStats(fixture.url)).methods["server/discover"]).toBe(1);

      writeHttpConfig(cwd, fixture.url, {
        protocolVersion: "auto",
        headers: { "x-config-revision": "2" },
      });
      await thirdRuntime.connectAndRefresh({ cwd }, "remote");
      expect((await fixtureStats(fixture.url)).methods["server/discover"]).toBe(2);
    } finally {
      await firstRuntime.closeAll();
      await secondRuntime.closeAll();
      await thirdRuntime.closeAll();
      await fixture.stop();
    }
  });

  it("retries read-only discovery once after a dropped HTTP response", async () => {
    const fixture = await startHttpFixture(join(process.cwd(), "tests/fixtures/http-streamable-fixture.mjs"), {
      env: { DROP_METHOD_ONCE: "tools/list" },
    });
    const { home, cwd } = tempWorkspace();
    mkdirSync(cwd, { recursive: true });
    writeHttpConfig(cwd, fixture.url);
    const runtime = createAdapterRuntime({ home, timeoutMs: 2_000 });
    try {
      const result = await runtime.connectAndRefresh({ cwd }, "remote");
      const stats = await fixtureStats(fixture.url);

      expect(result.tools.map((tool) => tool.name)).toContain("echo");
      expect(stats.methods["tools/list"]).toBe(2);
      expect(stats.dropped).toBe(true);
      expect(new Set(stats.requestIds).size).toBe(stats.requestIds.length);
    } finally {
      await runtime.closeAll();
      await fixture.stop();
    }
  });

  it("does not replay a dropped tool call and reconnects for the next call", async () => {
    const fixture = await startHttpFixture(join(process.cwd(), "tests/fixtures/http-streamable-fixture.mjs"), {
      env: { DROP_METHOD_ONCE: "tools/call" },
    });
    const { home, cwd } = tempWorkspace();
    mkdirSync(cwd, { recursive: true });
    writeHttpConfig(cwd, fixture.url);
    const runtime = createAdapterRuntime({ home, timeoutMs: 2_000 });
    try {
      await runtime.connectAndRefresh({ cwd }, "remote");
      const state = runtime.loadState({ cwd });

      const first = await runtime.callTool({ cwd }, state, "remote_echo", { message: "first" });
      expect(first.ok).toBe(false);
      expect((await fixtureStats(fixture.url)).methods["tools/call"]).toBe(1);
      expect(runtime.manager.getConnection("remote")).toBeUndefined();

      const second = await runtime.callTool({ cwd }, state, "remote_echo", { message: "second" });
      expect(second).toMatchObject({ ok: true, isError: false });
      expect((await fixtureStats(fixture.url)).methods["tools/call"]).toBe(2);
    } finally {
      await runtime.closeAll();
      await fixture.stop();
    }
  });
});
