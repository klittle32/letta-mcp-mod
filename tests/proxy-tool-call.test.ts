import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdapterRuntime } from "../src/runtime.js";
import { executeMcpProxy } from "../src/features/proxy-tool.js";

function tempWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "letta-mcp-proxy-call-"));
  const home = join(root, "home");
  const cwd = join(root, "workspace");
  mkdirSync(cwd, { recursive: true });
  return { root, home, cwd };
}

function writeConfig(cwd: string, mcpServers: Record<string, unknown>) {
  writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers }, null, 2));
}

async function runWithRuntime(cwd: string, home: string, args: Record<string, unknown>) {
  const runtime = createAdapterRuntime({ home, now: () => 1_000, timeoutMs: 2_000 });
  try {
    const ctx = { cwd, args, signal: new AbortController().signal };
    return await executeMcpProxy(args, runtime.loadState(ctx), runtime, ctx);
  } finally {
    await runtime.closeAll();
  }
}

describe("proxy tool call mode", () => {
  it("calls fixture tool and formats success", async () => {
    const { cwd, home } = tempWorkspace();
    writeConfig(cwd, { fixture: { command: process.execPath, args: [join(process.cwd(), "tests/fixtures/stdio-mcp-fixture.mjs")] } });

    const text = await runWithRuntime(cwd, home, { tool: "fixture_echo", args: '{"message":"hi"}' });

    expect(text).toContain('Called "fixture_echo" on "fixture".');
    expect(text).toContain("hi");
  });

  it("tool branch has precedence over connect, describe, search, and server", async () => {
    const { cwd, home } = tempWorkspace();
    writeConfig(cwd, { fixture: { command: process.execPath, args: [join(process.cwd(), "tests/fixtures/stdio-mcp-fixture.mjs")] } });

    const text = await runWithRuntime(cwd, home, { tool: "fixture_echo", args: '{"message":"hi"}', connect: "missing", describe: "missing", search: "missing", server: "fixture" });

    expect(text).toContain('Called "fixture_echo" on "fixture".');
    expect(text).toContain("hi");
  });

  it("unsupported action still has precedence over tool", async () => {
    const { cwd, home } = tempWorkspace();

    await expect(runWithRuntime(cwd, home, { action: "ui-messages", tool: "fixture_echo", args: "{}" })).resolves.toContain('Unsupported MCP action "ui-messages"');
  });

  it("invalid args JSON returns parser message", async () => {
    const { cwd, home } = tempWorkspace();
    writeConfig(cwd, { fixture: { command: process.execPath, args: [join(process.cwd(), "tests/fixtures/stdio-mcp-fixture.mjs")] } });

    const text = await runWithRuntime(cwd, home, { tool: "fixture_echo", args: "not json" });

    expect(text).toContain('Invalid args JSON for "fixture_echo"');
  });

  it("soft MCP error formats error result text", async () => {
    const { cwd, home } = tempWorkspace();
    writeConfig(cwd, { fixture: { command: process.execPath, args: [join(process.cwd(), "tests/fixtures/stdio-mcp-fixture.mjs")] } });

    const text = await runWithRuntime(cwd, home, { tool: "fixture_fail_soft", args: "{}" });

    expect(text).toContain('MCP tool "fixture_fail_soft" on "fixture" returned an error.');
    expect(text).toContain("fixture failure");
  });

  it("thrown MCP error formats failed call message", async () => {
    const { cwd, home } = tempWorkspace();
    writeConfig(cwd, { fixture: { command: process.execPath, args: [join(process.cwd(), "tests/fixtures/stdio-mcp-fixture.mjs")] } });

    const text = await runWithRuntime(cwd, home, { tool: "fixture_throw_error", args: "{}" });

    expect(text).toContain('Failed to call MCP tool "fixture_throw_error" on "fixture"');
  });

  it("synthetic resource tool returns resource text", async () => {
    const { cwd, home } = tempWorkspace();
    writeConfig(cwd, { fixture: { command: process.execPath, args: [join(process.cwd(), "tests/fixtures/stdio-mcp-fixture.mjs")] } });

    const text = await runWithRuntime(cwd, home, { tool: "fixture_get_fixture_readme", args: "{}" });

    expect(text).toContain('Read resource "fixture://readme" from "fixture".');
    expect(text).toContain("Fixture README content");
  });

  it("calling a tool refreshes cache for subsequent search/describe/server", async () => {
    const { cwd, home } = tempWorkspace();
    writeConfig(cwd, { fixture: { command: process.execPath, args: [join(process.cwd(), "tests/fixtures/stdio-mcp-fixture.mjs")] } });
    const runtime = createAdapterRuntime({ home, now: () => 1_000, timeoutMs: 2_000 });
    try {
      const ctx = { cwd, args: {}, signal: new AbortController().signal };
      await executeMcpProxy({ tool: "fixture_echo", args: '{"message":"hi"}' }, runtime.loadState(ctx), runtime, { ...ctx, args: { tool: "fixture_echo", args: '{"message":"hi"}' } });

      expect(executeMcpProxy({ search: "structured" }, runtime.loadState(ctx))).toContain("fixture_structured_status");
      expect(executeMcpProxy({ describe: "fixture_echo" }, runtime.loadState(ctx))).toContain("Echo a message");
      expect(executeMcpProxy({ server: "fixture" }, runtime.loadState(ctx))).toContain("fixture_fail_soft");
    } finally {
      await runtime.closeAll();
    }
  });

  it("unknown tool gives search/connect guidance", async () => {
    const { cwd, home } = tempWorkspace();
    writeConfig(cwd, { fixture: { command: process.execPath, args: [join(process.cwd(), "tests/fixtures/stdio-mcp-fixture.mjs")] } });

    const text = await runWithRuntime(cwd, home, { tool: "fixture_missing", args: "{}" });

    expect(text).toContain('Tool "fixture_missing" was not found');
    expect(text).toContain('mcp({ search: "fixture_missing" })');
  });

  it("unreachable HTTP server-hinted tool returns connect failure", async () => {
    const { cwd, home } = tempWorkspace();
    writeConfig(cwd, { remote: { url: "http://127.0.0.1:1/mcp" } });

    const text = await runWithRuntime(cwd, home, { tool: "remote_echo", args: "{}" });

    expect(text).toContain('Failed to connect to "remote"');
    expect(text).toContain("Streamable HTTP failed");
    expect(text).toContain("SSE fallback failed");
  });

  it("calling without runtime returns runtime-required message", () => {
    const text = executeMcpProxy({ tool: "fixture_echo", args: "{}" }, { config: { mcpServers: {} }, warnings: [], prefix: "server", servers: new Map() });

    expect(text).toContain('MCP tool calls for "fixture_echo" require the adapter runtime.');
  });
});
