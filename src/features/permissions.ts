import path from "node:path";
import type { ApprovalDecision, McpApprovalSettings } from "../core/config.js";
import { findToolByName, normalizeToolName, type ToolMetadata } from "../core/tool-names.js";
import type { AdapterRuntime } from "../runtime.js";
import { collectDirectToolDescriptors, type DirectToolDescriptor } from "./direct-tools.js";
import type { ProxyState } from "./proxy-tool.js";

export type PermissionDecision = ApprovalDecision;

export const DEFAULT_APPROVAL_SETTINGS: Required<McpApprovalSettings> = {
  dangerousTools: "ask",
  unknownServers: "deny",
  configWrites: "alwaysAsk",
};

export interface NormalizedApprovalSettings {
  approval: Required<McpApprovalSettings>;
  warnings: string[];
}

export interface LettaPermissionEvent {
  agentId: string | null;
  conversationId: string | null;
  toolCallId: string | null;
  toolName: string;
  args: Record<string, unknown>;
  cwd: string;
  workingDirectory: string;
  permissionMode: string | null;
  phase: "approval" | "execution";
}

export interface PermissionCheckResult {
  decision: PermissionDecision;
  reason?: string;
}

export interface PermissionDecisionContext {
  directToolNames?: Iterable<string>;
  tracker?: ApprovalTracker;
}

export interface LettaPermissionApi {
  capabilities?: { permissions?: boolean; [key: string]: unknown };
  permissions?: {
    register(permission: {
      id: string;
      description: string;
      check(event: LettaPermissionEvent, ctx?: { signal?: AbortSignal; [key: string]: unknown }): PermissionCheckResult | undefined | Promise<PermissionCheckResult | undefined>;
    }): () => void;
  };
  diagnostics?: { report(message: unknown): void };
}

const APPROVAL_KEYS = ["dangerousTools", "unknownServers", "configWrites"] as const;
const VALID_DECISIONS = new Set<PermissionDecision>(["allow", "ask", "alwaysAsk", "deny"]);
const DANGEROUS_TOOL_PATTERN = /delete|write|update|exec|run|shell|browser/i;
const PATH_LIKE_KEYS = new Set(["path", "file", "filename", "dir", "directory", "cwd", "root", "target", "dest", "destination"]);

export function normalizeApprovalSettings(settings: unknown): NormalizedApprovalSettings {
  const approval: Required<McpApprovalSettings> = { ...DEFAULT_APPROVAL_SETTINGS };
  const warnings: string[] = [];
  if (!isRecord(settings)) return { approval, warnings };

  for (const key of APPROVAL_KEYS) {
    const value = settings[key];
    if (value === undefined) continue;
    if (isApprovalDecision(value)) {
      approval[key] = value;
      continue;
    }
    warnings.push(`Invalid MCP approval setting "${key}": expected allow, ask, alwaysAsk, or deny.`);
  }

  return { approval, warnings };
}

export class ApprovalTracker {
  private approvals = new Map<string, string>();

  remember(event: LettaPermissionEvent, fingerprint: string): void {
    if (!event.toolCallId) return;
    this.approvals.set(event.toolCallId, fingerprint);
    if (this.approvals.size > 1_000) {
      const oldest = this.approvals.keys().next().value;
      if (oldest) this.approvals.delete(oldest);
    }
  }

  consume(event: LettaPermissionEvent, fingerprint: string): boolean {
    if (!event.toolCallId) return false;
    const matched = this.approvals.get(event.toolCallId) === fingerprint;
    if (matched) this.approvals.delete(event.toolCallId);
    return matched;
  }
}

export function decideMcpPermission(event: LettaPermissionEvent, state: ProxyState, context: PermissionDecisionContext = {}): PermissionCheckResult | undefined {
  const result = decideMcpPermissionWithoutTracking(event, state, context);
  return applyApprovalTracking(event, result, context.tracker);
}

export function registerMcpPermissions(options: {
  letta: LettaPermissionApi;
  runtime: AdapterRuntime;
  directToolNames?: Iterable<string>;
}): (() => void) | undefined {
  const { letta, runtime } = options;
  if (!letta.capabilities?.permissions || !letta.permissions) return undefined;

  const tracker = new ApprovalTracker();
  const directToolNames = options.directToolNames ? new Set(options.directToolNames) : undefined;
  return letta.permissions.register({
    id: "letta-mcp-adapter-permissions",
    description: "Apply MCP adapter safety policy to proxy and direct MCP tool calls.",
    async check(event) {
      try {
        const state = runtime.loadState({ cwd: event.cwd });
        return decideMcpPermission(event, state, { tracker, directToolNames });
      } catch (error) {
        return { decision: "deny", reason: `MCP permission check failed: ${error instanceof Error ? error.message : String(error)}` };
      }
    },
  });
}

function decideMcpPermissionWithoutTracking(event: LettaPermissionEvent, state: ProxyState, context: PermissionDecisionContext): PermissionCheckResult | undefined {
  const { approval } = normalizeApprovalSettings(state.config.settings?.approval);
  if (event.toolName !== "mcp") return decideDirectToolCall(event, state, approval, context);

  const connectServer = getString(event.args.connect);
  if (connectServer) {
    if (!state.servers.has(connectServer)) return unknownServerDecision(connectServer, approval.unknownServers);
    return { decision: "ask", reason: `Connecting MCP server "${connectServer}" may start external processes or network connections.` };
  }

  const serverName = getString(event.args.server);
  if (serverName && !state.servers.has(serverName)) {
    return unknownServerDecision(serverName, approval.unknownServers);
  }

  const action = getString(event.args.action);
  if (action) {
    if (action === "auth-status") return { decision: "allow", reason: "MCP OAuth status is read-only." };
    if (action === "auth-start" || action === "auth-complete" || action === "auth-clear") {
      return { decision: "ask", reason: `MCP OAuth action "${action}" may change authentication state.` };
    }
    return { decision: "allow", reason: "Unsupported MCP actions are handled without live MCP calls." };
  }

  const toolName = getString(event.args.tool);
  if (toolName) return decideProxyToolCall(toolName, event, state, approval);

  if (serverName && !event.args.tool && !event.args.connect && !event.args.action) {
    return { decision: "allow", reason: "MCP server listing is read-only." };
  }

  if (!event.args.tool && !event.args.connect && !event.args.action) {
    return { decision: "allow", reason: "MCP status/search/describe is read-only." };
  }

  return { decision: "allow", reason: "MCP operation allowed." };
}

function applyApprovalTracking(
  event: LettaPermissionEvent,
  result: PermissionCheckResult | undefined,
  tracker: ApprovalTracker | undefined,
): PermissionCheckResult | undefined {
  if (!result || !tracker) return result;
  if (result.decision !== "ask" && result.decision !== "alwaysAsk") return result;

  const fingerprint = createApprovalFingerprint(event, result);
  if (event.phase === "approval") {
    tracker.remember(event, fingerprint);
    return result;
  }

  if (event.phase === "execution") {
    if (tracker.consume(event, fingerprint)) {
      return { decision: "allow", reason: "Risky MCP call was approved before execution." };
    }
    return { decision: "deny", reason: "Risky MCP call reached execution without a matching prior approval." };
  }

  return result;
}

function createApprovalFingerprint(event: LettaPermissionEvent, result: PermissionCheckResult): string {
  return stableStringify({
    toolName: event.toolName,
    args: event.args,
    cwd: event.cwd,
    workingDirectory: event.workingDirectory,
    decision: result.decision,
    reason: result.reason ?? "",
  });
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function decideDirectToolCall(
  event: LettaPermissionEvent,
  state: ProxyState,
  approval: Required<McpApprovalSettings>,
  context: PermissionDecisionContext,
): PermissionCheckResult | undefined {
  const descriptor = collectDirectToolDescriptors(state).descriptors.find((candidate) => candidate.name === event.toolName);
  if (!descriptor) {
    if (context.directToolNames && new Set(context.directToolNames).has(event.toolName)) {
      return { decision: "deny", reason: `MCP direct tool "${event.toolName}" is no longer present in current cached metadata.` };
    }
    return undefined;
  }

  if (isDangerousDirectTool(descriptor)) {
    return { decision: approval.dangerousTools, reason: `MCP direct tool "${event.toolName}" is potentially dangerous.` };
  }

  if (hasPathOutsideWorkingDirectory(event.args, event.cwd || event.workingDirectory)) {
    return { decision: approval.dangerousTools, reason: `MCP direct tool "${event.toolName}" uses a path outside the working directory.` };
  }

  return { decision: "allow", reason: `MCP direct tool "${event.toolName}" is allowed by policy.` };
}

function isDangerousDirectTool(descriptor: DirectToolDescriptor): boolean {
  return isDangerousToolName(descriptor.name) || isDangerousToolName(descriptor.originalName);
}

function decideProxyToolCall(
  toolName: string,
  event: LettaPermissionEvent,
  state: ProxyState,
  approval: Required<McpApprovalSettings>,
): PermissionCheckResult {
  const parsedArgs = parseProxyArgs(event.args.args);
  const resolution = resolveCachedTool(state, toolName, getString(event.args.server));
  if (!resolution.ok) return { decision: resolution.decision ?? "deny", reason: resolution.reason };

  if (isDangerousToolName(resolution.tool.name) || isDangerousToolName(resolution.tool.originalName)) {
    return { decision: approval.dangerousTools, reason: `MCP tool "${toolName}" is potentially dangerous.` };
  }

  if (hasPathOutsideWorkingDirectory(parsedArgs, event.cwd || event.workingDirectory)) {
    return { decision: approval.dangerousTools, reason: `MCP tool "${toolName}" uses a path outside the working directory.` };
  }

  return { decision: "allow", reason: `MCP tool "${toolName}" is allowed by policy.` };
}

type ToolResolution =
  | { ok: true; serverName: string; tool: ToolMetadata }
  | { ok: false; reason: string; decision?: PermissionDecision };

function resolveCachedTool(state: ProxyState, toolName: string, serverHint: string | undefined): ToolResolution {
  if (serverHint) {
    const server = state.servers.get(serverHint);
    if (!server) return { ok: false, decision: normalizeApprovalSettings(state.config.settings?.approval).approval.unknownServers, reason: `MCP server "${serverHint}" is not configured.` };
    const tool = findToolByName(server.tools, toolName) ?? server.tools.find((candidate) => normalizeToolName(candidate.originalName) === normalizeToolName(toolName));
    if (!tool) return { ok: false, reason: `MCP tool "${toolName}" was not found in cached metadata.` };
    return { ok: true, serverName: server.name, tool };
  }

  const matches: Array<{ serverName: string; tool: ToolMetadata }> = [];
  for (const server of state.servers.values()) {
    const tool = findToolByName(server.tools, toolName) ?? server.tools.find((candidate) => normalizeToolName(candidate.originalName) === normalizeToolName(toolName));
    if (tool) matches.push({ serverName: server.name, tool });
  }
  if (matches.length === 1) return { ok: true, ...matches[0] };
  if (matches.length > 1) return { ok: false, reason: `MCP tool "${toolName}" matched multiple cached servers; provide a server hint.` };
  return { ok: false, reason: `MCP tool "${toolName}" was not found in cached metadata.` };
}

export function isDangerousToolName(name: string): boolean {
  return DANGEROUS_TOOL_PATTERN.test(name);
}

function parseProxyArgs(value: unknown): unknown {
  if (value === undefined || value === null || value === "") return {};
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

export function hasPathOutsideWorkingDirectory(value: unknown, cwd: string): boolean {
  const base = path.resolve(cwd || process.cwd());
  return inspectPathLikeValue(value, base, undefined);
}

function inspectPathLikeValue(value: unknown, base: string, key: string | undefined): boolean {
  if (Array.isArray(value)) return value.some((item) => inspectPathLikeValue(item, base, key));
  if (!isRecord(value)) return isPathLikeKey(key) && typeof value === "string" && isOutsideBase(value, base);
  for (const [childKey, childValue] of Object.entries(value)) {
    if (inspectPathLikeValue(childValue, base, childKey)) return true;
  }
  return false;
}

function isPathLikeKey(key: string | undefined): boolean {
  if (!key) return false;
  return PATH_LIKE_KEYS.has(key.toLowerCase());
}

function isOutsideBase(value: string, base: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || isUrlLike(trimmed)) return false;
  const resolved = path.resolve(base, trimmed);
  return !isPathInside(base, resolved);
}

function isPathInside(base: string, candidate: string): boolean {
  const relative = path.relative(base, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isUrlLike(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

function unknownServerDecision(serverName: string, decision: PermissionDecision): PermissionCheckResult {
  return { decision, reason: `MCP server "${serverName}" is not configured.` };
}

function isApprovalDecision(value: unknown): value is PermissionDecision {
  return typeof value === "string" && VALID_DECISIONS.has(value as PermissionDecision);
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
