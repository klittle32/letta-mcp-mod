import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdapterRuntime } from "../src/runtime.js";
import { executeMcpProxy, MCP_PROXY_PARAMETERS } from "../src/features/proxy-tool.js";
import { loadOAuthStore } from "../src/mcp/oauth-store.js";
import { startOAuthFixture } from "./helpers/oauth-fixture.js";

function tempWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "letta-mcp-proxy-oauth-"));
  const home = join(root, "home");
  const cwd = join(root, "workspace");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return { home, cwd };
}

describe("proxy OAuth action routing", () => {
  it("routes auth-start and auth-complete through the proxy tool", async () => {
    const fixture = await startOAuthFixture();
    const { home, cwd } = tempWorkspace();
    try {
      writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({
        mcpServers: {
          linear: { url: fixture.url, auth: "oauth", oauth: { clientId: "client-id", clientSecret: "client-secret-test-value", redirectUri: fixture.redirectUri } },
        },
      }, null, 2));
      const runtime = createAdapterRuntime({ home });
      const ctx = { cwd, args: { action: "auth-start", server: "linear" } };
      const start = await executeMcpProxy(ctx.args, runtime.loadState(ctx), runtime, ctx);
      expect(start).toContain("OAuth authorization started");
      const authorizationUrl = loadOAuthStore({ home, serverName: "linear", serverUrl: fixture.url })?.authorizationUrl;
      const redirectUrl = await fixture.authorize(authorizationUrl!);
      const completeArgs = { action: "auth-complete", server: "linear", args: JSON.stringify({ redirectUrl }), tool: "ignored", connect: "ignored" };
      const complete = await executeMcpProxy(completeArgs, runtime.loadState({ cwd, args: completeArgs }), runtime, { cwd, args: completeArgs });
      expect(complete).toContain("OAuth authorization complete");
    } finally {
      await fixture.stop();
    }
  });

  it("describes supported OAuth actions in the schema", () => {
    expect(MCP_PROXY_PARAMETERS.properties.action.description).toContain("auth-start");
    expect(MCP_PROXY_PARAMETERS.properties.action.description).not.toContain("Not implemented in Slice 3");
  });
});
