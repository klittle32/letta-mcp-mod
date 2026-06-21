export type ParseArgsResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; message: string };

export function parseProxyArgs(raw: string | undefined, toolName: string): ParseArgsResult {
  if (raw === undefined || raw.trim() === "") return { ok: true, value: {} };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      message: `Invalid args JSON for "${toolName}": expected a JSON object string, e.g. {"key":"value"}.\nParse error: ${message}`,
    };
  }

  if (Array.isArray(parsed)) {
    return { ok: false, message: `Invalid args for "${toolName}": args must parse to a JSON object, not an array.` };
  }
  if (parsed === null) {
    return { ok: false, message: `Invalid args for "${toolName}": args must parse to a JSON object, not null.` };
  }
  if (typeof parsed !== "object") {
    return { ok: false, message: `Invalid args for "${toolName}": args must parse to a JSON object, not ${typeof parsed}.` };
  }

  return { ok: true, value: parsed as Record<string, unknown> };
}
