import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveCacheIdentityHash } from "../src/mcp/cache-identity.js";
import { saveOAuthStore } from "../src/mcp/oauth-store.js";

describe("cache auth identity", () => {
  it("separates bearer tokens without exposing them", () => {
    const definition = {
      url: "https://example.test/mcp",
      auth: "bearer" as const,
      bearerTokenEnv: "TOKEN",
    };
    const first = resolveCacheIdentityHash({
      serverName: "remote",
      definition,
      env: { TOKEN: "secret-one" },
    });
    const second = resolveCacheIdentityHash({
      serverName: "remote",
      definition,
      env: { TOKEN: "secret-two" },
    });

    expect(first).not.toBe(second);
    expect(first).not.toContain("secret-one");
    expect(second).not.toContain("secret-two");
  });

  it("uses OAuth issuer and JWT subject rather than token rotation", () => {
    const home = mkdtempSync(join(tmpdir(), "letta-mcp-cache-identity-"));
    const definition = {
      url: "https://example.test/mcp",
      auth: "oauth" as const,
      oauth: { clientId: "client" },
    };
    saveOAuthToken(home, definition.url, jwt({ iss: "https://issuer.test", sub: "user-1", nonce: 1 }));
    const first = resolveCacheIdentityHash({ home, serverName: "remote", definition });

    saveOAuthToken(home, definition.url, jwt({ iss: "https://issuer.test", sub: "user-1", nonce: 2 }));
    const rotated = resolveCacheIdentityHash({ home, serverName: "remote", definition });

    saveOAuthToken(home, definition.url, jwt({ iss: "https://issuer.test", sub: "user-2", nonce: 3 }));
    const otherUser = resolveCacheIdentityHash({ home, serverName: "remote", definition });

    expect(rotated).toBe(first);
    expect(otherUser).not.toBe(first);
  });
});

function saveOAuthToken(home: string, serverUrl: string, accessToken: string): void {
  saveOAuthStore({
    home,
    serverName: "remote",
    serverUrl,
    store: {
      version: 2,
      serverName: "remote",
      serverUrl,
      updatedAt: 1,
      activeIssuer: "https://issuer.test",
      credentials: {
        "https://issuer.test": {
          tokens: {
            access_token: accessToken,
            token_type: "bearer",
            issuer: "https://issuer.test",
          },
        },
      },
    },
  });
}

function jwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "signature",
  ].join(".");
}
