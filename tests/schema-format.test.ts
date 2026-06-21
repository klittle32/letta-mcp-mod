import { describe, expect, it } from "vitest";
import { formatSchema } from "../src/core/schema-format.js";

describe("schema formatter", () => {
  it("missing schema returns no schema", () => {
    expect(formatSchema(undefined)).toBe("  (no schema)");
  });

  it("empty object schema returns no parameters", () => {
    expect(formatSchema({ type: "object", properties: {} })).toBe("  (no parameters)");
  });

  it("object properties show name and type", () => {
    expect(formatSchema({ type: "object", properties: { path: { type: "string" } } })).toContain("  path (string)");
  });

  it("required property is marked", () => {
    expect(formatSchema({ type: "object", required: ["path"], properties: { path: { type: "string" } } })).toContain("path (string) *required*");
  });

  it("description appears", () => {
    expect(formatSchema({ type: "object", properties: { path: { type: "string", description: "File path" } } })).toContain("- File path");
  });

  it("enum and default appear", () => {
    const text = formatSchema({ type: "object", properties: { mode: { enum: ["a", "b"], default: "a" } } });

    expect(text).toContain('mode (enum: "a", "b")');
    expect(text).toContain('[default: "a"]');
  });

  it("nested object and array are readable", () => {
    const text = formatSchema({
      type: "object",
      properties: {
        files: { type: "array", items: { type: "string" } },
        options: { type: "object", properties: { recursive: { type: "boolean" } } },
      },
    });

    expect(text).toContain("files (array)");
    expect(text).toContain("items (string)");
    expect(text).toContain("options (object)");
    expect(text).toContain("recursive (boolean)");
  });
});
