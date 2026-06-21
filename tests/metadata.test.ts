import { describe, expect, it, vi } from "vitest";
import { discoverServerMetadata } from "../src/mcp/metadata.js";

describe("discoverServerMetadata pagination", () => {
  it("paginates tool and resource metadata with cursors", async () => {
    const options = { timeout: 1234 };
    const listTools = vi.fn()
      .mockResolvedValueOnce({ tools: [{ name: "first", description: "First tool" }], nextCursor: "tool-page-2" })
      .mockResolvedValueOnce({ tools: [{ name: "second", description: "Second tool" }] });
    const listResources = vi.fn()
      .mockResolvedValueOnce({ resources: [{ uri: "file://one", name: "one" }], nextCursor: "resource-page-2" })
      .mockResolvedValueOnce({ resources: [{ uri: "file://two", name: "two" }] });

    const result = await discoverServerMetadata({ listTools, listResources } as never, options);

    expect(result.tools.map((tool) => tool.name)).toEqual(["first", "second"]);
    expect(result.resources.map((resource) => resource.uri)).toEqual(["file://one", "file://two"]);
    expect(listTools).toHaveBeenNthCalledWith(1, undefined, options);
    expect(listTools).toHaveBeenNthCalledWith(2, { cursor: "tool-page-2" }, options);
    expect(listResources).toHaveBeenNthCalledWith(1, undefined, options);
    expect(listResources).toHaveBeenNthCalledWith(2, { cursor: "resource-page-2" }, options);
  });

  it("degrades resource-list failures to an empty resource list", async () => {
    const listTools = vi.fn().mockResolvedValue({ tools: [{ name: "search" }] });
    const listResources = vi.fn().mockRejectedValue(new Error("resources unsupported"));

    await expect(discoverServerMetadata({ listTools, listResources } as never)).resolves.toEqual({
      tools: [{ name: "search" }],
      resources: [],
    });
  });

  it("fails instead of looping forever when tool pagination repeats a cursor", async () => {
    const listTools = vi.fn()
      .mockResolvedValueOnce({ tools: [{ name: "first" }], nextCursor: "same" })
      .mockResolvedValueOnce({ tools: [{ name: "second" }], nextCursor: "same" });
    const listResources = vi.fn().mockResolvedValue({ resources: [] });

    await expect(discoverServerMetadata({ listTools, listResources } as never)).rejects.toThrow(/repeated cursor/i);
    expect(listTools).toHaveBeenCalledTimes(2);
  });
});
