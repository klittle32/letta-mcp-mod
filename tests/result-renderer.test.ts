import { describe, expect, it } from "vitest";
import { renderCallToolResult, renderReadResourceResult } from "../src/core/result-renderer.js";

describe("renderCallToolResult", () => {
  it("renders text-only tool result", () => {
    expect(renderCallToolResult({ content: [{ type: "text", text: "hello" }] })).toEqual({ text: "hello", isError: false });
  });

  it("separates multiple text blocks with blank lines", () => {
    expect(renderCallToolResult({ content: [{ type: "text", text: "one" }, { type: "text", text: "two" }] }).text).toBe("one\n\ntwo");
  });

  it("preserves isError true", () => {
    expect(renderCallToolResult({ isError: true, content: [{ type: "text", text: "bad" }] })).toEqual({ text: "bad", isError: true });
  });

  it("appends structured content as pretty JSON", () => {
    const rendered = renderCallToolResult({ content: [{ type: "text", text: "Status: ok" }], structuredContent: { ok: true, source: "fixture" } });

    expect(rendered.text).toContain("Status: ok");
    expect(rendered.text).toContain("Structured content:");
    expect(rendered.text).toContain('  "ok": true');
  });

  it("renders empty content plus structured content", () => {
    expect(renderCallToolResult({ content: [], structuredContent: { ok: true } }).text).toContain('"ok": true');
  });

  it("renders image and audio placeholders without raw base64", () => {
    const rendered = renderCallToolResult({
      content: [
        { type: "image", data: "abc123", mimeType: "image/png" },
        { type: "audio", data: "def456", mimeType: "audio/wav" },
      ],
    }).text;

    expect(rendered).toContain("[image content: image/png, 6 chars base64]");
    expect(rendered).toContain("[audio content: audio/wav, 6 chars base64]");
    expect(rendered).not.toContain("abc123");
    expect(rendered).not.toContain("def456");
  });

  it("renders embedded resource text", () => {
    const rendered = renderCallToolResult({ content: [{ type: "resource", resource: { uri: "fixture://readme", text: "README", mimeType: "text/plain" } }] }).text;

    expect(rendered).toContain("Resource: fixture://readme (text/plain)");
    expect(rendered).toContain("README");
  });

  it("renders resource link metadata", () => {
    const rendered = renderCallToolResult({ content: [{ type: "resource_link", uri: "fixture://readme", name: "Fixture README", mimeType: "text/plain" }] }).text;

    expect(rendered).toBe("[resource link: Fixture README fixture://readme (text/plain)]");
  });

  it("truncates long text with a note", () => {
    const rendered = renderCallToolResult({ content: [{ type: "text", text: "abcdef" }] }, { maxTextChars: 3 }).text;

    expect(rendered).toBe("abc\n\n[truncated 3 characters]");
  });

  it("truncates long JSON with a note", () => {
    const rendered = renderCallToolResult({ content: [], structuredContent: { value: "abcdef" } }, { maxJsonChars: 10 }).text;

    expect(rendered).toContain("Structured content:");
    expect(rendered).toContain("[truncated");
  });

  it("renders unknown blocks as bounded JSON", () => {
    const rendered = renderCallToolResult({ content: [{ type: "custom", value: 1 }] }).text;

    expect(rendered).toContain('"type": "custom"');
    expect(rendered).toContain('"value": 1');
  });
});

describe("renderReadResourceResult", () => {
  it("renders read-resource text contents", () => {
    expect(renderReadResourceResult({ contents: [{ uri: "fixture://readme", text: "README", mimeType: "text/plain" }] })).toBe("README");
  });

  it("renders multiple read-resource text contents with headings", () => {
    const rendered = renderReadResourceResult({
      contents: [
        { uri: "fixture://one", text: "one", mimeType: "text/plain" },
        { uri: "fixture://two", text: "two", mimeType: "text/plain" },
      ],
    });

    expect(rendered).toContain("Resource: fixture://one (text/plain)\none");
    expect(rendered).toContain("Resource: fixture://two (text/plain)\ntwo");
  });

  it("renders read-resource blob contents as bounded placeholder", () => {
    expect(renderReadResourceResult({ contents: [{ uri: "fixture://image", blob: "abc123", mimeType: "image/png" }] })).toBe(
      "[blob content: fixture://image (image/png), 6 chars base64]",
    );
  });
});
