import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

function writeWorkspaceConfig(cwd: string, servers = ["fixture"]) {
  const mcpServers: Record<string, unknown> = {};
  if (servers.includes("fixture")) {
    mcpServers.fixture = {
      command: process.execPath,
      args: [join(process.cwd(), "tests/fixtures/stdio-mcp-fixture.mjs")],
    };
  }
  if (servers.includes("remote")) {
    mcpServers.remote = { url: "http://localhost:3000/mcp" };
  }
  writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers }, null, 2));
}

describe("adapter runtime callTool", () => {
  it("with valid cache connects/reuses fixture and returns rendered text", async () => {
    const { home, cwd } = tempWorkspace();
    writeWorkspaceConfig(cwd);
    const runtime = createAdapterRuntime({ home, timeoutMs: 2_000 });
    await runtime.connectAndRefresh({ cwd }, "fixture");
    const state = runtime.loadState({ cwd });

    const result = await runtime.callTool({ cwd }, state, "fixture_echo", '{"message":"hello"}');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target.serverName).toBe("fixture");
      expect(result.output).toBe("hello");
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

    const result = await runtime.callTool({ cwd }, state, "fixture_echo", '{"message":"hello"}');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output).toBe("hello");
    expect(runtime.loadState({ cwd }).servers.get("fixture")?.tools.map((tool) => tool.name)).toContain("fixture_echo");
    await runtime.closeAll();
  });

  it("with explicit server hint and no cache lazy-connects and calls the tool", async () => {
    const { home, cwd } = tempWorkspace();
    writeWorkspaceConfig(cwd);
    const runtime = createAdapterRuntime({ home, timeoutMs: 2_000 });
    const state = runtime.loadState({ cwd });

    const result = await runtime.callTool({ cwd, args: { server: "fixture" } }, state, "echo", '{"message":"hi"}');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output).toBe("hi");
    await runtime.closeAll();
  });

  it("failed args parse returns parser error and does not connect", async () => {
    const { home, cwd } = tempWorkspace();
    writeWorkspaceConfig(cwd);
    const runtime = createAdapterRuntime({ home, timeoutMs: 2_000 });

    const result = await runtime.callTool({ cwd }, runtime.loadState({ cwd }), "fixture_echo", "not json");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('Invalid args JSON for "fixture_echo"');
    expect(runtime.manager.getConnection("fixture")).toBeUndefined();
  });

  it("unknown unhinted tool returns guidance and does not leak a connection", async () => {
    const { home, cwd } = tempWorkspace();
    writeWorkspaceConfig(cwd, ["fixture", "remote"]);
    const runtime = createAdapterRuntime({ home, timeoutMs: 2_000 });

    const result = await runtime.callTool({ cwd }, runtime.loadState({ cwd }), "missing", "{}");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('Tool "missing" was not found');
    expect(runtime.manager.getConnection("fixture")).toBeUndefined();
    expect(runtime.manager.getConnection("remote")).toBeUndefined();
  });

  it("soft MCP error returns isError true and rendered content", async () => {
    const { home, cwd } = tempWorkspace();
    writeWorkspaceConfig(cwd);
    const runtime = createAdapterRuntime({ home, timeoutMs: 2_000 });

    const result = await runtime.callTool({ cwd }, runtime.loadState({ cwd }), "fixture_fail_soft", "{}");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.isError).toBe(true);
      expect(result.output).toBe("fixture failure");
    }
    await runtime.closeAll();
  });

  it("thrown MCP error returns concise failure", async () => {
    const { home, cwd } = tempWorkspace();
    writeWorkspaceConfig(cwd);
    const runtime = createAdapterRuntime({ home, timeoutMs: 2_000 });

    const result = await runtime.callTool({ cwd }, runtime.loadState({ cwd }), "fixture_throw_error", "{}");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('Failed to call MCP tool "fixture_throw_error" on "fixture"');
    await runtime.closeAll();
  });

  it("synthetic resource tool reads resource text", async () => {
    const { home, cwd } = tempWorkspace();
    writeWorkspaceConfig(cwd);
    const runtime = createAdapterRuntime({ home, timeoutMs: 2_000 });

    const result = await runtime.callTool({ cwd }, runtime.loadState({ cwd }), "fixture_get_fixture_readme", "{}");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target.isResource).toBe(true);
      expect(result.output).toBe("Fixture README content");
    }
    await runtime.closeAll();
  });

  it("already aborted signal returns cancellation and avoids work", async () => {
    const { home, cwd } = tempWorkspace();
    writeWorkspaceConfig(cwd);
    const runtime = createAdapterRuntime({ home, timeoutMs: 2_000 });
    const controller = new AbortController();
    controller.abort();

    const result = await runtime.callTool({ cwd, signal: controller.signal }, runtime.loadState({ cwd }), "fixture_echo", '{"message":"hello"}');

    expect(result).toEqual({ ok: false, message: "MCP request cancelled." });
    expect(runtime.manager.getConnection("fixture")).toBeUndefined();
  });

  it("closeAll still closes connections after calls", async () => {
    const { home, cwd } = tempWorkspace();
    writeWorkspaceConfig(cwd);
    const runtime = createAdapterRuntime({ home, timeoutMs: 2_000 });

    await runtime.callTool({ cwd }, runtime.loadState({ cwd }), "fixture_echo", '{"message":"hello"}');
    expect(runtime.manager.getConnection("fixture")?.status).toBe("connected");

    await runtime.closeAll();
    expect(runtime.manager.getConnection("fixture")).toBeUndefined();
  });
});
