import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHttpFixture } from "./helpers/http-fixture.js";
import { startOAuthFixture } from "./helpers/oauth-fixture.js";
import { saveOAuthStore } from "../src/mcp/oauth-store.js";
import { McpServerManager, InvalidServerConfigError } from "../src/mcp/manager.js";
import { discoverServerMetadata, normalizeResources, normalizeTools } from "../src/mcp/metadata.js";
import type { ServerEntry } from "../src/core/config.js";

const repoRoot = process.cwd();
const fixtureDefinition: ServerEntry = {
  command: process.execPath,
  args: [join(repoRoot, "tests/fixtures/stdio-mcp-fixture.mjs")],
};

async function withManager<T>(fn: (manager: McpServerManager) => Promise<T>): Promise<T> {
  const manager = new McpServerManager();
  try {
    return await fn(manager);
  } finally {
    await manager.closeAll();
  }
}

describe("McpServerManager stdio", () => {
  it("connects to fixture stdio server and lists tools/resources", async () => {
    await withManager(async (manager) => {
      const connection = await manager.connect("fixture", fixtureDefinition, { cwd: repoRoot, timeoutMs: 2_000 });
      const metadata = await discoverServerMetadata(connection.client, { timeout: 2_000 });

      expect(connection.status).toBe("connected");
      expect(connection.transportKind).toBe("stdio");
      expect(metadata.tools.map((tool) => tool.name)).toEqual(["echo", "list_items", "structured_status", "fail_soft", "throw_error"]);
      expect(metadata.resources.map((resource) => resource.uri)).toEqual(["fixture://readme", "fixture://blob"]);
    });
  });


  it("calls fixture tools and reads fixture resources", async () => {
    await withManager(async (manager) => {
      const connection = await manager.connect("fixture", fixtureDefinition, { cwd: repoRoot, timeoutMs: 2_000 });

      const echo = await connection.client.callTool({ name: "echo", arguments: { message: "hello" } }, undefined, { timeout: 2_000 });
      const structured = await connection.client.callTool({ name: "structured_status", arguments: {} }, undefined, { timeout: 2_000 });
      const softFailure = await connection.client.callTool({ name: "fail_soft", arguments: {} }, undefined, { timeout: 2_000 });
      const readme = await connection.client.readResource({ uri: "fixture://readme" }, { timeout: 2_000 });

      expect(echo.content).toEqual([{ type: "text", text: "hello" }]);
      expect(structured.structuredContent).toEqual({ ok: true, source: "fixture" });
      expect(softFailure.isError).toBe(true);
      expect(readme.contents).toEqual([{ uri: "fixture://readme", text: "Fixture README content", mimeType: "text/plain" }]);
    });
  });

  it("reuses existing connection for a second connect", async () => {
    await withManager(async (manager) => {
      const first = await manager.connect("fixture", fixtureDefinition, { cwd: repoRoot, timeoutMs: 2_000 });
      const second = await manager.connect("fixture", fixtureDefinition, { cwd: repoRoot, timeoutMs: 2_000 });

      expect(second).toBe(first);
      expect(manager.getConnection("fixture")).toBe(first);
    });
  });

  it("dedupes concurrent connects to the same server", async () => {
    await withManager(async (manager) => {
      const [first, second] = await Promise.all([
        manager.connect("fixture", fixtureDefinition, { cwd: repoRoot, timeoutMs: 2_000 }),
        manager.connect("fixture", fixtureDefinition, { cwd: repoRoot, timeoutMs: 2_000 }),
      ]);

      expect(second).toBe(first);
    });
  });

  it("close(server) closes and removes connection", async () => {
    await withManager(async (manager) => {
      const connection = await manager.connect("fixture", fixtureDefinition, { cwd: repoRoot, timeoutMs: 2_000 });

      await manager.close("fixture");

      expect(connection.status).toBe("closed");
      expect(manager.getConnection("fixture")).toBeUndefined();
    });
  });

  it("closeAll closes every connection and is idempotent", async () => {
    const manager = new McpServerManager();
    const connection = await manager.connect("fixture", fixtureDefinition, { cwd: repoRoot, timeoutMs: 2_000 });

    await manager.closeAll();
    await manager.closeAll();

    expect(connection.status).toBe("closed");
    expect(manager.getConnection("fixture")).toBeUndefined();
  });

  it("broken server returns concise error and leaves no connection", async () => {
    await withManager(async (manager) => {
      await expect(
        manager.connect("broken", { command: process.execPath, args: [join(repoRoot, "tests/fixtures/broken-server.mjs")] }, { cwd: repoRoot, timeoutMs: 300 }),
      ).rejects.toThrow(/Failed to connect to "broken"/);

      expect(manager.getConnection("broken")).toBeUndefined();
    });
  });

  it("connects to streamable HTTP fixture and lists tools/resources", async () => {
    const fixture = await startHttpFixture(join(repoRoot, "tests/fixtures/http-streamable-fixture.mjs"));
    try {
      await withManager(async (manager) => {
        const connection = await manager.connect("remote", { url: fixture.url }, { cwd: repoRoot, timeoutMs: 2_000 });
        const metadata = await discoverServerMetadata(connection.client, { timeout: 2_000 });

        expect(connection.status).toBe("connected");
        expect(connection.transportKind).toBe("streamable-http");
        expect(metadata.tools.map((tool) => tool.name)).toEqual(["echo", "headers_seen", "fail_soft"]);
        expect(metadata.resources.map((resource) => resource.uri)).toEqual(["fixture://http-readme"]);
      });
    } finally {
      await fixture.stop();
    }
  });

  it("reuses existing HTTP connection for a second connect", async () => {
    const fixture = await startHttpFixture(join(repoRoot, "tests/fixtures/http-streamable-fixture.mjs"));
    try {
      await withManager(async (manager) => {
        const first = await manager.connect("remote", { url: fixture.url }, { cwd: repoRoot, timeoutMs: 2_000 });
        const second = await manager.connect("remote", { url: fixture.url }, { cwd: repoRoot, timeoutMs: 2_000 });

        expect(second).toBe(first);
        expect(manager.getConnection("remote")).toBe(first);
      });
    } finally {
      await fixture.stop();
    }
  });

  it("dedupes concurrent HTTP connects to the same server", async () => {
    const fixture = await startHttpFixture(join(repoRoot, "tests/fixtures/http-streamable-fixture.mjs"));
    try {
      await withManager(async (manager) => {
        const [first, second] = await Promise.all([
          manager.connect("remote", { url: fixture.url }, { cwd: repoRoot, timeoutMs: 2_000 }),
          manager.connect("remote", { url: fixture.url }, { cwd: repoRoot, timeoutMs: 2_000 }),
        ]);

        expect(second).toBe(first);
      });
    } finally {
      await fixture.stop();
    }
  });

  it("close(server) closes and removes HTTP connection", async () => {
    const fixture = await startHttpFixture(join(repoRoot, "tests/fixtures/http-streamable-fixture.mjs"));
    try {
      await withManager(async (manager) => {
        const connection = await manager.connect("remote", { url: fixture.url }, { cwd: repoRoot, timeoutMs: 2_000 });

        await manager.close("remote");

        expect(connection.status).toBe("closed");
        expect(manager.getConnection("remote")).toBeUndefined();
      });
    } finally {
      await fixture.stop();
    }
  });

  it("unreachable HTTP server returns concise error and leaves no connection", async () => {
    await withManager(async (manager) => {
      await expect(manager.connect("remote", { url: "http://127.0.0.1:1/mcp" }, { cwd: repoRoot, timeoutMs: 300 })).rejects.toThrow(/Failed to connect to "remote"/);

      expect(manager.getConnection("remote")).toBeUndefined();
    });
  });

  it("sends custom headers to streamable HTTP servers", async () => {
    const fixture = await startHttpFixture(join(repoRoot, "tests/fixtures/http-streamable-fixture.mjs"), {
      env: { REQUIRE_HEADER_NAME: "x-fixture-header", REQUIRE_HEADER_VALUE: "present" },
    });
    try {
      await withManager(async (manager) => {
        const connection = await manager.connect("remote", { url: fixture.url, headers: { "x-fixture-header": "present" } }, { cwd: repoRoot, timeoutMs: 2_000 });
        const result = await connection.client.callTool({ name: "headers_seen", arguments: {} }, undefined, { timeout: 2_000 });

        expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ authorization: "missing", fixture: "present" }) }]);
      });
    } finally {
      await fixture.stop();
    }
  });

  it("sends bearerTokenEnv to streamable HTTP servers", async () => {
    const fixture = await startHttpFixture(join(repoRoot, "tests/fixtures/http-streamable-fixture.mjs"), {
      env: { REQUIRE_BEARER: "secret" },
    });
    try {
      await withManager(async (manager) => {
        const connection = await manager.connect(
          "remote",
          { url: fixture.url, auth: "bearer", bearerTokenEnv: "MY_TOKEN" },
          { cwd: repoRoot, timeoutMs: 2_000, env: { MY_TOKEN: "secret" } },
        );

        expect(connection.transportKind).toBe("streamable-http");
      });
    } finally {
      await fixture.stop();
    }
  });

  it("sends literal bearerToken to streamable HTTP servers", async () => {
    const fixture = await startHttpFixture(join(repoRoot, "tests/fixtures/http-streamable-fixture.mjs"), {
      env: { REQUIRE_BEARER: "secret" },
    });
    try {
      await withManager(async (manager) => {
        const connection = await manager.connect(
          "remote",
          { url: fixture.url, auth: "bearer", bearerToken: "secret" },
          { cwd: repoRoot, timeoutMs: 2_000 },
        );

        expect(connection.transportKind).toBe("streamable-http");
      });
    } finally {
      await fixture.stop();
    }
  });

  it("uses stored OAuth access tokens for streamable HTTP servers", async () => {
    const fixture = await startOAuthFixture();
    const home = mkdtempSync(join(tmpdir(), "letta-mcp-manager-oauth-"));
    try {
      saveOAuthStore({
        home,
        serverName: "remote",
        serverUrl: fixture.url,
        store: {
          version: 1,
          serverName: "remote",
          serverUrl: fixture.url,
          updatedAt: 123,
          tokens: { access_token: "fixture-access-token", refresh_token: "fixture-refresh-token", token_type: "Bearer" },
        },
      });
      await withManager(async (manager) => {
        const connection = await manager.connect(
          "remote",
          { url: fixture.url, auth: "oauth", oauth: { clientId: "client-id", clientSecret: "client-secret-test-value", redirectUri: fixture.redirectUri } },
          { cwd: repoRoot, home, timeoutMs: 2_000 },
        );
        const result = await connection.client.callTool({ name: "headers_seen", arguments: {} }, undefined, { timeout: 2_000 });

        expect(connection.transportKind).toBe("streamable-http");
        expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ authorization: "present", fixture: "missing" }) }]);
      });
    } finally {
      await fixture.stop();
    }
  });

  it("fails missing bearerTokenEnv before connect without leaking token values", async () => {
    await withManager(async (manager) => {
      await expect(manager.connect(
        "remote",
        { url: "http://127.0.0.1:1/mcp", auth: "bearer", bearerTokenEnv: "MY_TOKEN" },
        { cwd: repoRoot, timeoutMs: 300, env: {} },
      )).rejects.toThrow('bearerTokenEnv "MY_TOKEN"');

      expect(manager.getConnection("remote")).toBeUndefined();
    });
  });

  it("wrong bearer token fails concisely without leaking the token", async () => {
    const fixture = await startHttpFixture(join(repoRoot, "tests/fixtures/http-streamable-fixture.mjs"), {
      env: { REQUIRE_BEARER: "expected-token" },
    });
    try {
      await withManager(async (manager) => {
        let message = "";
        try {
          await manager.connect(
            "remote",
            { url: fixture.url, auth: "bearer", bearerToken: "wrong-token" },
            { cwd: repoRoot, timeoutMs: 2_000 },
          );
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }

        expect(message).toContain('Failed to connect to "remote"');
        expect(message).not.toContain("wrong-token");
        expect(message).not.toContain("expected-token");
        expect(manager.getConnection("remote")).toBeUndefined();
      });
    } finally {
      await fixture.stop();
    }
  });

  it("auto mode falls back to SSE when streamable HTTP fails", async () => {
    const fixture = await startHttpFixture(join(repoRoot, "tests/fixtures/http-sse-fixture.mjs"));
    try {
      await withManager(async (manager) => {
        const connection = await manager.connect("remote", { url: fixture.url }, { cwd: repoRoot, timeoutMs: 2_000 });
        const metadata = await discoverServerMetadata(connection.client, { timeout: 2_000 });

        expect(connection.transportKind).toBe("sse");
        expect(metadata.tools.map((tool) => tool.name)).toEqual(["echo", "headers_seen"]);
      });
    } finally {
      await fixture.stop();
    }
  });

  it("forced SSE mode skips streamable HTTP and connects directly", async () => {
    const fixture = await startHttpFixture(join(repoRoot, "tests/fixtures/http-sse-fixture.mjs"));
    try {
      await withManager(async (manager) => {
        const connection = await manager.connect("remote", { url: fixture.url, transport: "sse" }, { cwd: repoRoot, timeoutMs: 2_000 });

        expect(connection.transportKind).toBe("sse");
      });
    } finally {
      await fixture.stop();
    }
  });

  it("forced streamable HTTP mode does not fallback to SSE", async () => {
    const fixture = await startHttpFixture(join(repoRoot, "tests/fixtures/http-sse-fixture.mjs"));
    try {
      await withManager(async (manager) => {
        await expect(manager.connect("remote", { url: fixture.url, transport: "streamable-http" }, { cwd: repoRoot, timeoutMs: 2_000 })).rejects.toThrow(/Streamable HTTP failed/);

        expect(manager.getConnection("remote")).toBeUndefined();
      });
    } finally {
      await fixture.stop();
    }
  });

  it("sends custom headers on SSE initial stream and POST requests", async () => {
    const fixture = await startHttpFixture(join(repoRoot, "tests/fixtures/http-sse-fixture.mjs"), {
      env: { REQUIRE_HEADER_NAME: "x-fixture-header", REQUIRE_HEADER_VALUE: "present" },
    });
    try {
      await withManager(async (manager) => {
        const connection = await manager.connect(
          "remote",
          { url: fixture.url, transport: "sse", headers: { "x-fixture-header": "present" } },
          { cwd: repoRoot, timeoutMs: 2_000 },
        );
        const result = await connection.client.callTool({ name: "headers_seen", arguments: {} }, undefined, { timeout: 2_000 });

        expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ authorization: "missing", fixture: "present" }) }]);
      });
    } finally {
      await fixture.stop();
    }
  });

  it("sends bearer token on SSE initial stream and POST requests", async () => {
    const fixture = await startHttpFixture(join(repoRoot, "tests/fixtures/http-sse-fixture.mjs"), {
      env: { REQUIRE_BEARER: "secret" },
    });
    try {
      await withManager(async (manager) => {
        const connection = await manager.connect(
          "remote",
          { url: fixture.url, transport: "sse", auth: "bearer", bearerTokenEnv: "MY_TOKEN" },
          { cwd: repoRoot, timeoutMs: 2_000, env: { MY_TOKEN: "secret" } },
        );
        const result = await connection.client.callTool({ name: "headers_seen", arguments: {} }, undefined, { timeout: 2_000 });

        expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ authorization: "present", fixture: "missing" }) }]);
      });
    } finally {
      await fixture.stop();
    }
  });

  it("when both streamable and SSE fail, error mentions both attempts without secrets", async () => {
    await withManager(async (manager) => {
      let message = "";
      try {
        await manager.connect("remote", { url: "http://127.0.0.1:1/sse", auth: "bearer", bearerToken: "secret-token" }, { cwd: repoRoot, timeoutMs: 300 });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).toContain("Streamable HTTP failed");
      expect(message).toContain("SSE fallback failed");
      expect(message).not.toContain("secret-token");
      expect(manager.getConnection("remote")).toBeUndefined();
    });
  });

  it("rejects server missing command and url as invalid", async () => {
    await withManager(async (manager) => {
      await expect(manager.connect("empty", {}, { cwd: repoRoot })).rejects.toBeInstanceOf(InvalidServerConfigError);
    });
  });

  it("resolves relative cwd against invocation cwd", async () => {
    await withManager(async (manager) => {
      const connection = await manager.connect(
        "fixture",
        { command: process.execPath, args: ["stdio-mcp-fixture.mjs"], cwd: "tests/fixtures" },
        { cwd: repoRoot, timeoutMs: 2_000 },
      );
      const metadata = await discoverServerMetadata(connection.client, { timeout: 2_000 });

      expect(metadata.tools.map((tool) => tool.name)).toContain("echo");
    });
  });
});

describe("metadata normalization", () => {
  it("normalizes SDK tools to cached tools preserving name, description, and schema", () => {
    const tools = normalizeTools([
      { name: "echo", description: "Echo a message", inputSchema: { type: "object", properties: { message: { type: "string" } } } },
    ]);

    expect(tools).toEqual([
      { name: "echo", description: "Echo a message", inputSchema: { type: "object", properties: { message: { type: "string" } } } },
    ]);
  });

  it("normalizes resources preserving uri, name, and description", () => {
    expect(normalizeResources([{ uri: "fixture://readme", name: "Fixture README", description: "Read resource" }])).toEqual([
      { uri: "fixture://readme", name: "Fixture README", description: "Read resource" },
    ]);
  });

  it("omits missing optional descriptions consistently", () => {
    expect(normalizeTools([{ name: "ping", inputSchema: { type: "object" } }])).toEqual([
      { name: "ping", inputSchema: { type: "object" } },
    ]);
    expect(normalizeResources([{ uri: "fixture://x", name: "X" }])).toEqual([{ uri: "fixture://x", name: "X" }]);
  });
});
