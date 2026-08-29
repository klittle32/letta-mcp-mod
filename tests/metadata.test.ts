import { describe, expect, it, vi } from "vitest";
import { discoverServerMetadata } from "../src/mcp/metadata.js";

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
    });
  });
});
