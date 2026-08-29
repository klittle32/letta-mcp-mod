import { describe, expect, it, vi } from "vitest";
import { discoverServerMetadata, normalizeTools } from "../src/mcp/metadata.js";

describe("discoverServerMetadata", () => {
  it("normalizes SDK-aggregated tool and resource metadata", async () => {
    const options = { timeout: 1234 };
    const listTools = vi.fn().mockResolvedValue({
      tools: [
        { name: "first", description: "First tool" },
        { name: "second", description: "Second tool" },
      ],
    });
    const listResources = vi.fn().mockResolvedValue({
      resources: [
        { uri: "file://one", name: "one" },
        { uri: "file://two", name: "two" },
      ],
    });

    const result = await discoverServerMetadata({ listTools, listResources } as never, options);

    expect(result.tools.map((tool) => tool.name)).toEqual(["first", "second"]);
    expect(result.resources.map((resource) => resource.uri)).toEqual(["file://one", "file://two"]);
    expect(listTools).toHaveBeenCalledOnce();
    expect(listTools).toHaveBeenCalledWith(undefined, options);
    expect(listResources).toHaveBeenCalledOnce();
    expect(listResources).toHaveBeenCalledWith(undefined, options);
  });

  it("degrades resource-list failures to an empty resource list", async () => {
    const listTools = vi.fn().mockResolvedValue({ tools: [{ name: "search" }] });
    const listResources = vi.fn().mockRejectedValue(new Error("resources unsupported"));

    await expect(discoverServerMetadata({ listTools, listResources } as never)).resolves.toEqual({
      tools: [{ name: "search" }],
      resources: [],
      cachePolicy: { ttlMs: undefined, cacheScope: undefined },
      warnings: [],
    });
  });

  it("preserves rich tool metadata and cache policy without rewriting schemas", async () => {
    const inputSchema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { value: { type: ["string", "null"] } },
    };
    const outputSchema = { type: "object", properties: { ok: { const: true } } };
    const listTools = vi.fn().mockResolvedValue({
      ttlMs: 10_000,
      cacheScope: "public",
      tools: [{
        name: "inspect",
        title: "Inspect safely",
        description: "Inspect a value",
        inputSchema,
        outputSchema,
        annotations: { readOnlyHint: true, destructiveHint: false },
        icons: [{ src: "https://example.test/icon.svg", mimeType: "image/svg+xml" }],
      }],
    });
    const listResources = vi.fn().mockResolvedValue({
      ttlMs: 2_000,
      cacheScope: "private",
      resources: [],
    });

    const result = await discoverServerMetadata({ listTools, listResources } as never);

    expect(result.cachePolicy).toEqual({ ttlMs: 2_000, cacheScope: "private" });
    expect(result.tools[0]).toMatchObject({
      title: "Inspect safely",
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false },
      icons: [{ src: "https://example.test/icon.svg", mimeType: "image/svg+xml" }],
    });
  });

  it("drops only tools with invalid annotations and reports a warning", () => {
    const warnings: string[] = [];
    const tools = normalizeTools([
      { name: "safe", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
      { name: "invalid", inputSchema: { type: "object" }, annotations: { destructiveHint: "yes" } },
    ] as never, warnings);

    expect(tools.map((tool) => tool.name)).toEqual(["safe"]);
    expect(warnings).toEqual(['Dropped external tool "invalid" because its annotations are invalid.']);
  });
});
