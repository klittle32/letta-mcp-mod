import { randomBytes } from "node:crypto";
import { chmod, mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { McpOutputGuardSettings } from "./config.js";

export const DEFAULT_MAX_OUTPUT_CHARS = 40_000;
export const DEFAULT_RESULT_MAX_FILES = 100;
export const DEFAULT_RESULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
export const MIN_MAX_OUTPUT_CHARS = 1_000;
export const MAX_MAX_OUTPUT_CHARS = 1_000_000;

interface BinaryPayload {
  data: string;
  mimeType?: string;
  label: string;
}

export interface GuardOutputOptions {
  home?: string;
  serverName: string;
  toolName: string;
  settings?: McpOutputGuardSettings;
  maxOutput?: number;
  now?: number;
}

export interface ResolvedOutputGuardOptions {
  maxChars: number;
  maxFiles: number;
  maxAgeMs: number;
}

export function resolveOutputGuardOptions(
  settings: McpOutputGuardSettings | undefined,
  maxOutput: number | undefined,
): ResolvedOutputGuardOptions {
  return {
    maxChars: boundedInteger(maxOutput, MIN_MAX_OUTPUT_CHARS, MAX_MAX_OUTPUT_CHARS)
      ?? boundedInteger(settings?.maxChars, MIN_MAX_OUTPUT_CHARS, MAX_MAX_OUTPUT_CHARS)
      ?? DEFAULT_MAX_OUTPUT_CHARS,
    maxFiles: positiveInteger(settings?.maxFiles) ?? DEFAULT_RESULT_MAX_FILES,
    maxAgeMs: positiveInteger(settings?.maxAgeMs) ?? DEFAULT_RESULT_MAX_AGE_MS,
  };
}

export async function guardMcpOutput(
  output: string,
  rawResult: unknown,
  options: GuardOutputOptions,
): Promise<string> {
  const resolved = resolveOutputGuardOptions(options.settings, options.maxOutput);
  const binaries = collectBinaryPayloads(rawResult);
  const originalChars = output.length + binaries.reduce((total, payload) => total + payload.data.length, 0);
  if (originalChars <= resolved.maxChars) return output;

  const home = options.home ?? homedir();
  const now = options.now ?? Date.now();
  const root = join(home, ".letta", "mcp-adapter", "results");
  const writtenPaths: string[] = [];
  const writeErrors: string[] = [];
  const attemptWrite = async (artifact: Parameters<typeof writeResultArtifact>[0]): Promise<void> => {
    try {
      writtenPaths.push(await writeResultArtifact(artifact));
    } catch (error) {
      writeErrors.push(error instanceof Error ? error.message : String(error));
    }
  };

  if (shouldWriteJson(rawResult, binaries)) {
    await attemptWrite({
      root,
      serverName: options.serverName,
      toolName: options.toolName,
      now,
      extension: ".json",
      content: safeStringify(rawResult),
    });
  } else if (binaries.length === 0 || hasTextualPayload(rawResult)) {
    await attemptWrite({
      root,
      serverName: options.serverName,
      toolName: options.toolName,
      now,
      extension: ".txt",
      content: output,
    });
  }

  for (const [index, payload] of binaries.entries()) {
    await attemptWrite({
      root,
      serverName: options.serverName,
      toolName: `${options.toolName}-${payload.label || `binary-${index + 1}`}`,
      now,
      extension: extensionForMimeType(payload.mimeType),
      content: Buffer.from(payload.data, "base64"),
    });
  }

  if (writtenPaths.length > 0) {
    try {
      await pruneResultArtifacts(root, resolved, now, new Set(writtenPaths));
    } catch {
      // Retention is best-effort and must not hide a successful MCP result.
    }
  }

  const notice = formatTruncationNotice(originalChars, writtenPaths, writeErrors);
  return boundedPreview(output, notice, resolved.maxChars);
}

async function writeResultArtifact(options: {
  root: string;
  serverName: string;
  toolName: string;
  now: number;
  extension: string;
  content: string | Buffer;
}): Promise<string> {
  const serverDir = join(options.root, sanitizePathPart(options.serverName));
  await mkdir(serverDir, { recursive: true, mode: 0o700 });
  await chmod(options.root, 0o700);
  await chmod(serverDir, 0o700);

  const timestamp = new Date(options.now).toISOString().replace(/[:.]/g, "-");
  const suffix = randomBytes(4).toString("hex");
  const fileName = `${sanitizePathPart(options.toolName)}-${timestamp}-${suffix}${options.extension}`;
  const path = join(serverDir, fileName);
  await writeFile(path, options.content, { flag: "wx", mode: 0o600 });
  return path;
}

async function pruneResultArtifacts(
  root: string,
  options: Pick<ResolvedOutputGuardOptions, "maxFiles" | "maxAgeMs">,
  now: number,
  protectedPaths: Set<string>,
): Promise<void> {
  const files = await listResultFiles(root);
  const retained: Array<{ path: string; mtimeMs: number }> = [];

  for (const file of files) {
    if (!protectedPaths.has(file.path) && now - file.mtimeMs > options.maxAgeMs) {
      await unlink(file.path);
    } else {
      retained.push(file);
    }
  }

  retained.sort((left, right) => {
    const leftProtected = protectedPaths.has(left.path);
    const rightProtected = protectedPaths.has(right.path);
    if (leftProtected !== rightProtected) return leftProtected ? -1 : 1;
    return right.mtimeMs - left.mtimeMs;
  });
  for (const file of retained.slice(options.maxFiles)) {
    if (!protectedPaths.has(file.path)) await unlink(file.path);
  }
}

async function listResultFiles(root: string): Promise<Array<{ path: string; mtimeMs: number }>> {
  const files: Array<{ path: string; mtimeMs: number }> = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listResultFiles(path));
    } else if (entry.isFile()) {
      const details = await stat(path);
      files.push({ path, mtimeMs: details.mtimeMs });
    }
  }
  return files;
}

function shouldWriteJson(rawResult: unknown, binaries: BinaryPayload[]): boolean {
  if (!isRecord(rawResult)) return false;
  return rawResult.structuredContent !== undefined || binaries.length > 0 && hasNonBinaryPayload(rawResult);
}

function hasNonBinaryPayload(rawResult: Record<string, unknown>): boolean {
  const keys = Object.keys(rawResult).filter((key) => key !== "content" && key !== "contents");
  if (keys.length > 0) return true;
  return hasTextualPayload(rawResult);
}

function hasTextualPayload(rawResult: unknown): boolean {
  if (!isRecord(rawResult)) return typeof rawResult === "string" && rawResult.length > 0;
  for (const key of ["content", "contents"] as const) {
    const values = Array.isArray(rawResult[key]) ? rawResult[key] : [];
    for (const value of values) {
      if (!isRecord(value)) return true;
      if (typeof value.text === "string") return true;
      if (value.type === "text") return true;
      if (value.type === "resource" && isRecord(value.resource) && typeof value.resource.text === "string") return true;
      if (value.type !== "image" && value.type !== "audio" && value.type !== "resource" && !("blob" in value)) return true;
    }
  }
  return false;
}

function collectBinaryPayloads(rawResult: unknown): BinaryPayload[] {
  if (!isRecord(rawResult)) return [];
  const payloads: BinaryPayload[] = [];
  const content = Array.isArray(rawResult.content) ? rawResult.content : [];
  for (const [index, block] of content.entries()) {
    if (!isRecord(block)) continue;
    if ((block.type === "image" || block.type === "audio") && typeof block.data === "string") {
      payloads.push({
        data: block.data,
        mimeType: typeof block.mimeType === "string" ? block.mimeType : undefined,
        label: `${String(block.type)}-${index + 1}`,
      });
    }
    if (block.type === "resource" && isRecord(block.resource) && typeof block.resource.blob === "string") {
      payloads.push({
        data: block.resource.blob,
        mimeType: typeof block.resource.mimeType === "string" ? block.resource.mimeType : undefined,
        label: `resource-${index + 1}`,
      });
    }
  }

  const contents = Array.isArray(rawResult.contents) ? rawResult.contents : [];
  for (const [index, contentBlock] of contents.entries()) {
    if (!isRecord(contentBlock) || typeof contentBlock.blob !== "string") continue;
    payloads.push({
      data: contentBlock.blob,
      mimeType: typeof contentBlock.mimeType === "string" ? contentBlock.mimeType : undefined,
      label: `resource-${index + 1}`,
    });
  }
  return payloads;
}

function extensionForMimeType(mimeType: string | undefined): string {
  const normalized = mimeType?.split(";")[0].trim().toLowerCase();
  const known: Record<string, string> = {
    "application/json": ".json",
    "application/pdf": ".pdf",
    "application/zip": ".zip",
    "audio/mpeg": ".mp3",
    "audio/ogg": ".ogg",
    "audio/wav": ".wav",
    "image/gif": ".gif",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/svg+xml": ".svg",
    "image/webp": ".webp",
    "text/csv": ".csv",
    "text/html": ".html",
    "text/markdown": ".md",
    "text/plain": ".txt",
  };
  return normalized && known[normalized] ? known[normalized] : ".bin";
}

function boundedPreview(output: string, notice: string, maxChars: number): string {
  const separator = output ? "\n\n" : "";
  const previewChars = Math.max(0, maxChars - notice.length - separator.length);
  const preview = truncateAtCharacterBoundary(output, previewChars);
  if (!preview) return truncateAtCharacterBoundary(notice, maxChars);
  return `${preview}${separator}${notice}`;
}

function truncateAtCharacterBoundary(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  let end = Math.max(0, maxChars);
  if (end > 0 && isHighSurrogate(value.charCodeAt(end - 1))) end--;
  return value.slice(0, end);
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function formatTruncationNotice(originalChars: number, paths: string[], errors: string[]): string {
  const writeWarning = errors.length > 0
    ? ` Some result artifacts could not be saved: ${truncateAtCharacterBoundary(errors[0], 300)}.`
    : "";
  if (paths.length === 1) {
    return `Output truncated (${originalChars} chars). Full result: ${paths[0]}. Use the file tools to read more.${writeWarning}`;
  }
  if (paths.length > 1) {
    return `Output truncated (${originalChars} chars). Full results: ${paths.join(", ")}. Use the file tools to read more.${writeWarning}`;
  }
  return `Output truncated (${originalChars} chars). Full result could not be saved: ${truncateAtCharacterBoundary(errors[0] ?? "unknown write error", 300)}.`;
}

function sanitizePathPart(value: string): string {
  const sanitized = value
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return sanitized || "result";
}

function safeStringify(value: unknown): string {
  try {
    return `${JSON.stringify(value, null, 2)}\n`;
  } catch {
    return `${String(value)}\n`;
  }
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const integer = Math.floor(value);
  return integer > 0 ? integer : undefined;
}

function boundedInteger(value: unknown, min: number, max: number): number | undefined {
  const integer = positiveInteger(value);
  if (integer === undefined || integer < min || integer > max) return undefined;
  return integer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
