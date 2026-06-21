import { describe, expect, it } from "vitest";
import {
  findToolByName,
  formatToolName,
  getServerPrefix,
  isToolExcluded,
  normalizeToolName,
  resourceNameToToolName,
  type ToolMetadata,
} from "../src/core/tool-names.js";

describe("tool naming", () => {
  it("server prefix converts hyphens to underscores", () => {
    expect(getServerPrefix("chrome-devtools", "server")).toBe("chrome_devtools");
    expect(formatToolName("take_screenshot", "chrome-devtools", "server")).toBe("chrome_devtools_take_screenshot");
  });

  it("short prefix strips trailing -mcp", () => {
    expect(getServerPrefix("foo-mcp", "short")).toBe("foo");
    expect(formatToolName("bar", "foo-mcp", "short")).toBe("foo_bar");
  });

  it("none prefix returns original tool name", () => {
    expect(formatToolName("read_file", "filesystem", "none")).toBe("read_file");
  });

  it("empty short prefix falls back to mcp", () => {
    expect(getServerPrefix("mcp", "short")).toBe("mcp");
    expect(formatToolName("ping", "mcp", "short")).toBe("mcp_ping");
  });

  it("normalizes hyphens to underscores", () => {
    expect(normalizeToolName("context7-resolve-library-id")).toBe("context7_resolve_library_id");
  });

  it("findToolByName exact match works", () => {
    const metadata: ToolMetadata[] = [{ name: "filesystem_read_file", originalName: "read_file", description: "Read" }];
    expect(findToolByName(metadata, "filesystem_read_file")?.originalName).toBe("read_file");
  });

  it("findToolByName hyphen/underscore fuzzy match works", () => {
    const metadata: ToolMetadata[] = [{ name: "context7_resolve-library-id", originalName: "resolve-library-id", description: "Resolve" }];
    expect(findToolByName(metadata, "context7-resolve_library_id")?.originalName).toBe("resolve-library-id");
  });

  it("excludeTools matches original name", () => {
    expect(isToolExcluded("read_file", "filesystem", "server", ["read_file"])).toBe(true);
  });

  it("excludeTools matches prefixed name", () => {
    expect(isToolExcluded("read_file", "filesystem", "server", ["filesystem_read_file"])).toBe(true);
    expect(isToolExcluded("read_file", "foo-mcp", "short", ["foo_read_file"])).toBe(true);
  });

  it("resource names become safe synthetic tool names", () => {
    expect(resourceNameToToolName("Project README.md")).toBe("project_readme_md");
    expect(resourceNameToToolName("!!!")).toBe("resource");
  });
});
