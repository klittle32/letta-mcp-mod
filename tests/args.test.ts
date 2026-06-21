import { describe, expect, it } from "vitest";
import { parseProxyArgs } from "../src/core/args.js";

describe("parseProxyArgs", () => {
  it("undefined args returns empty object", () => {
    expect(parseProxyArgs(undefined, "fixture_echo")).toEqual({ ok: true, value: {} });
  });

  it("empty and whitespace args return empty object", () => {
    expect(parseProxyArgs("", "fixture_echo")).toEqual({ ok: true, value: {} });
    expect(parseProxyArgs("  \n\t  ", "fixture_echo")).toEqual({ ok: true, value: {} });
  });

  it("valid object string returns object", () => {
    expect(parseProxyArgs('{"message":"hello"}', "fixture_echo")).toEqual({ ok: true, value: { message: "hello" } });
  });

  it("nested object and array values inside object are allowed", () => {
    expect(parseProxyArgs('{"nested":{"ok":true},"items":[1,2,3]}', "fixture_echo")).toEqual({
      ok: true,
      value: { nested: { ok: true }, items: [1, 2, 3] },
    });
  });

  it("invalid JSON returns helpful message with tool name and parser summary", () => {
    const result = parseProxyArgs("not json", "fixture_echo");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('Invalid args JSON for "fixture_echo"');
      expect(result.message).toContain('expected a JSON object string');
      expect(result.message).toContain("Parse error:");
    }
  });

  it("array JSON is rejected", () => {
    const result = parseProxyArgs("[]", "fixture_echo");

    expect(result).toEqual({ ok: false, message: 'Invalid args for "fixture_echo": args must parse to a JSON object, not an array.' });
  });

  it("null is rejected", () => {
    const result = parseProxyArgs("null", "fixture_echo");

    expect(result).toEqual({ ok: false, message: 'Invalid args for "fixture_echo": args must parse to a JSON object, not null.' });
  });

  it("string, number, and boolean JSON values are rejected", () => {
    expect(parseProxyArgs('"hello"', "fixture_echo")).toEqual({
      ok: false,
      message: 'Invalid args for "fixture_echo": args must parse to a JSON object, not string.',
    });
    expect(parseProxyArgs("123", "fixture_echo")).toEqual({
      ok: false,
      message: 'Invalid args for "fixture_echo": args must parse to a JSON object, not number.',
    });
    expect(parseProxyArgs("false", "fixture_echo")).toEqual({
      ok: false,
      message: 'Invalid args for "fixture_echo": args must parse to a JSON object, not boolean.',
    });
  });
});
