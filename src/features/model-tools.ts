import type { LettaToolDefinition } from "../mod.js";
import { MAX_MAX_OUTPUT_CHARS, MIN_MAX_OUTPUT_CHARS } from "../core/output-guard.js";
import type { AdapterRuntime, RuntimeToolContext } from "../runtime.js";
import {
  executeSearch,
  formatRuntimeCallToolResult,
  type SearchToolsArgs,
} from "./tool-catalog.js";

export interface CallToolArgs {
  name: string;
  args: Record<string, unknown>;
  maxOutput?: number;
}

export const SEARCH_TOOLS_PARAMETERS = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Describe the external capability you need.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 50,
      description: "Maximum number of matching tools to return. Defaults to 10.",
    },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

export const CALL_TOOL_PARAMETERS = {
  type: "object",
  properties: {
    name: {
      type: "string",
      description: "Callable tool name returned by search_tools.",
    },
    args: {
      type: "object",
      description: "Arguments matching the tool's input schema from search_tools.",
      additionalProperties: true,
    },
    maxOutput: {
      type: "integer",
      minimum: MIN_MAX_OUTPUT_CHARS,
      maximum: MAX_MAX_OUTPUT_CHARS,
      description: "Optional character limit for this result. Defaults to the configured output guard.",
    },
  },
  required: ["name", "args"],
  additionalProperties: false,
} as const;

export function createSearchToolsTool(runtime: AdapterRuntime): LettaToolDefinition {
  return {
    name: "search_tools",
    description: "Find external integrations, APIs, and services available to you. Returns callable names, descriptions, and argument schemas. Use before call_tool. These integrations are already available through this tool; do not convert them to skills.",
    parameters: SEARCH_TOOLS_PARAMETERS,
    requiresApproval: false,
    parallelSafe: false,
    async run(ctx) {
      if (ctx.signal?.aborted) return "Tool search cancelled.";
      const parsed = parseSearchArgs(ctx.args);
      if (!parsed.ok) return parsed.message;

      const runtimeCtx: RuntimeToolContext = { cwd: ctx.cwd, signal: ctx.signal };
      let state = runtime.loadState(runtimeCtx);
      const refreshFailures: string[] = [];

      for (const server of state.servers.values()) {
        if (server.cacheValid) continue;
        if (ctx.signal?.aborted) return "Tool search cancelled.";
        try {
          await runtime.connectAndRefresh(runtimeCtx, server.name);
        } catch (error) {
          refreshFailures.push(`${server.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      state = runtime.loadState(runtimeCtx);
      return executeSearch(state, parsed.value, refreshFailures);
    },
  };
}

export function createCallToolTool(runtime: AdapterRuntime): LettaToolDefinition {
  return {
    name: "call_tool",
    description: "Run an external integration returned by search_tools. Pass the callable name and arguments matching the schema from search_tools.",
    parameters: CALL_TOOL_PARAMETERS,
    requiresApproval: true,
    parallelSafe: false,
    async run(ctx) {
      if (ctx.signal?.aborted) return "Tool call cancelled.";
      const parsed = parseCallArgs(ctx.args);
      if (!parsed.ok) return parsed.message;

      const runtimeCtx: RuntimeToolContext = { cwd: ctx.cwd, signal: ctx.signal };
      const state = runtime.loadState(runtimeCtx);
      const result = await runtime.callTool(
        runtimeCtx,
        state,
        parsed.value.name,
        parsed.value.args,
        parsed.value.maxOutput === undefined ? undefined : { maxOutput: parsed.value.maxOutput },
      );
      return formatRuntimeCallToolResult(result);
    },
  };
}

function parseSearchArgs(args: Record<string, unknown> | undefined):
  | { ok: true; value: SearchToolsArgs }
  | { ok: false; message: string } {
  const query = args?.query;
  if (typeof query !== "string" || !query.trim()) {
    return { ok: false, message: "search_tools requires a non-empty query." };
  }

  const limit = args?.limit;
  if (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 50)) {
    return { ok: false, message: "search_tools limit must be an integer from 1 to 50." };
  }
  return { ok: true, value: { query, ...(typeof limit === "number" ? { limit } : {}) } };
}

function parseCallArgs(args: Record<string, unknown> | undefined):
  | { ok: true; value: CallToolArgs }
  | { ok: false; message: string } {
  const name = args?.name;
  if (typeof name !== "string" || !name.trim()) {
    return { ok: false, message: "call_tool requires a tool name returned by search_tools." };
  }

  const toolArgs = args?.args;
  if (!isRecord(toolArgs)) {
    return { ok: false, message: "call_tool args must be an object matching the tool's input schema." };
  }
  const maxOutput = args?.maxOutput;
  if (maxOutput !== undefined && (
    typeof maxOutput !== "number"
    || !Number.isInteger(maxOutput)
    || maxOutput < MIN_MAX_OUTPUT_CHARS
    || maxOutput > MAX_MAX_OUTPUT_CHARS
  )) {
    return {
      ok: false,
      message: `call_tool maxOutput must be an integer from ${MIN_MAX_OUTPUT_CHARS} to ${MAX_MAX_OUTPUT_CHARS}.`,
    };
  }
  return {
    ok: true,
    value: {
      name,
      args: toolArgs,
      ...(typeof maxOutput === "number" ? { maxOutput } : {}),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
