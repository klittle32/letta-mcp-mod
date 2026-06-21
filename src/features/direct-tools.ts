import { formatToolName, normalizeToolName, type ToolMetadata } from "../core/tool-names.js";
import type { AdapterRuntime, RuntimeToolContext } from "../runtime.js";
import type { LettaModApi, LettaToolDefinition } from "../mod.js";
import { formatRuntimeCallToolResult, type ProxyServerState, type ProxyState } from "./proxy-tool.js";

const LETTA_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export interface DirectToolDescriptor {
  name: string;
  serverName: string;
  originalName: string;
  description: string;
  parameters: unknown;
  resourceUri?: string;
}

export interface DirectToolDescriptorCollection {
  descriptors: DirectToolDescriptor[];
  warnings: string[];
}

export function collectDirectToolDescriptors(state: ProxyState): DirectToolDescriptorCollection {
  const descriptors: DirectToolDescriptor[] = [];
  const warnings: string[] = [];
  const usedNames = new Set<string>(["mcp"]);

  for (const server of state.servers.values()) {
    const selection = getDirectToolSelection(state, server);
    if (!selection.enabled) continue;

    if (!server.cacheEntry || !server.cacheValid) {
      const cacheState = server.cacheEntry ? "stale" : "missing";
      warnings.push(`Direct tools for "${server.name}" are configured but metadata cache is ${cacheState}. Run /mcp reconnect ${server.name} then /reload.`);
      continue;
    }

    for (const tool of server.tools) {
      if (!isSelectedDirectTool(selection, state, server.name, tool)) continue;
      const validation = validateDirectToolName(tool.name, usedNames);
      if (!validation.ok) {
        warnings.push(validation.warning);
        continue;
      }
      usedNames.add(tool.name);
      descriptors.push({
        name: tool.name,
        serverName: server.name,
        originalName: tool.originalName,
        description: tool.description || `Call MCP tool ${tool.originalName} on ${server.name}.`,
        parameters: tool.resourceUri ? emptyObjectSchema() : (tool.inputSchema ?? emptyObjectSchema()),
        ...(tool.resourceUri ? { resourceUri: tool.resourceUri } : {}),
      });
    }
  }

  return { descriptors, warnings };
}

export function createDirectMcpTool(descriptor: DirectToolDescriptor, runtime: AdapterRuntime): LettaToolDefinition {
  return {
    name: descriptor.name,
    description: descriptor.description || `Call MCP tool ${descriptor.originalName} on ${descriptor.serverName}.`,
    parameters: normalizeDirectToolParameters(descriptor),
    requiresApproval: true,
    parallelSafe: false,
    async run(ctx) {
      if (ctx.signal?.aborted) return "MCP request cancelled.";
      const state = runtime.loadState(ctx);
      const invocationCtx: RuntimeToolContext = {
        cwd: ctx.cwd,
        args: { server: descriptor.serverName },
        signal: ctx.signal,
      };
      const rawArgs = JSON.stringify(ctx.args ?? {});
      const result = await runtime.callTool(invocationCtx, state, descriptor.name, rawArgs);
      return formatRuntimeCallToolResult(result);
    },
  };
}

export function registerCachedDirectTools(options: {
  letta: LettaModApi;
  runtime: AdapterRuntime;
  activationCwd: string;
}): Array<() => void> {
  const { letta, runtime, activationCwd } = options;
  if (!letta.capabilities?.tools || !letta.tools) return [];

  let collection: DirectToolDescriptorCollection;
  try {
    const state = runtime.loadState({ cwd: activationCwd });
    collection = collectDirectToolDescriptors(state);
  } catch (error) {
    reportWarning(letta, `Failed to load cached MCP direct tools: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }

  for (const warning of collection.warnings) {
    reportWarning(letta, warning);
  }

  const disposers: Array<() => void> = [];
  for (const descriptor of collection.descriptors) {
    try {
      disposers.push(letta.tools.register(createDirectMcpTool(descriptor, runtime)));
    } catch (error) {
      reportWarning(
        letta,
        `Failed to register direct MCP tool "${descriptor.name}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return disposers;
}

type DirectToolSelection =
  | { enabled: false; allowList?: undefined }
  | { enabled: true; allowList?: string[] };

function getDirectToolSelection(state: ProxyState, server: ProxyServerState): DirectToolSelection {
  const serverSetting = server.definition.directTools;
  if (serverSetting === false) return { enabled: false };
  if (serverSetting === true) return { enabled: true };
  if (Array.isArray(serverSetting)) {
    const allowList = serverSetting.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
    return allowList.length > 0 ? { enabled: true, allowList } : { enabled: false };
  }
  return state.config.settings?.directTools === true ? { enabled: true } : { enabled: false };
}

function isSelectedDirectTool(selection: DirectToolSelection, state: ProxyState, serverName: string, tool: ToolMetadata): boolean {
  if (!selection.enabled) return false;
  if (!selection.allowList) return true;
  const candidates = new Set([
    normalizeDirectToolName(tool.originalName),
    normalizeDirectToolName(tool.name),
    normalizeDirectToolName(formatToolName(tool.originalName, serverName, state.prefix)),
    normalizeDirectToolName(formatToolName(tool.originalName, serverName, "server")),
    normalizeDirectToolName(formatToolName(tool.originalName, serverName, "short")),
  ]);
  return selection.allowList.some((allowed) => candidates.has(normalizeDirectToolName(allowed)));
}

function validateDirectToolName(name: string, usedNames: Set<string>): { ok: true } | { ok: false; warning: string } {
  if (name === "mcp") {
    return { ok: false, warning: `Direct tool "${name}" skipped because it conflicts with the compact MCP proxy tool.` };
  }
  if (!LETTA_TOOL_NAME_PATTERN.test(name)) {
    return { ok: false, warning: `Direct tool "${name}" skipped because Letta tool names must be 1-64 characters using letters, numbers, underscores, or hyphens.` };
  }
  if (usedNames.has(name)) {
    return { ok: false, warning: `Direct tool "${name}" skipped because another direct tool already uses that name.` };
  }
  return { ok: true };
}

function normalizeDirectToolName(name: string): string {
  return normalizeToolName(name).toLowerCase();
}

function emptyObjectSchema(): { type: "object"; properties: Record<string, never>; additionalProperties: false } {
  return { type: "object", properties: {}, additionalProperties: false };
}

function normalizeDirectToolParameters(descriptor: DirectToolDescriptor): unknown {
  if (descriptor.resourceUri) return emptyObjectSchema();
  if (isObjectSchema(descriptor.parameters)) return descriptor.parameters;
  return { type: "object", properties: {}, additionalProperties: true };
}

function isObjectSchema(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const schema = value as Record<string, unknown>;
  return schema.type === undefined || schema.type === "object";
}

function reportWarning(letta: LettaModApi, message: string): void {
  letta.diagnostics?.report({ severity: "warning", message });
}
