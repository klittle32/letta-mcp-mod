import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMetadataCachePath } from "../src/core/cache.js";
import { executeMcpProxy } from "../src/features/proxy-tool.js";
import { loadOAuthStore, redactOAuthMessage } from "../src/mcp/oauth-store.js";
import { createAdapterRuntime } from "../src/runtime.js";
import { startOAuthFixture } from "./helpers/oauth-fixture.js";

const SECRETS = [
  "client-secret-test-value",
  "fixture-access-token",
  "fixture-refresh-token",
  "code-verifier-test-value",
  "authorization-code-test-value",
];

function tempWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "letta-mcp-oauth-redaction-"));
  const home = join(root, "home");
  const cwd = join(root, "workspace");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return { home, cwd };
}

function expectNoSecrets(text: string) {
  for (const secret of SECRETS) expect(text).not.toContain(secret);
}

describe("OAuth redaction", () => {
  it("redacts query-string and JSON-shaped OAuth secrets", () => {
    const text = redactOAuthMessage(new Error([
      "https://auth.example/token?code=authorization-code-test-value&client_secret=client-secret-test-value",
      '{"access_token":"fixture-access-token","refresh_token":"fixture-refresh-token","code_verifier":"code-verifier-test-value"}',
    ].join(" ")));

    expect(text).toContain("client_secret=<redacted>");
    expect(text).toContain('"access_token":"<redacted>"');
    expect(text).toContain('"refresh_token":"<redacted>"');
    expect(text).toContain('"code_verifier":"<redacted>"');
    expectNoSecrets(text);
  });

  it("does not leak OAuth tokens, client secrets, or verifier values in user-facing output or metadata cache", async () => {
    const fixture = await startOAuthFixture();
    const { home, cwd } = tempWorkspace();
    writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({
      mcpServers: {
        remote: {
          url: fixture.url,
          auth: "oauth",
          oauth: { clientId: "client-id", clientSecret: "client-secret-test-value", redirectUri: fixture.redirectUri, scope: "read write" },
        },
      },
    }, null, 2));
    const runtime = createAdapterRuntime({ home, timeoutMs: 2_000 });
    try {
      const startArgs = { action: "auth-start", server: "remote" };
      const start = await executeMcpProxy(startArgs, runtime.loadState({ cwd, args: startArgs }), runtime, { cwd, args: startArgs });
      const storeAfterStart = loadOAuthStore({ home, serverName: "remote", serverUrl: fixture.url });
      const codeVerifier = storeAfterStart?.codeVerifier;
      expect(codeVerifier).toBeTruthy();
      expect(start).not.toContain(codeVerifier!);
      expectNoSecrets(start);

      const redirectUrl = await fixture.authorize(storeAfterStart!.authorizationUrl!);
      const code = new URL(redirectUrl).searchParams.get("code");
      const completeArgs = { action: "auth-complete", server: "remote", args: JSON.stringify({ redirectUrl }) };
      const complete = await executeMcpProxy(completeArgs, runtime.loadState({ cwd, args: completeArgs }), runtime, { cwd, args: completeArgs });
      expect(complete).not.toContain(code!);
      expectNoSecrets(complete);

      const connect = await executeMcpProxy({ connect: "remote" }, runtime.loadState({ cwd }), runtime, { cwd, args: { connect: "remote" } });
      expectNoSecrets(connect);

      const cacheText = readFileSync(getMetadataCachePath(home), "utf8");
      expect(cacheText).not.toContain(codeVerifier!);
      expect(cacheText).not.toContain(code!);
      expectNoSecrets(cacheText);
      expect(cacheText).not.toContain("access_token");
      expect(cacheText).not.toContain("refresh_token");
      expect(cacheText).not.toContain("client_secret");
      expect(cacheText).not.toContain("codeVerifier");
    } finally {
      await runtime.closeAll();
      await fixture.stop();
    }
  });
});
