import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startHttpFixture } from "./helpers/http-fixture.js";

describe("HTTP MCP fixtures", () => {
  it("starts the streamable HTTP fixture and reports an MCP URL", async () => {
    const fixture = await startHttpFixture(join(process.cwd(), "tests/fixtures/http-streamable-fixture.mjs"));
    try {
      expect(fixture.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    } finally {
      await fixture.stop();
    }
  });

  it("starts the SSE HTTP fixture and reports an SSE URL", async () => {
    const fixture = await startHttpFixture(join(process.cwd(), "tests/fixtures/http-sse-fixture.mjs"));
    try {
      expect(fixture.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/sse$/);
    } finally {
      await fixture.stop();
    }
  });
});
