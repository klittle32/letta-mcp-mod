import { describe, expect, it } from "vitest";
import { startOAuthFixture } from "./helpers/oauth-fixture.js";

describe("OAuth HTTP MCP fixture", () => {
  it("starts and reports an MCP URL", async () => {
    const fixture = await startOAuthFixture();
    try {
      expect(fixture.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
      expect(fixture.redirectUri).toBe("http://127.0.0.1:3334/callback");
    } finally {
      await fixture.stop();
    }
  });

  it("returns a WWW-Authenticate challenge for unauthenticated MCP requests", async () => {
    const fixture = await startOAuthFixture();
    try {
      const response = await fetch(fixture.url, { method: "POST" });
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain("resource_metadata=");
      await response.body?.cancel();
    } finally {
      await fixture.stop();
    }
  });

  it("serves OAuth metadata, redirects authorization requests, and exchanges codes", async () => {
    const fixture = await startOAuthFixture();
    try {
      const protectedResource = await fetch(`${fixture.origin}/.well-known/oauth-protected-resource`);
      await expect(protectedResource.json()).resolves.toMatchObject({ authorization_servers: [fixture.origin] });

      const metadata = await fetch(`${fixture.origin}/.well-known/oauth-authorization-server`);
      await expect(metadata.json()).resolves.toMatchObject({ authorization_endpoint: `${fixture.origin}/authorize`, token_endpoint: `${fixture.origin}/token` });

      const authorizationUrl = new URL(`${fixture.origin}/authorize`);
      authorizationUrl.searchParams.set("client_id", "client-id");
      authorizationUrl.searchParams.set("redirect_uri", fixture.redirectUri);
      authorizationUrl.searchParams.set("response_type", "code");
      authorizationUrl.searchParams.set("state", "state-value");
      authorizationUrl.searchParams.set("resource", fixture.url);
      const redirect = new URL(await fixture.authorize(authorizationUrl.toString()));
      expect(redirect.origin + redirect.pathname).toBe(fixture.redirectUri);
      expect(redirect.searchParams.get("state")).toBe("state-value");
      expect(redirect.searchParams.get("iss")).toBe(fixture.origin);
      const code = redirect.searchParams.get("code");
      expect(code).toMatch(/^fixture-code-/);

      const token = await fetch(`${fixture.origin}/token`, {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from("client-id:client-secret-test-value").toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: code!,
          code_verifier: "verifier",
          redirect_uri: fixture.redirectUri,
          resource: fixture.url,
        }),
      });
      await expect(token.json()).resolves.toMatchObject({ access_token: "fixture-access-token", refresh_token: "fixture-refresh-token" });
    } finally {
      await fixture.stop();
    }
  });

  it("rejects authorization and token requests that are not resource-bound", async () => {
    const fixture = await startOAuthFixture();
    try {
      const authorizationUrl = new URL(`${fixture.origin}/authorize`);
      authorizationUrl.searchParams.set("client_id", "client-id");
      authorizationUrl.searchParams.set("redirect_uri", fixture.redirectUri);
      authorizationUrl.searchParams.set("response_type", "code");

      const authorization = await fetch(authorizationUrl, { redirect: "manual" });
      expect(authorization.status).toBe(400);
      await authorization.body?.cancel();

      const token = await fetch(`${fixture.origin}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: "client-id",
          client_secret: "client-secret-test-value",
        }),
      });
      expect(token.status).toBe(400);
      await expect(token.json()).resolves.toMatchObject({ error: "invalid_target" });
    } finally {
      await fixture.stop();
    }
  });
});
