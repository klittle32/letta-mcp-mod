import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_OUTPUT_CHARS,
  guardMcpOutput,
  resolveOutputGuardOptions,
} from "../src/core/output-guard.js";
import { renderCallToolResult, renderReadResourceResult } from "../src/core/result-renderer.js";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "letta-mcp-output-guard-"));
}

function artifactPaths(output: string): string[] {
  const match = output.match(/Full results?: (.+)\. Use the file tools to read more\./);
  return match?.[1].split(", ") ?? [];
}

function listFiles(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? listFiles(child) : [child];
  });
}

describe("aggregate MCP output guard", () => {
  it("uses the default limit and lets a per-call value override configuration", () => {
    expect(resolveOutputGuardOptions(undefined, undefined).maxChars).toBe(DEFAULT_MAX_OUTPUT_CHARS);
    expect(resolveOutputGuardOptions({ maxChars: 5_000 }, undefined).maxChars).toBe(5_000);
    expect(resolveOutputGuardOptions({ maxChars: 5_000 }, 2_000).maxChars).toBe(2_000);
  });

  it("returns under-limit output unchanged", async () => {
    const output = "Called fixture_echo.\n\nhello";

    await expect(guardMcpOutput(output, { content: [{ type: "text", text: "hello" }] }, {
      home: tempHome(),
      serverName: "fixture",
      toolName: "fixture_echo",
      maxOutput: 1_000,
    })).resolves.toBe(output);
  });

  it("measures multiple text blocks as one result and preserves the complete text privately", async () => {
    const home = tempHome();
    const rawResult = {
      content: [
        { type: "text", text: "a".repeat(700) },
        { type: "text", text: "b".repeat(700) },
      ],
    };
    const output = `Called fixture_chatty.\n\n${rawResult.content[0].text}\n\n${rawResult.content[1].text}`;

    const guarded = await guardMcpOutput(output, rawResult, {
      home,
      serverName: "fixture",
      toolName: "fixture_chatty",
      maxOutput: 1_000,
    });

    expect(guarded.length).toBeLessThanOrEqual(1_000);
    expect(guarded).toContain("Output truncated (");
    const [path] = artifactPaths(guarded);
    expect(path).toContain(join(".letta", "mcp-adapter", "results", "fixture"));
    expect(readFileSync(path, "utf8")).toBe(output);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
  });

  it("keeps small structured content inline and spills large structured results as JSON", async () => {
    const home = tempHome();
    const small = { content: [], structuredContent: { ok: true } };
    const smallOutput = renderCallToolResult(small).text;
    await expect(guardMcpOutput(smallOutput, small, {
      home,
      serverName: "fixture",
      toolName: "fixture_status",
      maxOutput: 1_000,
    })).resolves.toBe(smallOutput);

    const large = { content: [], structuredContent: { value: "x".repeat(2_000) } };
    const largeOutput = renderCallToolResult(large).text;
    const guarded = await guardMcpOutput(largeOutput, large, {
      home,
      serverName: "fixture",
      toolName: "fixture_status",
      maxOutput: 1_000,
    });

    const [path] = artifactPaths(guarded);
    expect(path).toMatch(/\.json$/);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(large);
  });

  it("spills oversized readResource text through the same guard", async () => {
    const home = tempHome();
    const rawResult = {
      contents: [{ uri: "fixture://large", text: "resource".repeat(300), mimeType: "text/plain" }],
    };
    const output = `Read resource "fixture://large" from "fixture".\n\n${renderReadResourceResult(rawResult)}`;

    const guarded = await guardMcpOutput(output, rawResult, {
      home,
      serverName: "fixture",
      toolName: "fixture_get_large",
      maxOutput: 1_000,
    });

    const [path] = artifactPaths(guarded);
    expect(path).toMatch(/\.txt$/);
    expect(readFileSync(path, "utf8")).toBe(output);
  });

  it("decodes oversized binary resources to a MIME-appropriate private file", async () => {
    const home = tempHome();
    const bytes = Buffer.alloc(1_200, 7);
    const rawResult = {
      contents: [{ uri: "fixture://image", blob: bytes.toString("base64"), mimeType: "image/png" }],
    };
    const output = `Read resource "fixture://image" from "fixture".\n\n${renderReadResourceResult(rawResult)}`;

    const guarded = await guardMcpOutput(output, rawResult, {
      home,
      serverName: "fixture",
      toolName: "fixture_get_image",
      maxOutput: 1_000,
    });

    expect(guarded).not.toContain(rawResult.contents[0].blob);
    const [path] = artifactPaths(guarded);
    expect(path).toMatch(/\.png$/);
    expect(readFileSync(path)).toEqual(bytes);
  });

  it("prunes expired and excess artifacts while preserving the new result", async () => {
    const home = tempHome();
    const root = join(home, ".letta", "mcp-adapter", "results");
    const serverDir = join(root, "old-server");
    mkdirSync(serverDir, { recursive: true });
    chmodSync(root, 0o700);
    const now = Date.now();
    const old = join(serverDir, "old.txt");
    const recentA = join(serverDir, "recent-a.txt");
    const recentB = join(serverDir, "recent-b.txt");
    for (const path of [old, recentA, recentB]) writeFileSync(path, path);
    utimesSync(old, (now - 10_000) / 1_000, (now - 10_000) / 1_000);
    utimesSync(recentA, (now - 200) / 1_000, (now - 200) / 1_000);
    utimesSync(recentB, (now - 100) / 1_000, (now - 100) / 1_000);

    const guarded = await guardMcpOutput("x".repeat(2_000), { content: [{ type: "text", text: "x".repeat(2_000) }] }, {
      home,
      serverName: "fixture",
      toolName: "fixture_chatty",
      maxOutput: 1_000,
      now,
      settings: { maxAgeMs: 1_000, maxFiles: 2 },
    });

    const [newPath] = artifactPaths(guarded);
    const retained = listFiles(root);
    expect(retained).toHaveLength(2);
    expect(retained).toContain(newPath);
    expect(retained).toContain(recentB);
    expect(retained).not.toContain(old);
    expect(retained).not.toContain(recentA);
  });

  it("stays bounded and actionable when the artifact cannot be written", async () => {
    const root = tempHome();
    const invalidHome = join(root, "not-a-directory");
    writeFileSync(invalidHome, "file");

    const guarded = await guardMcpOutput("x".repeat(2_000), { content: [{ type: "text", text: "x".repeat(2_000) }] }, {
      home: invalidHome,
      serverName: "fixture",
      toolName: "fixture_chatty",
      maxOutput: 1_000,
    });

    expect(guarded.length).toBeLessThanOrEqual(1_000);
    expect(guarded).toContain("Full result could not be saved:");
  });
});
