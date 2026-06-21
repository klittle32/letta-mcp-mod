import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getConfigSources,
  interpolateEnvVars,
  loadMcpConfig,
  mergeConfigs,
  resolveConfigPath,
} from "../src/core/config.js";

function tempHome() {
  const root = mkdtempSync(join(tmpdir(), "letta-mcp-config-"));
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

describe("config loading", () => {
  it("returns empty config when no config files exist", () => {
    const { home, cwd } = tempHome();
    const loaded = loadMcpConfig({ home, cwd });

    expect(loaded.config).toEqual({ mcpServers: {} });
    expect(loaded.warnings).toEqual([]);
    expect(loaded.sources).toHaveLength(4);
    expect(loaded.sources.every((source) => source.exists === false)).toBe(true);
  });

  it("loads user-global standard MCP config", () => {
    const { home, cwd } = tempHome();
    writeJson(join(home, ".config", "mcp", "mcp.json"), {
      mcpServers: { filesystem: { command: "npx", args: ["server"] } },
    });

    const loaded = loadMcpConfig({ home, cwd });

    expect(loaded.config.mcpServers.filesystem.command).toBe("npx");
    expect(loaded.config.mcpServers.filesystem.args).toEqual(["server"]);
    expect(loaded.sources[0]).toMatchObject({ exists: true, loaded: true });
  });

  it("loads project .mcp.json", () => {
    const { home, cwd } = tempHome();
    writeJson(join(cwd, ".mcp.json"), {
      mcpServers: { project: { command: "node", args: ["project-server.js"] } },
    });

    const loaded = loadMcpConfig({ home, cwd });

    expect(Object.keys(loaded.config.mcpServers)).toEqual(["project"]);
    expect(loaded.config.mcpServers.project.command).toBe("node");
  });

  it("later project config overrides earlier global config for the same server", () => {
    const { home, cwd } = tempHome();
    writeJson(join(home, ".config", "mcp", "mcp.json"), {
      mcpServers: { shared: { command: "global", args: ["a"] } },
    });
    writeJson(join(cwd, ".mcp.json"), {
      mcpServers: { shared: { command: "project", args: ["b"] } },
    });

    const loaded = loadMcpConfig({ home, cwd });

    expect(loaded.config.mcpServers.shared).toEqual({ command: "project", args: ["b"] });
  });

  it("settings merge with later settings overriding earlier settings", () => {
    const merged = mergeConfigs(
      { mcpServers: {}, settings: { toolPrefix: "server", idleTimeout: 10 } },
      { mcpServers: {}, settings: { toolPrefix: "short" } },
    );

    expect(merged.settings).toEqual({ toolPrefix: "short", idleTimeout: 10 });
  });

  it("invalid JSON produces warning and skips file", () => {
    const { home, cwd } = tempHome();
    mkdirSync(join(cwd), { recursive: true });
    writeFileSync(join(cwd, ".mcp.json"), "{not json");

    const loaded = loadMcpConfig({ home, cwd });

    expect(loaded.config).toEqual({ mcpServers: {} });
    expect(loaded.warnings.some((warning) => warning.includes("Invalid JSON"))).toBe(true);
  });

  it("invalid mcpServers shape produces warning and skips file", () => {
    const { home, cwd } = tempHome();
    writeJson(join(cwd, ".mcp.json"), { mcpServers: [] });

    const loaded = loadMcpConfig({ home, cwd });

    expect(loaded.config).toEqual({ mcpServers: {} });
    expect(loaded.warnings.some((warning) => warning.includes("mcpServers"))).toBe(true);
  });

  it("interpolates ${VAR} and $env:VAR", () => {
    expect(interpolateEnvVars("${TOKEN}:$env:USER", { TOKEN: "abc", USER: "kyle" })).toBe("abc:kyle");
  });

  it("interpolates OAuth config string fields", () => {
    const { home, cwd } = tempHome();
    writeJson(join(cwd, ".mcp.json"), {
      mcpServers: {
        remote: {
          url: "https://example.com/mcp",
          auth: "oauth",
          oauth: {
            grantType: "authorization_code",
            clientId: "${CLIENT_ID}",
            clientSecret: "$env:CLIENT_SECRET",
            tokenUrl: "https://${TOKEN_HOST}/token",
            audience: "${AUDIENCE}",
            scope: "${SCOPE}",
            redirectUri: "http://127.0.0.1:${PORT}/callback",
            clientName: "${CLIENT_NAME}",
            clientUri: "https://${CLIENT_HOST}/app",
          },
        },
      },
    });

    const loaded = loadMcpConfig({
      home,
      cwd,
      env: {
        CLIENT_ID: "client-id",
        CLIENT_SECRET: "client-secret",
        TOKEN_HOST: "auth.example.com",
        AUDIENCE: "api://default",
        SCOPE: "read write",
        PORT: "3334",
        CLIENT_NAME: "Letta MCP Adapter",
        CLIENT_HOST: "client.example.com",
      },
    });

    expect(loaded.config.mcpServers.remote.oauth).toEqual({
      grantType: "authorization_code",
      clientId: "client-id",
      clientSecret: "client-secret",
      tokenUrl: "https://auth.example.com/token",
      audience: "api://default",
      scope: "read write",
      redirectUri: "http://127.0.0.1:3334/callback",
      clientName: "Letta MCP Adapter",
      clientUri: "https://client.example.com/app",
    });
  });

  it("preserves oauth false during normalization", () => {
    const { home, cwd } = tempHome();
    writeJson(join(cwd, ".mcp.json"), {
      mcpServers: { remote: { url: "https://example.com/mcp", auth: false, oauth: false } },
    });

    const loaded = loadMcpConfig({ home, cwd });

    expect(loaded.config.mcpServers.remote.oauth).toBe(false);
  });

  it("expands ~ for config paths after env interpolation", () => {
    expect(resolveConfigPath("~/${PROJECT}", "/home/test", { PROJECT: "repo" })).toBe("/home/test/repo");
  });

  it("config source statuses include path and exists boolean", () => {
    const { home, cwd } = tempHome();
    const sources = getConfigSources({ home, cwd });

    expect(sources.map((source) => source.path)).toEqual([
      join(home, ".config", "mcp", "mcp.json"),
      join(home, ".letta", "mcp-adapter", "mcp.json"),
      join(cwd, ".mcp.json"),
      join(cwd, ".letta", "mcp.json"),
    ]);
    expect(sources.every((source) => typeof source.exists === "boolean")).toBe(true);
  });
});
