import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeServerHash,
  emptyMetadataCache,
  getMetadataCachePath,
  getServerCacheEntry,
  isServerCacheValid,
  loadMetadataCache,
  reconstructToolMetadata,
  saveMetadataCache,
  updateServerCache,
  updateServerProtocolCache,
  type MetadataCache,
} from "../src/core/cache.js";
import type { ServerEntry } from "../src/core/config.js";
import { createProxyState } from "../src/features/tool-catalog.js";

function tempHome() {
  const home = mkdtempSync(join(tmpdir(), "letta-mcp-cache-"));
  return home;
}

function writeJson(path: string, value: unknown) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

describe("metadata cache", () => {
  const identityHash = "identity";

  it("missing cache returns null", () => {
    expect(loadMetadataCache({ home: tempHome() })).toBeNull();
  });

  it("empty cache helper returns versioned empty cache", () => {
    expect(emptyMetadataCache()).toEqual({ version: 2, servers: {} });
  });

  it("invalid cache JSON returns null with warning", () => {
    const home = tempHome();
    const cachePath = getMetadataCachePath(home);
    mkdirSync(join(cachePath, ".."), { recursive: true });
    writeFileSync(cachePath, "not json");
    const warnings: string[] = [];

    expect(loadMetadataCache({ home, warnings })).toBeNull();
    expect(warnings.some((warning) => warning.includes("Invalid cache JSON"))).toBe(true);
  });

  it("rejects version 1 caches so they rebuild lazily", () => {
    const home = tempHome();
    const cachePath = getMetadataCachePath(home);
    writeJson(cachePath, { version: 1, servers: {} });
    const warnings: string[] = [];

    expect(loadMetadataCache({ home, warnings })).toBeNull();
    expect(warnings).toEqual([`Invalid cache shape in ${cachePath}.`]);
  });

  it("valid cache loads", () => {
    const home = tempHome();
    const cache: MetadataCache = {
      version: 2,
      servers: {
        filesystem: {
          public: { configHash: "abc", cachedAt: 1, tools: [], resources: [], cacheScope: "public" },
          private: {},
        },
      },
    };
    writeJson(getMetadataCachePath(home), cache);

    expect(loadMetadataCache({ home })).toEqual(cache);
  });

  it("saveMetadataCache creates parent directory and round-trips", () => {
    const home = tempHome();
    const cache: MetadataCache = {
      version: 2,
      servers: {
        filesystem: {
          public: { configHash: "abc", cachedAt: 1, tools: [{ name: "read_file" }], resources: [], cacheScope: "public" },
          private: {},
        },
      },
    };

    saveMetadataCache({ home, cache });

    expect(existsSync(getMetadataCachePath(home))).toBe(true);
    expect(loadMetadataCache({ home })).toEqual(cache);
  });

  it("saveMetadataCache writes stable pretty JSON", () => {
    const home = tempHome();
    saveMetadataCache({ home, cache: { version: 2, servers: {} } });

    expect(readFileSync(getMetadataCachePath(home), "utf8")).toBe('{\n  "servers": {},\n  "version": 2\n}\n');
  });

  it("updateServerCache sets hash, timestamp, tools, and resources", () => {
    const definition: ServerEntry = { command: "npx", args: ["server"] };
    const updated = updateServerCache({
      cache: { version: 2, servers: {} },
      serverName: "filesystem",
      definition,
      identityHash,
      tools: [{ name: "read_file", description: "Read" }],
      resources: [{ name: "README", uri: "file:///README.md" }],
      cacheScope: "public",
      now: 12_345,
    });

    expect(updated.servers.filesystem.public).toEqual({
      configHash: computeServerHash(definition),
      cachedAt: 12_345,
      tools: [{ name: "read_file", description: "Read" }],
      resources: [{ name: "README", uri: "file:///README.md" }],
      cacheScope: "public",
    });
  });

  it("updateServerCache preserves other servers and does not mutate original cache", () => {
    const original: MetadataCache = {
      version: 2,
      servers: {
        other: {
          public: { configHash: "other", cachedAt: 1, tools: [], resources: [], cacheScope: "public" },
          private: {},
        },
      },
    };

    const updated = updateServerCache({
      cache: original,
      serverName: "filesystem",
      definition: { command: "npx" },
      identityHash,
      tools: [],
      resources: [],
      cacheScope: "public",
      now: 2,
    });

    expect(updated.servers.other).toEqual(original.servers.other);
    expect(updated.servers.filesystem.public?.cachedAt).toBe(2);
    expect(original.servers.filesystem).toBeUndefined();
  });

  it("updates negotiated protocol without discarding cached metadata", () => {
    const definition: ServerEntry = { command: "npx", args: ["server"] };
    const cache = updateServerCache({
      cache: emptyMetadataCache(),
      serverName: "filesystem",
      definition,
      identityHash,
      tools: [{ name: "read_file" }],
      resources: [{ name: "README", uri: "file:///README.md" }],
      cacheScope: "public",
      now: 100,
    });

    const updated = updateServerProtocolCache({
      cache,
      serverName: "filesystem",
      definition,
      identityHash,
      protocol: { era: "legacy", version: "2025-11-25" },
      now: 200,
    });

    expect(updated.servers.filesystem.public).toMatchObject({
      cachedAt: 100,
      tools: [{ name: "read_file" }],
      resources: [{ name: "README", uri: "file:///README.md" }],
      protocol: { era: "legacy", version: "2025-11-25" },
    });
  });

  it("server hash is stable independent of object key order", () => {
    const a: ServerEntry = { command: "npx", args: ["server"], env: { B: "2", A: "1" } };
    const b: ServerEntry = { env: { A: "1", B: "2" }, args: ["server"], command: "npx" };

    expect(computeServerHash(a)).toBe(computeServerHash(b));
  });

  it("server hash changes when identity fields change", () => {
    const base: ServerEntry = { command: "npx", args: ["server"], url: "http://localhost", env: { A: "1" } };
    const changed: ServerEntry = { ...base, args: ["other"] };

    expect(computeServerHash(base)).not.toBe(computeServerHash(changed));
  });

  it("server hash changes when catalog filters change but not for approval policy", () => {
    const base: ServerEntry = { command: "npx", args: ["server"] };

    expect(computeServerHash(base)).not.toBe(computeServerHash({ ...base, includeTools: ["read_*"] }));
    expect(computeServerHash(base)).not.toBe(computeServerHash({ ...base, excludeTools: ["delete_*"] }));
    expect(computeServerHash(base)).toBe(computeServerHash({ ...base, approveTools: ["delete_*"] }));
  });

  it("server hash does not change when runtime/direct fields change", () => {
    const base: ServerEntry = { command: "npx", args: ["server"] };
    const changed: ServerEntry = { ...base, lifecycle: "keep-alive", idleTimeout: 1, debug: true, directTools: true };

    expect(computeServerHash(base)).toBe(computeServerHash(changed));
  });

  it("cache validity checks hash and age", () => {
    const definition: ServerEntry = { command: "npx", args: ["server"] };
    const entry = { configHash: computeServerHash(definition), cachedAt: 1_000, tools: [], resources: [] };

    expect(isServerCacheValid(entry, definition, { now: 2_000, maxAgeMs: 2_000 })).toBe(true);
    expect(isServerCacheValid(entry, definition, { now: 10_000, maxAgeMs: 2_000 })).toBe(false);
    expect(isServerCacheValid(entry, { command: "node" }, { now: 2_000, maxAgeMs: 2_000 })).toBe(false);
  });

  it("honours server TTL including immediate staleness", () => {
    const definition: ServerEntry = { command: "npx", args: ["server"] };
    const entry = {
      configHash: computeServerHash(definition),
      cachedAt: 1_000,
      ttlMs: 500,
      cacheScope: "public" as const,
      tools: [],
      resources: [],
    };

    expect(isServerCacheValid(entry, definition, { now: 1_500 })).toBe(true);
    expect(isServerCacheValid(entry, definition, { now: 1_501 })).toBe(false);
    expect(isServerCacheValid({ ...entry, ttlMs: 0 }, definition, { now: 1_000 })).toBe(false);
  });

  it("isolates private entries by identity while sharing public entries", () => {
    const definition: ServerEntry = { url: "https://example.test/mcp", auth: "bearer" };
    let cache = updateServerCache({
      cache: emptyMetadataCache(),
      serverName: "remote",
      definition,
      identityHash: "token-a",
      tools: [{ name: "private_a" }],
      resources: [],
      cacheScope: "private",
    });

    expect(getServerCacheEntry(cache, "remote", "token-a")?.tools[0]?.name).toBe("private_a");
    expect(getServerCacheEntry(cache, "remote", "token-b")).toBeUndefined();

    cache = updateServerCache({
      cache,
      serverName: "remote",
      definition,
      identityHash: "token-b",
      tools: [{ name: "public_tool" }],
      resources: [],
      cacheScope: "public",
    });
    expect(getServerCacheEntry(cache, "remote", "token-a")?.tools[0]?.name).toBe("private_a");
    expect(getServerCacheEntry(cache, "remote", "token-b")?.tools[0]?.name).toBe("public_tool");
    expect(getServerCacheEntry(cache, "remote", "token-c")?.tools[0]?.name).toBe("public_tool");
  });

  it("surfaces persisted metadata warnings through proxy state", () => {
    const definition: ServerEntry = { command: "node" };
    const cache = updateServerCache({
      cache: emptyMetadataCache(),
      serverName: "fixture",
      definition,
      identityHash,
      tools: [],
      resources: [],
      cacheScope: "public",
      warnings: ['Server "fixture": Dropped external tool "invalid" because its annotations are invalid.'],
      now: 1_000,
    });

    const state = createProxyState({
      config: { mcpServers: { fixture: definition } },
      cache,
      now: 1_000,
    });
    expect(state.warnings).toEqual([
      'Server "fixture": Dropped external tool "invalid" because its annotations are invalid.',
    ]);
  });

  it("reconstruct metadata includes cached tools", () => {
    const metadata = reconstructToolMetadata(
      "filesystem",
      { configHash: "x", cachedAt: 1, tools: [{ name: "read_file", description: "Read file", inputSchema: { type: "object" } }], resources: [] },
      "server",
      {},
    );

    expect(metadata).toEqual([
      { name: "filesystem_read_file", originalName: "read_file", description: "Read file", inputSchema: { type: "object" } },
    ]);
  });

  it("reconstruct metadata includes selected tools and resources before applying exclusions", () => {
    const metadata = reconstructToolMetadata(
      "filesystem",
      {
        configHash: "x",
        cachedAt: 1,
        tools: [{ name: "read_file" }, { name: "read_secret" }, { name: "write_file" }],
        resources: [{ name: "README", uri: "file:///README.md" }, { name: "Secrets", uri: "file:///secrets" }],
      },
      "server",
      {
        includeTools: ["read_*", "get_readme"],
        excludeTools: ["*_secret", "get_secrets"],
      },
    );

    expect(metadata.map((tool) => tool.originalName)).toEqual(["read_file", "get_readme"]);
  });

  it("reconstruct metadata preserves title, annotations, output schema, and icons", () => {
    const metadata = reconstructToolMetadata(
      "filesystem",
      {
        configHash: "x",
        cachedAt: 1,
        tools: [{
          name: "inspect",
          title: "Inspect safely",
          annotations: { readOnlyHint: true },
          outputSchema: { type: "object" },
          icons: [{ src: "https://example.test/icon.svg" }],
        }],
        resources: [],
      },
      "server",
      {},
    );

    expect(metadata[0]).toMatchObject({
      title: "Inspect safely",
      annotations: { readOnlyHint: true },
      outputSchema: { type: "object" },
      icons: [{ src: "https://example.test/icon.svg" }],
    });
  });

  it("reconstruct metadata includes resources as synthetic tools when exposeResources is not false", () => {
    const metadata = reconstructToolMetadata(
      "filesystem",
      { configHash: "x", cachedAt: 1, tools: [], resources: [{ name: "Project README.md", uri: "file:///README.md" }] },
      "server",
      {},
    );

    expect(metadata[0]).toMatchObject({
      name: "filesystem_get_project_readme_md",
      originalName: "get_project_readme_md",
      resourceUri: "file:///README.md",
    });
  });

  it("reconstruct metadata omits excluded tools and resources", () => {
    const metadata = reconstructToolMetadata(
      "filesystem",
      {
        configHash: "x",
        cachedAt: 1,
        tools: [{ name: "read_file" }, { name: "write_file" }],
        resources: [{ name: "Secret", uri: "file:///secret" }],
      },
      "server",
      { excludeTools: ["write_file", "filesystem_get_secret"] },
    );

    expect(metadata.map((tool) => tool.originalName)).toEqual(["read_file"]);
  });
});

describe("HTTP cache identity", () => {
  it("server hash changes when URL changes", () => {
    expect(computeServerHash({ url: "http://localhost:3001/mcp" })).not.toBe(computeServerHash({ url: "http://localhost:3002/mcp" }));
  });

  it("server hash changes when headers change", () => {
    expect(computeServerHash({ url: "http://localhost/mcp", headers: { "x-fixture": "one" } })).not.toBe(
      computeServerHash({ url: "http://localhost/mcp", headers: { "x-fixture": "two" } }),
    );
  });

  it("server hash changes when auth mode changes", () => {
    expect(computeServerHash({ url: "http://localhost/mcp", auth: false })).not.toBe(
      computeServerHash({ url: "http://localhost/mcp", auth: "bearer", bearerToken: "token" }),
    );
  });

  it("server hash excludes bearer identity values", () => {
    const definition: ServerEntry = { url: "http://localhost/mcp", auth: "bearer", bearerTokenEnv: "MY_TOKEN" };

    expect(computeServerHash(definition, { env: { MY_TOKEN: "one" } })).toBe(
      computeServerHash(definition, { env: { MY_TOKEN: "two" } }),
    );
  });

  it("server hash changes when HTTP transport mode changes", () => {
    expect(computeServerHash({ url: "http://localhost/mcp", transport: "streamable-http" })).not.toBe(
      computeServerHash({ url: "http://localhost/mcp", transport: "sse" }),
    );
  });

  it("server hash changes when protocol negotiation mode changes", () => {
    expect(computeServerHash({ url: "http://localhost/mcp", protocolVersion: "legacy" })).not.toBe(
      computeServerHash({ url: "http://localhost/mcp", protocolVersion: "auto" }),
    );
  });

  it("server hash changes when OAuth client id changes", () => {
    expect(computeServerHash({ url: "http://localhost/mcp", auth: "oauth", oauth: { clientId: "one" } })).not.toBe(
      computeServerHash({ url: "http://localhost/mcp", auth: "oauth", oauth: { clientId: "two" } }),
    );
  });

  it("server hash excludes OAuth client secret values", () => {
    const definition: ServerEntry = {
      url: "http://localhost/mcp",
      auth: "oauth",
      oauth: { clientId: "client", clientSecret: "${CLIENT_SECRET}" },
    };

    expect(computeServerHash(definition, { env: { CLIENT_SECRET: "one" } })).toBe(
      computeServerHash(definition, { env: { CLIENT_SECRET: "two" } }),
    );
  });

  it("server hash changes when OAuth redirect URI changes", () => {
    expect(computeServerHash({ url: "http://localhost/mcp", auth: "oauth", oauth: { redirectUri: "http://127.0.0.1:1/callback" } })).not.toBe(
      computeServerHash({ url: "http://localhost/mcp", auth: "oauth", oauth: { redirectUri: "http://127.0.0.1:2/callback" } }),
    );
  });

  it("server hash does not depend on persisted OAuth tokens", () => {
    const definition: ServerEntry = { url: "http://localhost/mcp", auth: "oauth", oauth: { clientId: "client" } };

    expect(computeServerHash(definition, { home: "/tmp/home-a" })).toBe(computeServerHash(definition, { home: "/tmp/home-b" }));
  });
});
