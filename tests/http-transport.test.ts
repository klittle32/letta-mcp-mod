import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadMcpConfig, type ServerEntry } from "../src/core/config.js";
import { InvalidServerConfigError } from "../src/mcp/manager.js";
import {
  mergeHeaders,
  resolveBearerToken,
  resolveHttpHeaders,
  resolveHttpMode,
  resolveHttpUrl,
} from "../src/mcp/http.js";

function tempConfigWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "letta-mcp-http-config-"));
  const home = join(root, "home");
  const cwd = join(root, "workspace");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return { root, home, cwd };
}

describe("resolveHttpUrl", () => {
  it("accepts http URLs", () => {
    expect(resolveHttpUrl("remote", { url: "http://localhost:3001/mcp" }).href).toBe("http://localhost:3001/mcp");
  });

  it("accepts https URLs", () => {
    expect(resolveHttpUrl("remote", { url: "https://example.com/mcp" }).href).toBe("https://example.com/mcp");
  });

  it("rejects non-URL strings", () => {
    expect(() => resolveHttpUrl("remote", { url: "not a url" })).toThrow(InvalidServerConfigError);
    expect(() => resolveHttpUrl("remote", { url: "not a url" })).toThrow('Server "remote" has invalid URL');
  });

  it("rejects non-http protocols", () => {
    expect(() => resolveHttpUrl("remote", { url: "ftp://example.com/mcp" })).toThrow(InvalidServerConfigError);
    expect(() => resolveHttpUrl("remote", { url: "ftp://example.com/mcp" })).toThrow('unsupported URL protocol "ftp:"');
  });
});

describe("resolveHttpMode", () => {
  it("defaults to auto", () => {
    expect(resolveHttpMode({ url: "http://localhost/mcp" })).toBe("auto");
  });

  it("accepts streamable-http and sse", () => {
    expect(resolveHttpMode({ url: "http://localhost/mcp", transport: "streamable-http" } as ServerEntry)).toBe("streamable-http");
    expect(resolveHttpMode({ url: "http://localhost/mcp", transport: "sse" } as ServerEntry)).toBe("sse");
  });

  it("rejects unknown transport modes", () => {
    expect(() => resolveHttpMode({ url: "http://localhost/mcp", transport: "websocket" } as unknown as ServerEntry)).toThrow(InvalidServerConfigError);
  });
});

describe("resolveBearerToken", () => {
  it("returns token from bearerTokenEnv when set", () => {
    expect(resolveBearerToken("remote", { auth: "bearer", bearerTokenEnv: "MY_TOKEN" }, { MY_TOKEN: "from-env" })).toBe("from-env");
  });

  it("returns token from bearerToken when no env field is configured", () => {
    expect(resolveBearerToken("remote", { auth: "bearer", bearerToken: "literal" }, {})).toBe("literal");
  });

  it("bearerTokenEnv takes precedence over bearerToken", () => {
    expect(resolveBearerToken("remote", { auth: "bearer", bearerTokenEnv: "MY_TOKEN", bearerToken: "literal" }, { MY_TOKEN: "from-env" })).toBe("from-env");
  });

  it("auth bearer without a resolved token throws", () => {
    expect(() => resolveBearerToken("remote", { auth: "bearer" }, {})).toThrow(InvalidServerConfigError);
    expect(() => resolveBearerToken("remote", { auth: "bearer" }, {})).toThrow("requires bearer auth but no bearer token was resolved");
  });

  it("missing bearerTokenEnv throws without leaking token values", () => {
    expect(() => resolveBearerToken("remote", { auth: "bearer", bearerTokenEnv: "MY_TOKEN" }, {})).toThrow(InvalidServerConfigError);
    expect(() => resolveBearerToken("remote", { auth: "bearer", bearerTokenEnv: "MY_TOKEN" }, {})).toThrow('bearerTokenEnv "MY_TOKEN"');
  });

  it("returns undefined when bearer auth is not configured", () => {
    expect(resolveBearerToken("remote", { url: "http://localhost/mcp" }, {})).toBeUndefined();
  });
});

describe("resolveHttpHeaders", () => {
  it("preserves custom headers", () => {
    expect(resolveHttpHeaders("remote", { headers: { "x-fixture-header": "present" } }, {})).toEqual({ "x-fixture-header": "present" });
  });

  it("adds Authorization when bearer is configured", () => {
    expect(resolveHttpHeaders("remote", { auth: "bearer", bearerTokenEnv: "MY_TOKEN" }, { MY_TOKEN: "secret" })).toMatchObject({
      Authorization: "Bearer secret",
    });
  });

  it("bearer Authorization overrides user-provided Authorization", () => {
    expect(resolveHttpHeaders(
      "remote",
      { auth: "bearer", bearerToken: "secret", headers: { Authorization: "Bearer wrong", "x-other": "ok" } },
      {},
    )).toEqual({ Authorization: "Bearer secret", "x-other": "ok" });
  });

  it("headers and bearerToken interpolate through loadMcpConfig", () => {
    const { home, cwd } = tempConfigWorkspace();
    writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({
      mcpServers: {
        remote: {
          url: "http://localhost:3001/mcp",
          auth: "bearer",
          bearerToken: "${TOKEN}",
          headers: {
            "x-one": "${ONE}",
            "x-two": "$env:TWO",
          },
        },
      },
    }));

    const loaded = loadMcpConfig({ cwd, home, env: { TOKEN: "secret", ONE: "1", TWO: "2" } });

    expect(resolveHttpHeaders("remote", loaded.config.mcpServers.remote, {})).toEqual({
      Authorization: "Bearer secret",
      "x-one": "1",
      "x-two": "2",
    });
  });
});

describe("mergeHeaders", () => {
  it("merges plain object headers into existing HeadersInit", () => {
    const headers = mergeHeaders(new Headers({ accept: "text/event-stream" }), { Authorization: "Bearer secret", "x-fixture": "yes" });

    expect(new Headers(headers).get("accept")).toBe("text/event-stream");
    expect(new Headers(headers).get("authorization")).toBe("Bearer secret");
    expect(new Headers(headers).get("x-fixture")).toBe("yes");
  });
});
