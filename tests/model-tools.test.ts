import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCallToolTool, createSearchToolsTool } from "../src/mod.js";
import { createAdapterRuntime } from "../src/runtime.js";
import { startHttpFixture } from "./helpers/http-fixture.js";

function tempWorkspace(prefix = "letta-mcp-model-tools-") {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const home = join(root, "home");
  const cwd = join(root, "workspace");
  mkdirSync(cwd, { recursive: true });
  return { home, cwd };
}

function stdioDefinition() {
  return {
    command: process.execPath,
    args: [join(process.cwd(), "tests/fixtures/stdio-mcp-fixture.mjs")],
  };
}

function writeConfig(cwd: string, mcpServers: Record<string, unknown>) {
  writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers }, null, 2));
}

describe("search_tools", () => {
  it("refreshes missing metadata and returns callable names with schemas", async () => {
    const { home, cwd } = tempWorkspace();
    writeConfig(cwd, { fixture: stdioDefinition() });
    const runtime = createAdapterRuntime({ home, now: () => 1_000, timeoutMs: 2_000 });
    const tool = createSearchToolsTool(runtime);
    try {
      const output = await tool.run({ cwd, args: { query: "echo message" } });

      expect(output).toContain("fixture_echo");
      expect(output).toContain("Echo a message");
      expect(output).toContain("Input schema:");
      expect(output).toContain('"required": [');
      expect(output).toContain('"description": "Message to echo"');
      expect(output).toContain("call_tool");
      expect(runtime.loadState({ cwd }).servers.get("fixture")?.cacheValid).toBe(true);
    } finally {
      await runtime.closeAll();
    }
  });

  it("bounds results using limit", async () => {
    const { home, cwd } = tempWorkspace();
    writeConfig(cwd, { fixture: stdioDefinition() });
    const runtime = createAdapterRuntime({ home, now: () => 1_000, timeoutMs: 2_000 });
    const tool = createSearchToolsTool(runtime);
    try {
      const output = await tool.run({ cwd, args: { query: "fixture", limit: 2 } });

      expect(output).toContain("Showing 2:");
    } finally {
      await runtime.closeAll();
    }
  });

  it("returns partial results with concise server failures", async () => {
    const { home, cwd } = tempWorkspace();
    writeConfig(cwd, {
      fixture: stdioDefinition(),
      unavailable: { url: "http://127.0.0.1:1/mcp" },
    });
    const runtime = createAdapterRuntime({ home, now: () => 1_000, timeoutMs: 200 });
    const tool = createSearchToolsTool(runtime);
    try {
      const output = await tool.run({ cwd, args: { query: "echo" } });

      expect(output).toContain("fixture_echo");
      expect(output).toContain("Some integrations were unavailable:");
      expect(output).toContain("unavailable:");
    } finally {
      await runtime.closeAll();
    }
  });

  it("validates query and limit", async () => {
    const runtime = createAdapterRuntime();
    const tool = createSearchToolsTool(runtime);

    await expect(tool.run({ cwd: process.cwd(), args: {} })).resolves.toContain("non-empty query");
    await expect(tool.run({ cwd: process.cwd(), args: { query: "echo", limit: 0 } })).resolves.toContain("integer from 1 to 50");
  });
});

describe("call_tool", () => {
  it("calls a stdio MCP tool with object-valued arguments", async () => {
    const { home, cwd } = tempWorkspace();
    writeConfig(cwd, { fixture: stdioDefinition() });
    const runtime = createAdapterRuntime({ home, now: () => 1_000, timeoutMs: 2_000 });
    const tool = createCallToolTool(runtime);
    try {
      const output = await tool.run({
        cwd,
        args: { name: "fixture_echo", args: { message: "hello object args" } },
      });

      expect(output).toBe('Called "fixture_echo" on "fixture".\n\nhello object args');
    } finally {
      await runtime.closeAll();
    }
  });

  it("formats soft errors and resources", async () => {
    const { home, cwd } = tempWorkspace();
    writeConfig(cwd, { fixture: stdioDefinition() });
    const runtime = createAdapterRuntime({ home, now: () => 1_000, timeoutMs: 2_000 });
    const tool = createCallToolTool(runtime);
    try {
      const failed = await tool.run({
        cwd,
        args: { name: "fixture_fail_soft", args: {} },
      });
      const resource = await tool.run({
        cwd,
        args: { name: "fixture_get_fixture_readme", args: {} },
      });

      expect(failed).toContain('MCP tool "fixture_fail_soft" on "fixture" returned an error.');
      expect(failed).toContain("fixture failure");
      expect(resource).toContain('Read resource "fixture://readme" from "fixture".');
      expect(resource).toContain("Fixture README content");
    } finally {
      await runtime.closeAll();
    }
  });

  it("calls an HTTP bearer tool through the same surface", async () => {
    const fixture = await startHttpFixture(
      join(process.cwd(), "tests/fixtures/http-streamable-fixture.mjs"),
      { env: { REQUIRE_BEARER: "expected-token" } },
    );
    const { home, cwd } = tempWorkspace();
    writeConfig(cwd, {
      remote: {
        url: fixture.url,
        auth: "bearer",
        bearerTokenEnv: "MY_TOKEN",
      },
    });
    const runtime = createAdapterRuntime({
      home,
      env: { MY_TOKEN: "expected-token" },
      timeoutMs: 2_000,
    });
    const tool = createCallToolTool(runtime);
    try {
      const output = await tool.run({
        cwd,
        args: { name: "remote_echo", args: { message: "hello HTTP" } },
      });

      expect(output).toBe('Called "remote_echo" on "remote".\n\nhello HTTP');
    } finally {
      await runtime.closeAll();
      await fixture.stop();
    }
  });

  it("rejects missing names and non-object arguments", async () => {
    const runtime = createAdapterRuntime();
    const tool = createCallToolTool(runtime);

    await expect(tool.run({ cwd: process.cwd(), args: { args: {} } })).resolves.toContain("requires a tool name");
    await expect(tool.run({ cwd: process.cwd(), args: { name: "echo", args: "{}" } })).resolves.toContain("args must be an object");
  });

  it("guides unknown calls back to search_tools", async () => {
    const { home, cwd } = tempWorkspace();
    writeConfig(cwd, { fixture: stdioDefinition() });
    const runtime = createAdapterRuntime({ home, now: () => 1_000, timeoutMs: 2_000 });
    const tool = createCallToolTool(runtime);
    try {
      const output = await tool.run({
        cwd,
        args: { name: "fixture_missing", args: {} },
      });

      expect(output).toContain('Tool "fixture_missing" was not found');
      expect(output).toContain("search_tools");
    } finally {
      await runtime.closeAll();
    }
  });
});
