import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMetadataCachePath, loadMetadataCache } from "../src/core/cache.js";
import { createAdapterRuntime } from "../src/runtime.js";

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

describe("adapter runtime", () => {
  it("loadState reads config/cache but does not connect", async () => {
    const { home, cwd } = tempWorkspace();
    await import("node:fs").then(({ mkdirSync }) => mkdirSync(cwd, { recursive: true }));
    writeWorkspaceConfig(cwd);
    const runtime = createAdapterRuntime({ home });

    const state = runtime.loadState({ cwd, args: {}, signal: new AbortController().signal });

    expect(state.servers.get("fixture")?.cacheEntry).toBeUndefined();
    expect(runtime.manager.getConnection("fixture")).toBeUndefined();
    await runtime.closeAll();
  });

  it("connectAndRefresh connects, discovers metadata, updates cache object, and saves cache", async () => {
    const { home, cwd } = tempWorkspace();
    await import("node:fs").then(({ mkdirSync }) => mkdirSync(cwd, { recursive: true }));
    writeWorkspaceConfig(cwd);
    const runtime = createAdapterRuntime({ home, now: () => 1234, timeoutMs: 2_000 });

    const result = await runtime.connectAndRefresh({ cwd, args: { connect: "fixture" }, signal: new AbortController().signal }, "fixture");

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
});
