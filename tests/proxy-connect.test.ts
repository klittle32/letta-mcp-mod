import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdapterRuntime } from "../src/runtime.js";
import { executeMcpProxy } from "../src/features/proxy-tool.js";

function tempWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "letta-mcp-proxy-"));
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

describe("proxy connect mode", () => {
  it("reports missing server", async () => {
    const { cwd, home } = tempWorkspace();

    await expect(runWithRuntime(cwd, home, { connect: "missing" })).resolves.toContain('Server "missing" is not configured');
  });

  it("reports unreachable HTTP failures concisely", async () => {
    const { cwd, home } = tempWorkspace();
    writeConfig(cwd, { remote: { url: "http://127.0.0.1:1/mcp" } });

    const text = await runWithRuntime(cwd, home, { connect: "remote" });

    expect(text).toContain('Failed to connect to "remote"');
    expect(text).toContain("Streamable HTTP failed");
    expect(text).toContain("SSE fallback failed");
  });

  it("connects to fixture and reports cached tool/resource counts", async () => {
    const { cwd, home } = tempWorkspace();
    writeConfig(cwd, { fixture: { command: process.execPath, args: [join(process.cwd(), "tests/fixtures/stdio-mcp-fixture.mjs")] } });

    const text = await runWithRuntime(cwd, home, { connect: "fixture" });

    expect(text).toContain('Connected to "fixture" and cached 5 tools, 2 resources.');
    expect(text).toContain("- fixture_echo - Echo a message");
    expect(text).toContain("- fixture_get_fixture_readme - Read resource: fixture://readme");
  });

  it("after connect, server/search/describe use refreshed cache", async () => {
    const { cwd, home } = tempWorkspace();
    writeConfig(cwd, { fixture: { command: process.execPath, args: [join(process.cwd(), "tests/fixtures/stdio-mcp-fixture.mjs")] } });
    const runtime = createAdapterRuntime({ home, now: () => 1_000, timeoutMs: 2_000 });
    try {
      const ctx = { cwd, args: {}, signal: new AbortController().signal };
      await executeMcpProxy({ connect: "fixture" }, runtime.loadState(ctx), runtime, { ...ctx, args: { connect: "fixture" } });

      const listed = executeMcpProxy({ server: "fixture" }, runtime.loadState(ctx));
      const searched = executeMcpProxy({ search: "echo" }, runtime.loadState(ctx));
      const described = executeMcpProxy({ describe: "fixture_echo" }, runtime.loadState(ctx));

      expect(listed).toContain("fixture_echo");
      expect(searched).toContain("fixture_echo");
      expect(described).toContain("message (string) *required*");
    } finally {
      await runtime.closeAll();
    }
  });

  it("broken server returns concise failure and status still works", async () => {
    const { cwd, home } = tempWorkspace();
    writeConfig(cwd, { broken: { command: process.execPath, args: [join(process.cwd(), "tests/fixtures/broken-server.mjs")] } });
    const runtime = createAdapterRuntime({ home, timeoutMs: 300 });
    try {
      const ctx = { cwd, args: {}, signal: new AbortController().signal };
      const text = await executeMcpProxy({ connect: "broken" }, runtime.loadState(ctx), runtime, { ...ctx, args: { connect: "broken" } });
      const status = executeMcpProxy({}, runtime.loadState(ctx));

      expect(text).toContain('Failed to connect to "broken"');
      expect(status).toContain("MCP: 1 configured servers");
    } finally {
      await runtime.closeAll();
    }
  });

  it("status hint says connect is available", () => {
    const { cwd, home } = tempWorkspace();
    writeConfig(cwd, { fixture: { command: process.execPath, args: [] } });
    const runtime = createAdapterRuntime({ home });

    const text = executeMcpProxy({}, runtime.loadState({ cwd }));

    expect(text).toContain('Use mcp({ connect: "server" }) to connect and refresh cached metadata.');
  });

  it("tool calls require runtime and precedence still holds", async () => {
    const { cwd, home } = tempWorkspace();
    const runtime = createAdapterRuntime({ home });
    const ctx = { cwd, args: {}, signal: new AbortController().signal };

    expect(executeMcpProxy({ tool: "fixture_echo" }, runtime.loadState(ctx))).toContain("require the adapter runtime");
    expect(executeMcpProxy({ action: "ui-messages", tool: "x", connect: "x" }, runtime.loadState(ctx))).toContain('Unsupported MCP action "ui-messages"');
    expect(executeMcpProxy({ tool: "x", connect: "x" }, runtime.loadState(ctx))).toContain("MCP tool calls for \"x\" require the adapter runtime.");
    await expect(executeMcpProxy({ connect: "x", describe: "x" }, runtime.loadState(ctx), runtime, ctx)).resolves.toContain('Server "x" is not configured');
    expect(executeMcpProxy({ describe: "x", search: "x" }, runtime.loadState(ctx))).toContain('Tool "x" not found');
    await runtime.closeAll();
  });
});
