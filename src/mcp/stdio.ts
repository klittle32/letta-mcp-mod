import { resolve } from "node:path";
import type { ServerEntry } from "../core/config.js";
import { interpolateEnvRecord, resolveConfigPath } from "../core/config.js";
import type { ConnectOptions } from "./manager.js";

export function resolveServerCwd(cwd: ServerEntry["cwd"], options: Pick<ConnectOptions, "cwd" | "home" | "env">): string | undefined {
  const resolved = resolveConfigPath(cwd, options.home, options.env);
  if (!resolved) return undefined;
  if (resolved.startsWith("/")) return resolved;
  return resolve(options.cwd, resolved);
}

export function buildServerEnv(definitionEnv: ServerEntry["env"], env: Record<string, string | undefined> = process.env): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) base[key] = value;
  }
  return { ...base, ...(definitionEnv ? interpolateEnvRecord(definitionEnv, env) : {}) };
}
