import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import activate, { type LettaModApi, type LettaToolDefinition } from "../src/mod.js";
import { executeMcpCommand } from "../src/features/mcp-command.js";
import { loadOAuthStore } from "../src/mcp/oauth-store.js";
import { createAdapterRuntime } from "../src/runtime.js";
import { startHttpFixture } from "./helpers/http-fixture.js";
import { startOAuthFixture } from "./helpers/oauth-fixture.js";

function tempWorkspace(prefix = "letta-mcp-direct-runtime-") {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const home = join(root, "home");
  const cwd = join(root, "workspace");
  mkdirSync(cwd, { recursive: true });
  return { root, home, cwd };
}

function writeWorkspaceConfig(cwd: string, serverOverrides: Record<string, unknown> = {}) {
  writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({
    mcpServers: {
      fixture: {
        command: process.execPath,
        args: [join(process.cwd(), "tests/fixtures/stdio-mcp-fixture.mjs")],
        directTools: ["echo"],
        ...serverOverrides,
      },
    },
  }, null, 2));
}

function writeConfig(cwd: string, mcpServers: Record<string, unknown>) {
  writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers }, null, 2));
}

function fakeLetta() {
  const registeredTools: LettaToolDefinition[] = [];
  const letta = {
    capabilities: { tools: true, commands: false },
    tools: {
      register: vi.fn((tool: LettaToolDefinition) => {
        registeredTools.push(tool);
        return vi.fn();
      }),
    },
    diagnostics: { report: vi.fn() },
  } satisfies LettaModApi;
  return { letta, registeredTools };
}

describe("direct MCP tools runtime integration", () => {
  it("registers and invokes a cache-backed stdio direct tool", async () => {
    const { home, cwd } = tempWorkspace();
    writeWorkspaceConfig(cwd);
    const runtime = createAdapterRuntime({ home, timeoutMs: 2_000 });
    await runtime.connectAndRefresh({ cwd }, "fixture");
    const { letta, registeredTools } = fakeLetta();

    const dispose = activate(letta, runtime, { activationCwd: cwd });

    expect(registeredTools.map((tool) => tool.name)).toContain("search_tools");
    expect(registeredTools.map((tool) => tool.name)).toContain("call_tool");
    expect(registeredTools.map((tool) => tool.name)).toContain("fixture_echo");

    const directTool = registeredTools.find((tool) => tool.name === "fixture_echo");
    expect(directTool).toBeDefined();
    const output = await directTool!.run({ cwd, args: { message: "hello" } as never });

    expect(output).toBe('Called "fixture_echo" on "fixture".\n\nhello');
    await dispose?.();
  });

  it("keeps only the split catalog tools available when direct tools are configured without cache", async () => {
    const { home, cwd } = tempWorkspace();
    writeWorkspaceConfig(cwd);
    const runtime = createAdapterRuntime({ home, timeoutMs: 2_000 });
    const { letta, registeredTools } = fakeLetta();

    const dispose = activate(letta, runtime, { activationCwd: cwd });

    expect(registeredTools.map((tool) => tool.name)).toEqual(["search_tools", "call_tool"]);
    expect(letta.diagnostics.report).toHaveBeenCalledWith(expect.objectContaining({
      severity: "warning",
      message: expect.stringContaining('Direct tools for "fixture" are configured but metadata cache is missing'),
    }));

    await dispose?.();
  });

  it("registers and invokes a cache-backed HTTP bearer direct tool", async () => {
    const fixture = await startHttpFixture(join(process.cwd(), "tests/fixtures/http-streamable-fixture.mjs"), { env: { REQUIRE_BEARER: "expected-token" } });
    const { home, cwd } = tempWorkspace();
    writeConfig(cwd, { remote: { url: fixture.url, auth: "bearer", bearerTokenEnv: "MY_TOKEN", directTools: ["echo"] } });
    const runtime = createAdapterRuntime({ home, env: { MY_TOKEN: "expected-token" }, timeoutMs: 2_000 });
    try {
      await runtime.connectAndRefresh({ cwd }, "remote");
      const { letta, registeredTools } = fakeLetta();
      const dispose = activate(letta, runtime, { activationCwd: cwd });
      const directTool = registeredTools.find((tool) => tool.name === "remote_echo");

      expect(directTool).toBeDefined();
      const output = await directTool!.run({ cwd, args: { message: "hello bearer" } as never });

      expect(output).toBe('Called "remote_echo" on "remote".\n\nhello bearer');
      await dispose?.();
    } finally {
      await runtime.closeAll();
      await fixture.stop();
    }
  });

  it("registers and invokes a cache-backed OAuth direct tool without leaking secrets", async () => {
    const fixture = await startOAuthFixture();
    const { home, cwd } = tempWorkspace();
    writeConfig(cwd, {
      remote: {
        url: fixture.url,
        auth: "oauth",
        oauth: { clientId: "client-id", clientSecret: "client-secret-test-value", redirectUri: fixture.redirectUri, scope: "read write" },
        directTools: ["echo"],
      },
    });
    const runtime = createAdapterRuntime({ home, now: () => 1_234, timeoutMs: 2_000 });
    try {
      await executeMcpCommand("auth-start remote", runtime, { cwd });
      const authorizationUrl = loadOAuthStore({ home, serverName: "remote", serverUrl: fixture.url })?.authorizationUrl;
      const redirectUrl = await fixture.authorize(authorizationUrl!);
      await executeMcpCommand(`auth-complete remote ${redirectUrl}`, runtime, { cwd });
      await runtime.connectAndRefresh({ cwd }, "remote");

      const { letta, registeredTools } = fakeLetta();
      const dispose = activate(letta, runtime, { activationCwd: cwd });
      const directTool = registeredTools.find((tool) => tool.name === "remote_echo");

      expect(directTool).toBeDefined();
      const output = await directTool!.run({ cwd, args: { message: "hello oauth" } as never });

      expect(output).toBe('Called "remote_echo" on "remote".\n\nhello oauth');
      expect(output).not.toContain("client-secret-test-value");
      expect(output).not.toContain("fixture-access-token");
      expect(output).not.toContain("fixture-refresh-token");
      await dispose?.();
    } finally {
      await runtime.closeAll();
      await fixture.stop();
    }
  });
});
