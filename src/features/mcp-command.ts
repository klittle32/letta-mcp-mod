import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { loadMcpConfig } from "../core/config.js";
import { createAdapterRuntime, type AdapterRuntime, type RuntimeToolContext } from "../runtime.js";
import { executeOAuthAction, type OAuthAction } from "./oauth-actions.js";
import { executeStatus, type ProxyState } from "./proxy-tool.js";

export type ParsedMcpCommand =
  | { kind: "status" }
  | { kind: "tools" }
  | { kind: "reconnect"; serverName?: string }
  | { kind: "oauth"; action: OAuthAction; serverName?: string; rawArgs?: string }
  | { kind: "setup"; create: boolean }
  | { kind: "help" }
  | { kind: "error"; message: string };

export function parseMcpCommandArgs(rawArgs: string | undefined): ParsedMcpCommand {
  const trimmed = rawArgs?.trim() ?? "";
  if (!trimmed) return { kind: "status" };

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const [command, ...rest] = tokens;

  switch (command) {
    case "status":
      return rest.length === 0 ? { kind: "status" } : usageError("/mcp status does not accept extra arguments.");
    case "tools":
      return rest.length === 0 ? { kind: "tools" } : usageError("/mcp tools does not accept extra arguments.");
    case "reconnect":
      if (rest.length === 0) return { kind: "reconnect" };
      if (rest.length === 1) return { kind: "reconnect", serverName: rest[0] };
      return usageError("/mcp reconnect accepts at most one server name.");
    case "auth-start":
      return rest.length === 1 ? { kind: "oauth", action: "auth-start", serverName: rest[0] } : usageError("/mcp auth-start requires exactly one server name.");
    case "auth-complete": {
      const match = trimmed.match(/^auth-complete\s+(\S+)\s+([\s\S]+)$/);
      if (!match) return usageError("/mcp auth-complete requires a server name and redirected URL.");
      return { kind: "oauth", action: "auth-complete", serverName: match[1], rawArgs: JSON.stringify({ redirectUrl: match[2].trim() }) };
    }
    case "auth-status":
      if (rest.length === 0) return { kind: "oauth", action: "auth-status" };
      if (rest.length === 1) return { kind: "oauth", action: "auth-status", serverName: rest[0] };
      return usageError("/mcp auth-status accepts at most one server name.");
    case "setup":
      if (rest.length === 0) return { kind: "setup", create: false };
      if (rest.length === 1 && (rest[0] === "create" || rest[0] === "--write")) return { kind: "setup", create: true };
      return usageError("/mcp setup accepts only 'create' or '--write'.");
    case "help":
    case "--help":
      return rest.length === 0 ? { kind: "help" } : usageError(`/mcp ${command} does not accept extra arguments.`);
    default:
      return { kind: "error", message: `Unknown /mcp command "${command}".\n\n${formatCommandHelp()}` };
  }
}

export function formatCommandHelp(): string {
  return [
    "Usage:",
    "- /mcp — show MCP adapter status",
    "- /mcp status — show MCP adapter status",
    "- /mcp tools — list cached MCP tools",
    "- /mcp reconnect — reconnect and refresh all configured servers",
    "- /mcp reconnect <server> — reconnect and refresh one server",
    "- /mcp auth-start <server> — start OAuth login for one server",
    "- /mcp auth-complete <server> <redirectUrl> — finish OAuth login with the redirected URL",
    "- /mcp auth-status <server> — show OAuth token status for one server",
    "- /mcp setup — show config paths and starter .mcp.json",
    "- /mcp setup create — create a starter project .mcp.json if missing",
  ].join("\n");
}

function usageError(message: string): ParsedMcpCommand {
  return { kind: "error", message: `${message}\n\n${formatCommandHelp()}` };
}


export function formatStatusCommand(state: ProxyState): string {
  return [
    "MCP Adapter",
    "",
    executeStatus(state),
    "",
    "Commands:",
    "- /mcp tools — list cached MCP tools",
    "- /mcp reconnect — reconnect and refresh all configured servers",
    "- /mcp reconnect <server> — reconnect and refresh one server",
    "- /mcp auth-start <server> — start OAuth login for one server",
    "- /mcp auth-complete <server> <redirectUrl> — finish OAuth login",
    "- /mcp setup — show config paths and starter .mcp.json",
  ].join("\n");
}

export function formatToolsCommand(state: ProxyState): string {
  if (state.servers.size === 0) {
    return [
      "Cached MCP tools",
      "",
      "No MCP servers configured.",
      "Run /mcp setup to see config paths and a starter .mcp.json.",
    ].join("\n");
  }

  const serversWithTools = [...state.servers.values()].filter((server) => server.tools.length > 0);
  if (serversWithTools.length === 0) {
    const firstServer = state.servers.keys().next().value as string | undefined;
    const reconnectOne = firstServer ? ` or /mcp reconnect ${firstServer}` : "";
    return [
      "Cached MCP tools",
      "",
      "No cached MCP tools are available.",
      `Run /mcp reconnect${reconnectOne} to refresh metadata.`,
    ].join("\n");
  }

  const lines = ["Cached MCP tools"];
  for (const server of serversWithTools) {
    lines.push("", `${server.name}:`);
    for (const tool of server.tools) {
      lines.push(`- ${tool.name} — ${tool.description || "(no description)"}`);
    }
  }
  return lines.join("\n");
}


export interface McpCommandContext {
  cwd: string;
  args?: string;
  signal?: AbortSignal;
  home?: string;
  env?: Record<string, string | undefined>;
  [key: string]: unknown;
}

export function starterMcpConfigJson(): string {
  return `${JSON.stringify({
    mcpServers: {
      example: {
        command: "node",
        args: ["path/to/mcp-server.js"],
      },
    },
  }, null, 2)}\n`;
}

export function formatSetupCommand(ctx: Pick<McpCommandContext, "cwd" | "home" | "env">): string {
  const home = ctx.home ?? homedir();
  const loaded = loadMcpConfig({ cwd: ctx.cwd, home, env: ctx.env });
  const lines = ["MCP setup", "", "Config sources, in merge order:"];

  for (const source of loaded.sources) {
    const status = source.exists ? source.loaded ? "exists, loaded" : "exists, not loaded" : "missing";
    lines.push(`- [${status}] ${source.kind}: ${source.path}`);
  }

  if (loaded.warnings.length > 0) {
    lines.push("", "Warnings:", ...loaded.warnings.map((warning) => `- ${warning}`));
  }

  lines.push(
    "",
    "Recommended for this project:",
    join(ctx.cwd, ".mcp.json"),
    "",
    "Example .mcp.json:",
    starterMcpConfigJson().trimEnd(),
    "",
    "To create a starter project config, run:",
    "/mcp setup create",
  );

  return lines.join("\n");
}


export type CreateStarterResult = { ok: true; path: string; message: string } | { ok: false; path: string; message: string };

export function createStarterProjectConfig(ctx: Pick<McpCommandContext, "cwd">): CreateStarterResult {
  const path = join(ctx.cwd, ".mcp.json");
  if (existsSync(path)) {
    return {
      ok: false,
      path,
      message: [`MCP config already exists:`, path, "", "Plain /mcp setup shows config paths and starter JSON."].join("\n"),
    };
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, starterMcpConfigJson());
  return {
    ok: true,
    path,
    message: [
      "Created starter MCP config:",
      path,
      "",
      'Edit the "example" server command/args, then run:',
      "/mcp reconnect example",
    ].join("\n"),
  };
}


export async function executeReconnectCommand(
  runtime: AdapterRuntime,
  ctx: McpCommandContext,
  state: ProxyState,
  serverName?: string,
): Promise<string> {
  if (ctx.signal?.aborted) return "MCP command cancelled.";

  if (serverName) {
    if (!state.servers.has(serverName)) {
      return `Server "${serverName}" is not configured. Use /mcp status to list configured servers.`;
    }
    return reconnectOne(runtime, ctx, serverName);
  }

  const serverNames = [...state.servers.keys()];
  if (serverNames.length === 0) {
    return ["MCP reconnect", "", "No MCP servers configured.", "Run /mcp setup to see config paths and a starter .mcp.json."].join("\n");
  }

  const lines = ["MCP reconnect", ""];
  let successCount = 0;
  for (const name of serverNames) {
    if (ctx.signal?.aborted) {
      lines.push("MCP command cancelled.");
      break;
    }
    const result = await reconnectOneRaw(runtime, ctx, name);
    if (result.ok) {
      successCount += 1;
      lines.push(`[ok] ${name}: cached ${result.tools} ${plural(result.tools, "tool")}, ${result.resources} ${plural(result.resources, "resource")}`);
    } else {
      lines.push(`[error] ${name}: ${result.message}`);
    }
  }
  lines.push("", `Refreshed ${successCount}/${serverNames.length} ${plural(serverNames.length, "server")}.`);
  return lines.join("\n");
}

async function reconnectOne(runtime: AdapterRuntime, ctx: McpCommandContext, serverName: string): Promise<string> {
  const result = await reconnectOneRaw(runtime, ctx, serverName);
  if (!result.ok) return result.message;
  return [
    `MCP reconnect: ${serverName}`,
    "",
    `Connected to "${serverName}" and cached ${result.tools} ${plural(result.tools, "tool")}, ${result.resources} ${plural(result.resources, "resource")}.`,
    `Cache: ${result.cachePath}`,
  ].join("\n");
}

async function reconnectOneRaw(
  runtime: AdapterRuntime,
  ctx: McpCommandContext,
  serverName: string,
): Promise<{ ok: true; tools: number; resources: number; cachePath: string } | { ok: false; message: string }> {
  try {
    const runtimeCtx: RuntimeToolContext = { cwd: ctx.cwd, signal: ctx.signal };
    const result = await runtime.connectAndRefresh(runtimeCtx, serverName);
    return { ok: true, tools: result.tools.length, resources: result.resources.length, cachePath: result.cachePath };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}


export interface LettaCommandResult {
  type: "output";
  output: string;
}

export interface LettaCommandDefinition {
  id: string;
  description: string;
  args?: string;
  run(ctx: McpCommandContext): Promise<LettaCommandResult> | LettaCommandResult;
}

export function createMcpCommand(runtime: AdapterRuntime = createAdapterRuntime()): LettaCommandDefinition {
  return {
    id: "mcp",
    description: "Show MCP adapter status, list cached tools, reconnect servers, manage OAuth login, and display setup guidance.",
    args: "[status|tools|reconnect [server]|auth-start <server>|auth-complete <server> <redirectUrl>|auth-status [server]|setup [create|--write]|help]",
    async run(ctx) {
      if (ctx.signal?.aborted) return { type: "output", output: "MCP command cancelled." };
      const output = await executeMcpCommand(ctx.args, runtime, ctx);
      return { type: "output", output };
    },
  };
}

export async function executeMcpCommand(rawArgs: string | undefined, runtime: AdapterRuntime, ctx: McpCommandContext): Promise<string> {
  if (ctx.signal?.aborted) return "MCP command cancelled.";

  const parsed = parseMcpCommandArgs(rawArgs);
  switch (parsed.kind) {
    case "status":
      return formatStatusCommand(runtime.loadState({ cwd: ctx.cwd, signal: ctx.signal }));
    case "tools":
      return formatToolsCommand(runtime.loadState({ cwd: ctx.cwd, signal: ctx.signal }));
    case "reconnect":
      return executeReconnectCommand(runtime, ctx, runtime.loadState({ cwd: ctx.cwd, signal: ctx.signal }), parsed.serverName);
    case "oauth": {
      const runtimeCtx: RuntimeToolContext = { cwd: ctx.cwd, signal: ctx.signal, args: { action: parsed.action, server: parsed.serverName, args: parsed.rawArgs } };
      return executeOAuthAction({ action: parsed.action, serverName: parsed.serverName, rawArgs: parsed.rawArgs, runtime, ctx: runtimeCtx, state: runtime.loadState(runtimeCtx) });
    }
    case "setup":
      return parsed.create ? createStarterProjectConfig(ctx).message : formatSetupCommand(ctx);
    case "help":
      return formatCommandHelp();
    case "error":
      return parsed.message;
  }
}
