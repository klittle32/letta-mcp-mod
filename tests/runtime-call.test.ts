import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdapterRuntime } from "../src/runtime.js";

function tempWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "letta-mcp-runtime-call-"));
  const home = join(root, "home");
  const cwd = join(root, "workspace");
  mkdirSync(cwd, { recursive: true });
  return { root, home, cwd };
}

function writeWorkspaceConfig(
  cwd: string,
  servers = ["fixture"],
  settings?: Record<string, unknown>,
  fixtureEnv?: Record<string, string>,
) {
  const mcpServers: Record<string, unknown> = {};
  if (servers.includes("fixture")) {
    mcpServers.fixture = {
      command: process.execPath,
      args: [join(process.cwd(), "tests/fixtures/stdio-mcp-fixture.mjs")],
      ...(fixtureEnv ? { env: fixtureEnv } : {}),
    };
  }
  if (servers.includes("remote")) {
    mcpServers.remote = { url: "http://localhost:3000/mcp" };
  }
  writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers, ...(settings ? { settings } : {}) }, null, 2));
}

function artifactPath(output: string): string | undefined {
  return output.match(/Full result: (.+)\. Use the file tools to read more\./)?.[1];
}

describe("adapter runtime callTool", () => {
  it("with valid cache connects/reuses fixture and returns rendered text", async () => {
    const { home, cwd } = tempWorkspace();
    writeWorkspaceConfig(cwd);
    const runtime = createAdapterRuntime({ home, timeoutMs: 2_000 });
    await runtime.connectAndRefresh({ cwd }, "fixture");
    const state = runtime.loadState({ cwd });

    const result = await runtime.callTool({ cwd }, state, "fixture_echo", { message: "hello" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target.serverName).toBe("fixture");
      expect(result.output).toBe('Called "fixture_echo" on "fixture".\n\nhello');
      expect(result.isError).toBe(false);
    }
    expect(runtime.manager.getConnection("fixture")?.status).toBe("connected");
    await runtime.closeAll();
  });

  it("with no cache lazy-connects from server-prefixed tool name and calls the tool", async () => {
    const { home, cwd } = tempWorkspace();
    writeWorkspaceConfig(cwd);
    const runtime = createAdapterRuntime({ home, timeoutMs: 2_000 });
    const state = runtime.loadState({ cwd });

    const result = await runtime.callTool({ cwd }, state, "fixture_echo", { message: "hello" });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output).toBe('Called "fixture_echo" on "fixture".\n\nhello');
    expect(runtime.loadState({ cwd }).servers.get("fixture")?.tools.map((tool) => tool.name)).toContain("fixture_echo");
    await runtime.closeAll();
  });

  it("with explicit server hint and no cache lazy-connects and calls the tool", async () => {
    const { home, cwd } = tempWorkspace();
    writeWorkspaceConfig(cwd);
    const runtime = createAdapterRuntime({ home, timeoutMs: 2_000 });
    const state = runtime.loadState({ cwd });

    const result = await runtime.callTool({ cwd, serverName: "fixture" }, state, "echo", { message: "hi" });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output).toBe('Called "fixture_echo" on "fixture".\n\nhi');
    await runtime.closeAll();
  });

  it("accepts already parsed object arguments", async () => {
    const { home, cwd } = tempWorkspace();
    writeWorkspaceConfig(cwd);
    const runtime = createAdapterRuntime({ home, timeoutMs: 2_000 });

    const result = await runtime.callTool(
      { cwd },
      runtime.loadState({ cwd }),
      "fixture_echo",
      { message: "already parsed" },
    );

    expect(result).toMatchObject({ ok: true, output: 'Called "fixture_echo" on "fixture".\n\nalready parsed' });
    await runtime.closeAll();
  });

  it("unknown unhinted tool returns guidance and does not leak a connection", async () => {
    const { home, cwd } = tempWorkspace();
    writeWorkspaceConfig(cwd, ["fixture", "remote"]);
    const runtime = createAdapterRuntime({ home, timeoutMs: 2_000 });

    const result = await runtime.callTool({ cwd }, runtime.loadState({ cwd }), "missing", {});

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('Tool "missing" was not found');
    expect(runtime.manager.getConnection("fixture")).toBeUndefined();
    expect(runtime.manager.getConnection("remote")).toBeUndefined();
  });

  it("soft MCP error returns isError true and rendered content", async () => {
    const { home, cwd } = tempWorkspace();
    writeWorkspaceConfig(cwd);
    const runtime = createAdapterRuntime({ home, timeoutMs: 2_000 });

    const result = await runtime.callTool({ cwd }, runtime.loadState({ cwd }), "fixture_fail_soft", {});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.isError).toBe(true);
      expect(result.output).toBe('MCP tool "fixture_fail_soft" on "fixture" returned an error.\n\nfixture failure');
    }
    await runtime.closeAll();
  });

  it("thrown MCP error returns concise failure", async () => {
    const { home, cwd } = tempWorkspace();
    writeWorkspaceConfig(cwd);
    const runtime = createAdapterRuntime({ home, timeoutMs: 2_000 });

    const result = await runtime.callTool({ cwd }, runtime.loadState({ cwd }), "fixture_throw_error", {});

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('Failed to call MCP tool "fixture_throw_error" on "fixture"');
    await runtime.closeAll();
  });

  it("invalidates persisted metadata after a live tools-list change", async () => {
    const { home, cwd } = tempWorkspace();
    writeWorkspaceConfig(cwd, ["fixture"], undefined, { NOTIFY_LIST_CHANGED: "1" });
    const runtime = createAdapterRuntime({ home, timeoutMs: 2_000 });
    try {
      await runtime.connectAndRefresh({ cwd }, "fixture");
      expect(runtime.loadState({ cwd }).servers.get("fixture")?.cacheEntry).toBeDefined();

      const result = await runtime.callTool(
        { cwd },
        runtime.loadState({ cwd }),
        "fixture_list_items",
        {},
      );
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(result).toMatchObject({ ok: true });
      expect(runtime.loadState({ cwd }).servers.get("fixture")?.cacheEntry).toBeUndefined();
    } finally {
      await runtime.closeAll();
    }
  });

  it("refreshes stale metadata after invalid params without replaying the tool call", async () => {
    const { home, cwd } = tempWorkspace();
    const toolsListCount = join(cwd, "tools-list-count.txt");
    const toolsCallCount = join(cwd, "tools-call-count.txt");
    writeWorkspaceConfig(cwd, ["fixture"], undefined, {
      STALE_CATALOG_ERROR: "1",
      TOOLS_LIST_COUNT_FILE: toolsListCount,
      TOOLS_CALL_COUNT_FILE: toolsCallCount,
    });
    const runtime = createAdapterRuntime({ home, timeoutMs: 2_000 });
    try {
      await runtime.connectAndRefresh({ cwd }, "fixture");
      const result = await runtime.callTool(
        { cwd },
        runtime.loadState({ cwd }),
        "fixture_throw_error",
        {},
      );

      expect(result).toMatchObject({ ok: false });
      expect(readFileSync(toolsListCount, "utf8").trim().split("\n")).toHaveLength(2);
      expect(readFileSync(toolsCallCount, "utf8").trim().split("\n")).toHaveLength(1);
      expect(runtime.loadState({ cwd }).servers.get("fixture")?.cacheValid).toBe(true);
    } finally {
      await runtime.closeAll();
    }
  });

  it("synthetic resource tool reads resource text", async () => {
    const { home, cwd } = tempWorkspace();
    writeWorkspaceConfig(cwd);
    const runtime = createAdapterRuntime({ home, timeoutMs: 2_000 });

    const result = await runtime.callTool({ cwd }, runtime.loadState({ cwd }), "fixture_get_fixture_readme", {});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target.isResource).toBe(true);
      expect(result.output).toBe('Read resource "fixture://readme" from "fixture".\n\nFixture README content');
    }
    await runtime.closeAll();
  });

  it("already aborted signal returns cancellation and avoids work", async () => {
    const { home, cwd } = tempWorkspace();
    writeWorkspaceConfig(cwd);
    const runtime = createAdapterRuntime({ home, timeoutMs: 2_000 });
    const controller = new AbortController();
    controller.abort();

    const result = await runtime.callTool({ cwd, signal: controller.signal }, runtime.loadState({ cwd }), "fixture_echo", { message: "hello" });

    expect(result).toEqual({ ok: false, message: "MCP request cancelled." });
    expect(runtime.manager.getConnection("fixture")).toBeUndefined();
  });

  it("closeAll still closes connections after calls", async () => {
    const { home, cwd } = tempWorkspace();
    writeWorkspaceConfig(cwd);
    const runtime = createAdapterRuntime({ home, timeoutMs: 2_000 });

    await runtime.callTool({ cwd }, runtime.loadState({ cwd }), "fixture_echo", { message: "hello" });
    expect(runtime.manager.getConnection("fixture")?.status).toBe("connected");

    await runtime.closeAll();
    expect(runtime.manager.getConnection("fixture")).toBeUndefined();
  });

  it("applies the configured aggregate limit and preserves the full result", async () => {
    const { home, cwd } = tempWorkspace();
    writeWorkspaceConfig(cwd, ["fixture"], { outputGuard: { maxChars: 1_000 } });
    const runtime = createAdapterRuntime({ home, timeoutMs: 2_000 });
    const message = "configured-limit-".repeat(100);

    const result = await runtime.callTool(
      { cwd },
      runtime.loadState({ cwd }),
      "fixture_echo",
      { message },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.length).toBeLessThanOrEqual(1_000);
      const path = artifactPath(result.output);
      expect(path).toBeTruthy();
      expect(readFileSync(path!, "utf8")).toBe(`Called "fixture_echo" on "fixture".\n\n${message}`);
    }
    await runtime.closeAll();
  });

  it("lets a per-call maxOutput override the configured limit", async () => {
    const { home, cwd } = tempWorkspace();
    writeWorkspaceConfig(cwd, ["fixture"], { outputGuard: { maxChars: 5_000 } });
    const runtime = createAdapterRuntime({ home, timeoutMs: 2_000 });
    const message = "override-limit-".repeat(100);

    const result = await runtime.callTool(
      { cwd },
      runtime.loadState({ cwd }),
      "fixture_echo",
      { message },
      { maxOutput: 1_000 },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain("Output truncated (");
      const path = artifactPath(result.output);
      expect(readFileSync(path!, "utf8")).toContain(message);
    }
    await runtime.closeAll();
  });
});
