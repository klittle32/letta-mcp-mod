import { join } from "node:path";
import { startHttpFixture, type StartedHttpFixture } from "./http-fixture.js";

export interface StartedOAuthFixture extends StartedHttpFixture {
  origin: string;
  redirectUri: string;
  authorize(authorizationUrl: string): Promise<string>;
  observations(): Promise<OAuthFixtureObservations>;
}

export interface OAuthFixtureObservations {
  resourceMetadataRequests: string[];
  authorizationMetadataRequests: number;
  authorizationRequests: Array<Record<string, string>>;
  tokenRequests: Array<Record<string, string>>;
  registrations: Array<Record<string, unknown>>;
  mcpRequests: Array<{ method?: string; tool?: string; token?: string }>;
}

export async function startOAuthFixture(): Promise<StartedOAuthFixture> {
  const fixture = await startHttpFixture(join(process.cwd(), "tests/fixtures/http-oauth-fixture.mjs"));
  const origin = new URL(fixture.url).origin;
  return {
    ...fixture,
    origin,
    redirectUri: "http://127.0.0.1:3334/callback",
    async authorize(authorizationUrl: string): Promise<string> {
      const response = await fetch(authorizationUrl, { redirect: "manual" });
      const location = response.headers.get("location");
      if (!location) throw new Error(`OAuth fixture did not return a redirect location: HTTP ${response.status}`);
      await response.body?.cancel();
      return location;
    },
    async observations(): Promise<OAuthFixtureObservations> {
      const response = await fetch(`${origin}/fixture-observations`);
      if (!response.ok) throw new Error(`OAuth fixture observations failed: HTTP ${response.status}`);
      return response.json() as Promise<OAuthFixtureObservations>;
    },
  };
}
