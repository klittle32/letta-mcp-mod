import { describe, expect, it, vi } from "vitest";
import { formatCommandHelp, parseMcpCommandArgs } from "../src/features/mcp-command.js";

describe("parseMcpCommandArgs", () => {
  it("undefined, empty, and whitespace args parse to status", () => {
    expect(parseMcpCommandArgs(undefined)).toEqual({ kind: "status" });
    expect(parseMcpCommandArgs("")).toEqual({ kind: "status" });
    expect(parseMcpCommandArgs("  \n\t  ")).toEqual({ kind: "status" });
  });

  it("status parses to status", () => {
    expect(parseMcpCommandArgs("status")).toEqual({ kind: "status" });
  });

  it("tools parses to tools", () => {
    expect(parseMcpCommandArgs("tools")).toEqual({ kind: "tools" });
  });

  it("reconnect parses to reconnect all", () => {
    expect(parseMcpCommandArgs("reconnect")).toEqual({ kind: "reconnect" });
  });

  it("reconnect fixture parses to reconnect one server", () => {
    expect(parseMcpCommandArgs("reconnect fixture")).toEqual({ kind: "reconnect", serverName: "fixture" });
  });

  it("OAuth command aliases parse", () => {
    expect(parseMcpCommandArgs("auth-start remote")).toEqual({ kind: "oauth", action: "auth-start", serverName: "remote" });
    expect(parseMcpCommandArgs("auth-status remote")).toEqual({ kind: "oauth", action: "auth-status", serverName: "remote" });
    expect(parseMcpCommandArgs("auth-status")).toEqual({ kind: "oauth", action: "auth-status" });
    expect(parseMcpCommandArgs("auth-clear remote")).toEqual({ kind: "oauth", action: "auth-clear", serverName: "remote" });
    expect(parseMcpCommandArgs("auth-complete remote http://127.0.0.1/callback?code=a b&state=s")).toEqual({
      kind: "oauth",
      action: "auth-complete",
      serverName: "remote",
      rawArgs: JSON.stringify({ redirectUrl: "http://127.0.0.1/callback?code=a b&state=s" }),
    });
  });

  it("setup parses to read-only setup", () => {
    expect(parseMcpCommandArgs("setup")).toEqual({ kind: "setup", create: false });
  });

  it("setup create and setup --write parse to setup create", () => {
    expect(parseMcpCommandArgs("setup create")).toEqual({ kind: "setup", create: true });
    expect(parseMcpCommandArgs("setup --write")).toEqual({ kind: "setup", create: true });
  });

  it("help and --help parse to help", () => {
    expect(parseMcpCommandArgs("help")).toEqual({ kind: "help" });
    expect(parseMcpCommandArgs("--help")).toEqual({ kind: "help" });
  });

  it("unknown command returns an error with usage hint", () => {
    const result = parseMcpCommandArgs("wat");

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toContain('Unknown /lmcp command "wat"');
      expect(result.message).toContain("Usage:");
      expect(result.message).toContain("/lmcp reconnect <server>");
    }
  });

  it("too many args for fixed commands return concise errors", () => {
    expect(parseMcpCommandArgs("status extra")).toMatchObject({ kind: "error" });
    expect(parseMcpCommandArgs("tools extra")).toMatchObject({ kind: "error" });
    expect(parseMcpCommandArgs("reconnect one two")).toMatchObject({ kind: "error" });
    expect(parseMcpCommandArgs("auth-start")).toMatchObject({ kind: "error" });
    expect(parseMcpCommandArgs("auth-complete remote")).toMatchObject({ kind: "error" });
    expect(parseMcpCommandArgs("setup create extra")).toMatchObject({ kind: "error" });
  });
});

describe("formatCommandHelp", () => {
  it("documents supported /lmcp command forms", () => {
    const help = formatCommandHelp();

    expect(help).toContain("Usage:");
    expect(help).toContain("/lmcp status");
    expect(help).toContain("/lmcp tools");
    expect(help).toContain("/lmcp reconnect");
    expect(help).toContain("/lmcp reconnect <server>");
    expect(help).toContain("/lmcp auth-start <server>");
    expect(help).toContain("/lmcp auth-complete <server> <redirectUrl>");
    expect(help).toContain("/lmcp auth-clear <server>");
    expect(help).toContain("/lmcp setup");
    expect(help).toContain("/lmcp setup create");
  });
});

import { updateServerCache, type MetadataCache } from "../src/core/cache.js";
import type { McpConfig, ServerEntry } from "../src/core/config.js";
import { createProxyState, type ProxyState } from "../src/features/proxy-tool.js";
import { formatStatusCommand, formatToolsCommand } from "../src/features/mcp-command.js";

const fixtureDefinition: ServerEntry = { command: "node", args: ["fixture.mjs"] };

function commandState(options: { config?: McpConfig; cache?: MetadataCache; warnings?: string[] } = {}): ProxyState {
  return createProxyState({
    config: options.config ?? { mcpServers: {} },
    cache: options.cache ?? { version: 1, servers: {} },
    warnings: options.warnings ?? [],
    now: 1_000,
  });
}

function cachedFixtureState(): ProxyState {
  const config: McpConfig = { mcpServers: { fixture: fixtureDefinition } };
  const cache = updateServerCache({
    cache: { version: 1, servers: {} },
    serverName: "fixture",
    definition: fixtureDefinition,
    now: 1_000,
    tools: [
      { name: "echo", description: "Echo a message", inputSchema: { type: "object", properties: { message: { type: "string" } } } },
      { name: "list_items", description: "List fixture items", inputSchema: { type: "object", properties: {} }, uiResourceUri: "ui://fixture/list.html" },
    ],
    resources: [{ uri: "fixture://readme", name: "Fixture README", description: "Read resource: fixture://readme" }],
  });
  return commandState({ config, cache });
}

describe("formatStatusCommand", () => {
  it("empty state includes adapter heading and zero configured servers", () => {
    const text = formatStatusCommand(commandState());

    expect(text).toContain("MCP Adapter");
    expect(text).toContain("MCP: 0 configured servers");
  });

  it("includes command hints", () => {
    const text = formatStatusCommand(commandState());

    expect(text).toContain("/lmcp tools");
    expect(text).toContain("/lmcp reconnect");
    expect(text).toContain("/lmcp setup");
  });

  it("preserves warnings from proxy state", () => {
    const text = formatStatusCommand(commandState({ warnings: ["Invalid config"] }));

    expect(text).toContain("Warnings:");
    expect(text).toContain("Invalid config");
  });
});

describe("formatToolsCommand", () => {
  it("no configured servers suggests setup", () => {
    const text = formatToolsCommand(commandState());

    expect(text).toContain("No MCP servers configured");
    expect(text).toContain("/lmcp setup");
  });

  it("configured server with no cache suggests reconnect", () => {
    const text = formatToolsCommand(commandState({ config: { mcpServers: { fixture: fixtureDefinition } } }));

    expect(text).toContain("No cached MCP tools");
    expect(text).toContain("/lmcp reconnect");
    expect(text).toContain("/lmcp reconnect fixture");
  });

  it("cached tools are grouped by server", () => {
    const text = formatToolsCommand(cachedFixtureState());

    expect(text).toContain("Cached MCP tools");
    expect(text).toContain("fixture:");
    expect(text).toContain("- fixture_echo — Echo a message");
    expect(text).toContain("- fixture_list_items — List fixture items [UI resource: ui://fixture/list.html]");
  });

  it("resource-backed synthetic tools are included", () => {
    const text = formatToolsCommand(cachedFixtureState());

    expect(text).toContain("- fixture_get_fixture_readme — Read resource: fixture://readme");
  });

  it("does not include full JSON schemas", () => {
    const text = formatToolsCommand(cachedFixtureState());

    expect(text).not.toContain("Parameters:");
    expect(text).not.toContain('"type": "object"');
    expect(text).not.toContain("message (string)");
  });
});

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatSetupCommand, starterMcpConfigJson } from "../src/features/mcp-command.js";

function tempCommandWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "letta-mcp-command-"));
  const home = join(root, "home");
  const cwd = join(root, "workspace");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return { root, home, cwd };
}

function writeJson(path: string, value: unknown) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

describe("formatSetupCommand", () => {
  it("with no config files lists all four known source paths as missing", () => {
    const { home, cwd } = tempCommandWorkspace();
    const text = formatSetupCommand({ cwd, home });

    expect(text).toContain("MCP setup");
    expect(text).toContain(`[missing] user-standard: ${join(home, ".config", "mcp", "mcp.json")}`);
    expect(text).toContain(`[missing] letta-global: ${join(home, ".letta", "mcp-adapter", "mcp.json")}`);
    expect(text).toContain(`[missing] project-standard: ${join(cwd, ".mcp.json")}`);
    expect(text).toContain(`[missing] project-letta: ${join(cwd, ".letta", "mcp.json")}`);
  });

  it("with project .mcp.json marks it exists and loaded", () => {
    const { home, cwd } = tempCommandWorkspace();
    writeJson(join(cwd, ".mcp.json"), { mcpServers: { fixture: { command: "node" } } });

    const text = formatSetupCommand({ cwd, home });

    expect(text).toContain(`[exists, loaded] project-standard: ${join(cwd, ".mcp.json")}`);
  });

  it("invalid JSON warnings are included but output remains helpful", () => {
    const { home, cwd } = tempCommandWorkspace();
    writeFileSync(join(cwd, ".mcp.json"), "{not json");

    const text = formatSetupCommand({ cwd, home });

    expect(text).toContain("Warnings:");
    expect(text).toContain("Invalid JSON");
    expect(text).toContain("Example .mcp.json:");
  });

  it("includes recommended project path and example JSON", () => {
    const { home, cwd } = tempCommandWorkspace();
    const text = formatSetupCommand({ cwd, home });

    expect(text).toContain("Recommended for this project:");
    expect(text).toContain(join(cwd, ".mcp.json"));
    expect(text).toContain("Example .mcp.json:");
    expect(text).toContain('"mcpServers"');
    expect(text).toContain('"command": "node"');
  });

  it("plain setup does not create any file", () => {
    const { home, cwd } = tempCommandWorkspace();

    formatSetupCommand({ cwd, home });

    expect(existsSync(join(cwd, ".mcp.json"))).toBe(false);
  });
});

describe("starterMcpConfigJson", () => {
  it("returns parseable starter JSON", () => {
    const parsed = JSON.parse(starterMcpConfigJson());

    expect(parsed.mcpServers.example.command).toBe("node");
    expect(parsed.mcpServers.example.args).toEqual(["path/to/mcp-server.js"]);
    expect(starterMcpConfigJson().endsWith("\n")).toBe(true);
  });
});

import { createStarterProjectConfig } from "../src/features/mcp-command.js";

describe("createStarterProjectConfig", () => {
  it("creates cwd .mcp.json when missing", () => {
    const { cwd } = tempCommandWorkspace();

    const result = createStarterProjectConfig({ cwd });

    expect(result.ok).toBe(true);
    expect(existsSync(join(cwd, ".mcp.json"))).toBe(true);
    expect(result.message).toContain("Created starter MCP config");
  });

  it("created JSON parses and has an example node command", () => {
    const { cwd } = tempCommandWorkspace();

    createStarterProjectConfig({ cwd });
    const parsed = JSON.parse(readFileSync(join(cwd, ".mcp.json"), "utf8"));

    expect(parsed.mcpServers.example.command).toBe("node");
    expect(parsed.mcpServers.example.args).toEqual(["path/to/mcp-server.js"]);
  });

  it("does not overwrite an existing .mcp.json", () => {
    const { cwd } = tempCommandWorkspace();
    const existing = { mcpServers: { real: { command: "real" } } };
    writeJson(join(cwd, ".mcp.json"), existing);

    const result = createStarterProjectConfig({ cwd });
    const parsed = JSON.parse(readFileSync(join(cwd, ".mcp.json"), "utf8"));

    expect(result.ok).toBe(false);
    expect(result.message).toContain("already exists");
    expect(parsed).toEqual(existing);
  });

  it("output tells user to edit the example before reconnecting", () => {
    const { cwd } = tempCommandWorkspace();

    const result = createStarterProjectConfig({ cwd });

    expect(result.message).toContain('Edit the "example" server command/args');
    expect(result.message).toContain("/lmcp reconnect example");
  });

  it("plain setup still does not create a file", () => {
    const { home, cwd } = tempCommandWorkspace();

    formatSetupCommand({ cwd, home });

    expect(existsSync(join(cwd, ".mcp.json"))).toBe(false);
  });
});

import { createAdapterRuntime } from "../src/runtime.js";
import { executeMcpProxy } from "../src/features/proxy-tool.js";
import { startHttpFixture } from "./helpers/http-fixture.js";
import { startOAuthFixture } from "./helpers/oauth-fixture.js";
import { loadOAuthStore } from "../src/mcp/oauth-store.js";
import { executeReconnectCommand } from "../src/features/mcp-command.js";

function writeMcpConfig(cwd: string, mcpServers: Record<string, unknown>) {
  writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers }, null, 2));
}

describe("executeReconnectCommand", () => {
  it("reconnect fixture connects and reports cached tool/resource counts", async () => {
    const { home, cwd } = tempCommandWorkspace();
    writeMcpConfig(cwd, { fixture: { command: process.execPath, args: [join(process.cwd(), "tests/fixtures/stdio-mcp-fixture.mjs")] } });
    const runtime = createAdapterRuntime({ home, timeoutMs: 2_000 });
    try {
      const state = runtime.loadState({ cwd });

      const text = await executeReconnectCommand(runtime, { cwd }, state, "fixture");

      expect(text).toContain("MCP reconnect: fixture");
      expect(text).toContain('Connected to "fixture" and cached 5 tools, 2 resources.');
      expect(text).toContain("Cache:");
    } finally {
      await runtime.closeAll();
    }
  });

  it("after reconnect cache is saved and subsequent search sees fixture_echo", async () => {
    const { home, cwd } = tempCommandWorkspace();
    writeMcpConfig(cwd, { fixture: { command: process.execPath, args: [join(process.cwd(), "tests/fixtures/stdio-mcp-fixture.mjs")] } });
    const runtime = createAdapterRuntime({ home, timeoutMs: 2_000 });
    try {
      await executeReconnectCommand(runtime, { cwd }, runtime.loadState({ cwd }), "fixture");

      const searched = executeMcpProxy({ search: "echo" }, runtime.loadState({ cwd }));

      expect(searched).toContain("fixture_echo");
    } finally {
      await runtime.closeAll();
    }
  });

  it("unknown server returns concise unknown-server message", async () => {
    const { home, cwd } = tempCommandWorkspace();
    writeMcpConfig(cwd, { fixture: { command: process.execPath, args: [join(process.cwd(), "tests/fixtures/stdio-mcp-fixture.mjs")] } });
    const runtime = createAdapterRuntime({ home, timeoutMs: 2_000 });
    try {
      const text = await executeReconnectCommand(runtime, { cwd }, runtime.loadState({ cwd }), "missing");

      expect(text).toContain('Server "missing" is not configured');
      expect(text).toContain("/lmcp status");
    } finally {
      await runtime.closeAll();
    }
  });

  it("HTTP server reconnect succeeds and cached tools are visible", async () => {
    const fixture = await startHttpFixture(join(process.cwd(), "tests/fixtures/http-streamable-fixture.mjs"));
    const { home, cwd } = tempCommandWorkspace();
    writeMcpConfig(cwd, { remote: { url: fixture.url } });
    const runtime = createAdapterRuntime({ home, timeoutMs: 2_000 });
    try {
      const text = await executeReconnectCommand(runtime, { cwd }, runtime.loadState({ cwd }), "remote");
      const tools = formatToolsCommand(runtime.loadState({ cwd }));
      const status = formatStatusCommand(runtime.loadState({ cwd }));

      expect(text).toContain("MCP reconnect: remote");
      expect(text).toContain('Connected to "remote" and cached 3 tools, 1 resource.');
      expect(tools).toContain("remote_echo");
      expect(status).toContain("MCP: 1 configured servers");
      expect(status).toContain("4 cached tools");
    } finally {
      await runtime.closeAll();
      await fixture.stop();
    }
  });

  it("missing HTTP bearer env in reconnect returns actionable output", async () => {
    const { home, cwd } = tempCommandWorkspace();
    writeMcpConfig(cwd, { remote: { url: "http://127.0.0.1:1/mcp", auth: "bearer", bearerTokenEnv: "MY_TOKEN" } });
    const runtime = createAdapterRuntime({ home, env: {}, timeoutMs: 300 });
    try {
      const text = await executeReconnectCommand(runtime, { cwd }, runtime.loadState({ cwd }), "remote");

      expect(text).toContain('bearerTokenEnv "MY_TOKEN"');
      expect(text).not.toContain("Bearer ");
    } finally {
      await runtime.closeAll();
    }
  });

  it("broken server returns concise failure and status still works", async () => {
    const { home, cwd } = tempCommandWorkspace();
    writeMcpConfig(cwd, { broken: { command: process.execPath, args: [join(process.cwd(), "tests/fixtures/broken-server.mjs")] } });
    const runtime = createAdapterRuntime({ home, timeoutMs: 300 });
    try {
      const text = await executeReconnectCommand(runtime, { cwd }, runtime.loadState({ cwd }), "broken");
      const status = formatStatusCommand(runtime.loadState({ cwd }));

      expect(text).toContain('Failed to connect to "broken"');
      expect(status).toContain("MCP: 1 configured servers");
    } finally {
      await runtime.closeAll();
    }
  });

  it("reconnect all reports per-server results sequentially", async () => {
    const { home, cwd } = tempCommandWorkspace();
    writeMcpConfig(cwd, {
      fixture: { command: process.execPath, args: [join(process.cwd(), "tests/fixtures/stdio-mcp-fixture.mjs")] },
      broken: { command: process.execPath, args: [join(process.cwd(), "tests/fixtures/broken-server.mjs")] },
    });
    const runtime = createAdapterRuntime({ home, timeoutMs: 300 });
    try {
      const text = await executeReconnectCommand(runtime, { cwd }, runtime.loadState({ cwd }));

      expect(text).toContain("MCP reconnect");
      expect(text).toContain("[ok] fixture: cached 5 tools, 2 resources");
      expect(text).toContain('[error] broken: Failed to connect to "broken"');
      expect(text).toContain("Refreshed 1/2 servers.");
    } finally {
      await runtime.closeAll();
    }
  });

  it("reconnect all reports mixed stdio and HTTP results", async () => {
    const fixture = await startHttpFixture(join(process.cwd(), "tests/fixtures/http-streamable-fixture.mjs"));
    const { home, cwd } = tempCommandWorkspace();
    writeMcpConfig(cwd, {
      fixture: { command: process.execPath, args: [join(process.cwd(), "tests/fixtures/stdio-mcp-fixture.mjs")] },
      remote: { url: fixture.url },
    });
    const runtime = createAdapterRuntime({ home, timeoutMs: 2_000 });
    try {
      const text = await executeReconnectCommand(runtime, { cwd }, runtime.loadState({ cwd }));

      expect(text).toContain("[ok] fixture: cached 5 tools, 2 resources");
      expect(text).toContain("[ok] remote: cached 3 tools, 1 resource");
      expect(text).toContain("Refreshed 2/2 servers.");
    } finally {
      await runtime.closeAll();
      await fixture.stop();
    }
  });

  it("no configured servers suggests setup", async () => {
    const { home, cwd } = tempCommandWorkspace();
    const runtime = createAdapterRuntime({ home });
    try {
      const text = await executeReconnectCommand(runtime, { cwd }, runtime.loadState({ cwd }));

      expect(text).toContain("No MCP servers configured");
      expect(text).toContain("/lmcp setup");
    } finally {
      await runtime.closeAll();
    }
  });

  it("already aborted signal returns cancellation and avoids work", async () => {
    const { home, cwd } = tempCommandWorkspace();
    writeMcpConfig(cwd, { fixture: { command: process.execPath, args: [join(process.cwd(), "tests/fixtures/stdio-mcp-fixture.mjs")] } });
    const runtime = createAdapterRuntime({ home, timeoutMs: 2_000 });
    const controller = new AbortController();
    controller.abort();
    try {
      const text = await executeReconnectCommand(runtime, { cwd, signal: controller.signal }, runtime.loadState({ cwd }), "fixture");

      expect(text).toBe("MCP command cancelled.");
      expect(runtime.manager.getConnection("fixture")).toBeUndefined();
    } finally {
      await runtime.closeAll();
    }
  });
});

import { createMcpCommand, executeMcpCommand } from "../src/features/mcp-command.js";

describe("createMcpCommand", () => {
  it("defines the lmcp command metadata", () => {
    const command = createMcpCommand();

    expect(command.id).toBe("lmcp");
    expect(command.description).toContain("MCP");
    expect(command.description).toContain("setup");
    expect(command.description).toContain("OAuth");
    expect(command.description).toContain("reconnect");
    expect(command.description).toContain("tools");
    expect(command.args).toContain("status");
    expect(command.args).toContain("reconnect [server]");
    expect(command.args).toContain("auth-start <server>");
    expect(command.args).toContain("setup");
  });

  it("run(ctx) returns output result for status", async () => {
    const { home, cwd } = tempCommandWorkspace();
    const runtime = createAdapterRuntime({ home });
    try {
      const command = createMcpCommand(runtime);

      const result = await command.run({ cwd, args: "status" });

      expect(result.type).toBe("output");
      expect(result.output).toContain("MCP Adapter");
    } finally {
      await runtime.closeAll();
    }
  });

  it("run(ctx) opens, updates, and closes a panel when panel UI is available", async () => {
    const { home, cwd } = tempCommandWorkspace();
    const runtime = createAdapterRuntime({ home });
    const panel = { update: vi.fn(), close: vi.fn() };
    const ui = { capabilities: { ui: { panels: true } }, ui: { openPanel: vi.fn(() => panel) } };
    try {
      const command = createMcpCommand(runtime, ui);

      const result = await command.run({ cwd, args: "status" });

      expect(result.output).toContain("MCP Adapter");
      expect(ui.ui.openPanel).toHaveBeenCalledWith({ id: "letta-lmcp-command", content: ["Running /lmcp status..."], order: 100 });
      expect(panel.update).toHaveBeenCalledWith({ content: ["MCP command complete."] });
      expect(panel.close).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.closeAll();
    }
  });

  it("run(ctx) returns cached tools output", async () => {
    const { home, cwd } = tempCommandWorkspace();
    writeMcpConfig(cwd, { fixture: { command: process.execPath, args: [join(process.cwd(), "tests/fixtures/stdio-mcp-fixture.mjs")] } });
    const runtime = createAdapterRuntime({ home, timeoutMs: 2_000 });
    try {
      await runtime.connectAndRefresh({ cwd }, "fixture");
      const command = createMcpCommand(runtime);

      const result = await command.run({ cwd, args: "tools" });

      expect(result.type).toBe("output");
      expect(result.output).toContain("fixture_echo");
    } finally {
      await runtime.closeAll();
    }
  });

  it("run(ctx) returns setup output", async () => {
    const { home, cwd } = tempCommandWorkspace();
    const runtime = createAdapterRuntime({ home });
    try {
      const command = createMcpCommand(runtime);

      const result = await command.run({ cwd, home, args: "setup" });

      expect(result).toMatchObject({ type: "output" });
      expect(result.output).toContain("MCP setup");
    } finally {
      await runtime.closeAll();
    }
  });

  it("run(ctx) reconnects fixture through runtime", async () => {
    const { home, cwd } = tempCommandWorkspace();
    writeMcpConfig(cwd, { fixture: { command: process.execPath, args: [join(process.cwd(), "tests/fixtures/stdio-mcp-fixture.mjs")] } });
    const runtime = createAdapterRuntime({ home, timeoutMs: 2_000 });
    try {
      const command = createMcpCommand(runtime);

      const result = await command.run({ cwd, args: "reconnect fixture" });

      expect(result.type).toBe("output");
      expect(result.output).toContain('Connected to "fixture" and cached 5 tools, 2 resources.');
    } finally {
      await runtime.closeAll();
    }
  });

  it("run(ctx) reconnects HTTP server through runtime", async () => {
    const fixture = await startHttpFixture(join(process.cwd(), "tests/fixtures/http-streamable-fixture.mjs"));
    const { home, cwd } = tempCommandWorkspace();
    writeMcpConfig(cwd, { remote: { url: fixture.url } });
    const runtime = createAdapterRuntime({ home, timeoutMs: 2_000 });
    try {
      const command = createMcpCommand(runtime);

      const result = await command.run({ cwd, args: "reconnect remote" });

      expect(result.type).toBe("output");
      expect(result.output).toContain('Connected to "remote" and cached 3 tools, 1 resource.');
    } finally {
      await runtime.closeAll();
      await fixture.stop();
    }
  });

  it("run(ctx) starts and completes OAuth login", async () => {
    const fixture = await startOAuthFixture();
    const { home, cwd } = tempCommandWorkspace();
    writeMcpConfig(cwd, { remote: { url: fixture.url, auth: "oauth", oauth: { clientId: "client-id", clientSecret: "client-secret-test-value", redirectUri: fixture.redirectUri } } });
    const runtime = createAdapterRuntime({ home, timeoutMs: 2_000 });
    try {
      const command = createMcpCommand(runtime);

      const started = await command.run({ cwd, args: "auth-start remote" });
      const authorizationUrl = loadOAuthStore({ home, serverName: "remote", serverUrl: fixture.url })?.authorizationUrl;
      const redirectUrl = await fixture.authorize(authorizationUrl!);
      const completed = await command.run({ cwd, args: `auth-complete remote ${redirectUrl}` });
      const status = await command.run({ cwd, args: "auth-status remote" });

      expect(started.output).toContain("OAuth authorization started");
      expect(completed.output).toContain("OAuth authorization complete");
      expect(status.output).toContain("tokens: present");
      expect(completed.output).not.toContain("fixture-access-token");
    } finally {
      await runtime.closeAll();
      await fixture.stop();
    }
  });

  it("already aborted run returns cancellation output", async () => {
    const { home, cwd } = tempCommandWorkspace();
    const runtime = createAdapterRuntime({ home });
    const controller = new AbortController();
    controller.abort();
    try {
      const command = createMcpCommand(runtime);

      const result = await command.run({ cwd, args: "status", signal: controller.signal });

      expect(result).toEqual({ type: "output", output: "MCP command cancelled." });
    } finally {
      await runtime.closeAll();
    }
  });
});

describe("executeMcpCommand", () => {
  it("routes setup create to starter config creation", async () => {
    const { home, cwd } = tempCommandWorkspace();
    const runtime = createAdapterRuntime({ home });
    try {
      const output = await executeMcpCommand("setup --write", runtime, { cwd, home });

      expect(output).toContain("Created starter MCP config");
      expect(existsSync(join(cwd, ".mcp.json"))).toBe(true);
    } finally {
      await runtime.closeAll();
    }
  });

  it("routes help to command help", async () => {
    const { home, cwd } = tempCommandWorkspace();
    const runtime = createAdapterRuntime({ home });
    try {
      const output = await executeMcpCommand("help", runtime, { cwd, home });

      expect(output).toContain("Usage:");
      expect(output).toContain("/lmcp reconnect <server>");
    } finally {
      await runtime.closeAll();
    }
  });
});
