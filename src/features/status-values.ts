import type { AdapterRuntime } from "../runtime.js";
import type { LettaModApi } from "../mod.js";

export function formatMcpStatusValue(runtime: AdapterRuntime, cwd: string): string {
  return formatMcpStatusText(runtime.loadState({ cwd }));
}

export function registerMcpStatusValues(options: { letta: LettaModApi; runtime: AdapterRuntime; activationCwd: string }): Array<() => void> {
  const { letta, runtime, activationCwd } = options;
  if (!letta.capabilities?.ui || typeof letta.capabilities.ui !== "object") return [];
  if (!(letta.capabilities.ui as { statusValues?: boolean }).statusValues || !letta.ui) return [];

  try {
    const state = runtime.loadState({ cwd: activationCwd });
    if (state.config.settings?.ui?.status === false) return [];
    letta.ui.setStatus("mcp", formatMcpStatusText(state));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    letta.ui.setStatus("mcp", `error: ${message}`);
  }

  return [() => letta.ui?.clearStatus("mcp")];
}

function formatMcpStatusText(state: ReturnType<AdapterRuntime["loadState"]>): string {
  const configured = state.servers.size;
  const cachedTools = [...state.servers.values()].reduce((sum, server) => sum + server.tools.length, 0);
  const staleOrMissing = [...state.servers.values()].filter((server) => !server.cacheValid).length;
  const warningSuffix = state.warnings.length > 0 ? `, ${state.warnings.length} warning${state.warnings.length === 1 ? "" : "s"}` : "";
  const staleSuffix = staleOrMissing > 0 ? `, ${staleOrMissing} stale/missing` : "";
  return `${configured} server${configured === 1 ? "" : "s"}, ${cachedTools} tool${cachedTools === 1 ? "" : "s"}${staleSuffix}${warningSuffix}`;
}
