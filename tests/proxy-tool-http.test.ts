import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { executeMcpProxy } from "../src/features/proxy-tool.js";
import { createAdapterRuntime } from "../src/runtime.js";
import { startHttpFixture } from "./helpers/http-fixture.js";

function tempWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "letta-mcp-proxy-http-call-"));
  const home = join(root, "home");
  const cwd = join(root, "workspace");
  mkdirSync(cwd, { recursive: true });
  return { root, home, cwd };
}

function writeConfig(cwd: string, mcpServers: Record<string, unknown>) {
  writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers }, null, 2));
}

describe("proxy HTTP tool call mode", () => {
  it("lazy tool call to HTTP server refreshes metadata and calls echo", async () => {
    const fixture = await startHttpFixture(join(process.cwd(), "tests/fixtures/http-streamable-fixture.mjs"));
    const { cwd, home } = tempWorkspace();
    writeConfig(cwd, { remote: { url: fixture.url } });
    const runtime = createAdapterRuntime({ home, now: () => 1_000, timeoutMs: 2_000 });
    try {
      const ctx = { cwd, args: {}, signal: new AbortController().signal };
      const text = await executeMcpProxy({ tool: "remote_echo", args: '{"message":"hello"}' }, runtime.loadState(ctx), runtime, {
        ...ctx,
        args: { tool: "remote_echo", args: '{"message":"hello"}' },
      });

      expect(text).toContain('Called "remote_echo" on "remote".');
      expect(text).toContain("hello");
      expect(runtime.loadState({ cwd }).servers.get("remote")?.tools.map((tool) => tool.name)).toContain("remote_echo");
    } finally {
      await runtime.closeAll();
      await fixture.stop();
    }
  });

  it("explicit server-hinted HTTP tool call works", async () => {
    const fixture = await startHttpFixture(join(process.cwd(), "tests/fixtures/http-streamable-fixture.mjs"));
    const { cwd, home } = tempWorkspace();
    writeConfig(cwd, { remote: { url: fixture.url } });
    const runtime = createAdapterRuntime({ home, now: () => 1_000, timeoutMs: 2_000 });
    try {
      const result = await runtime.callTool({ cwd, args: { server: "remote" } }, runtime.loadState({ cwd }), "echo", '{"message":"hi"}');

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.output).toBe("hi");
    } finally {
      await runtime.closeAll();
      await fixture.stop();
    }
  });

  it("prefixed exposed HTTP tool call works after metadata refresh", async () => {
    const fixture = await startHttpFixture(join(process.cwd(), "tests/fixtures/http-streamable-fixture.mjs"));
    const { cwd, home } = tempWorkspace();
    writeConfig(cwd, { remote: { url: fixture.url } });
    const runtime = createAdapterRuntime({ home, now: () => 1_000, timeoutMs: 2_000 });
    try {
      await runtime.connectAndRefresh({ cwd }, "remote");
      const result = await runtime.callTool({ cwd }, runtime.loadState({ cwd }), "remote_echo", '{"message":"cached"}');

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.output).toBe("cached");
    } finally {
      await runtime.closeAll();
      await fixture.stop();
    }
  });

  it("HTTP resource-backed synthetic tool reads a resource", async () => {
    const fixture = await startHttpFixture(join(process.cwd(), "tests/fixtures/http-streamable-fixture.mjs"));
    const { cwd, home } = tempWorkspace();
    writeConfig(cwd, { remote: { url: fixture.url } });
    const runtime = createAdapterRuntime({ home, now: () => 1_000, timeoutMs: 2_000 });
    try {
      const text = await executeMcpProxy({ tool: "remote_get_http_fixture_readme", args: "{}" }, runtime.loadState({ cwd }), runtime, {
        cwd,
        args: { tool: "remote_get_http_fixture_readme", args: "{}" },
        signal: new AbortController().signal,
      });

      expect(text).toContain('Read resource "fixture://http-readme" from "remote".');
      expect(text).toContain("HTTP Fixture README content");
    } finally {
      await runtime.closeAll();
      await fixture.stop();
    }
  });

  it("HTTP tool errors render through existing result behavior", async () => {
    const fixture = await startHttpFixture(join(process.cwd(), "tests/fixtures/http-streamable-fixture.mjs"));
    const { cwd, home } = tempWorkspace();
    writeConfig(cwd, { remote: { url: fixture.url } });
    const runtime = createAdapterRuntime({ home, now: () => 1_000, timeoutMs: 2_000 });
    try {
      const text = await executeMcpProxy({ tool: "remote_fail_soft", args: "{}" }, runtime.loadState({ cwd }), runtime, {
        cwd,
        args: { tool: "remote_fail_soft", args: "{}" },
        signal: new AbortController().signal,
      });

      expect(text).toContain('MCP tool "remote_fail_soft" on "remote" returned an error.');
      expect(text).toContain("fixture http failure");
    } finally {
      await runtime.closeAll();
      await fixture.stop();
    }
  });

  it("HTTP auth failure from callTool is concise and contains no token", async () => {
    const fixture = await startHttpFixture(join(process.cwd(), "tests/fixtures/http-streamable-fixture.mjs"), { env: { REQUIRE_BEARER: "expected" } });
    const { cwd, home } = tempWorkspace();
    writeConfig(cwd, { remote: { url: fixture.url, auth: "bearer", bearerToken: "wrong-token" } });
    const runtime = createAdapterRuntime({ home, now: () => 1_000, timeoutMs: 2_000 });
    try {
      const result = await runtime.callTool({ cwd }, runtime.loadState({ cwd }), "remote_echo", '{"message":"hi"}');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toContain('Failed to connect to "remote"');
        expect(result.message).not.toContain("wrong-token");
        expect(result.message).not.toContain("expected");
      }
    } finally {
      await runtime.closeAll();
      await fixture.stop();
    }
  });
});
