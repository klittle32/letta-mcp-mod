import { randomBytes } from "node:crypto";
import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { ServerEntry, OAuthConfig } from "../core/config.js";
import { InvalidServerConfigError } from "./errors.js";
import {
  clearOAuthCredentials,
  loadOAuthStore,
  saveOAuthStore,
  type OAuthAuthStoreFile,
  type OAuthCredentialScope,
} from "./oauth-store.js";

export interface OAuthProviderOptions {
  serverName: string;
  serverUrl: URL;
  definition: ServerEntry;
  home?: string;
  now?: () => number;
}

export function isOAuthEnabled(definition: ServerEntry): boolean {
  return definition.auth === "oauth" || (!!definition.oauth && typeof definition.oauth === "object" && !Array.isArray(definition.oauth));
}

export function assertOAuthServerConfig(serverName: string, definition: ServerEntry): void {
  if (!isOAuthEnabled(definition)) return;
  if (definition.auth === "bearer" || definition.bearerToken || definition.bearerTokenEnv) {
    throw new InvalidServerConfigError(`Server "${serverName}" cannot combine OAuth and bearer authentication. Configure either auth: "oauth" or auth: "bearer", not both.`);
  }
  if (!definition.url) {
    throw new InvalidServerConfigError(`Server "${serverName}" requires an HTTP URL for OAuth authentication.`);
  }
  let url: URL;
  try {
    url = new URL(definition.url);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new InvalidServerConfigError(`Server "${serverName}" has invalid OAuth URL: ${message}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new InvalidServerConfigError(`Server "${serverName}" requires an HTTP URL for OAuth authentication.`);
  }
}

export function createOAuthProvider(options: OAuthProviderOptions): FileOAuthClientProvider {
  return new FileOAuthClientProvider(options);
}

export class FileOAuthClientProvider implements OAuthClientProvider {
  readonly serverName: string;
  readonly serverUrl: URL;
  readonly definition: ServerEntry;
  readonly home?: string;
  private readonly now: () => number;
  private readonly config: OAuthConfig;

  constructor(options: OAuthProviderOptions) {
    assertOAuthServerConfig(options.serverName, options.definition);
    this.serverName = options.serverName;
    this.serverUrl = options.serverUrl;
    this.definition = options.definition;
    this.home = options.home;
    this.now = options.now ?? Date.now;
    this.config = getOAuthConfig(options.definition);
    if (!this.config.redirectUri) {
      throw new InvalidServerConfigError(`Server "${options.serverName}" OAuth authorization_code flow requires oauth.redirectUri.`);
    }
  }

  get redirectUrl(): string {
    return this.config.redirectUri!;
  }

  get clientMetadata(): OAuthClientMetadata {
    const metadata: OAuthClientMetadata = {
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: this.config.clientName ?? "Letta MCP Adapter",
    };
    if (this.config.clientUri) metadata.client_uri = this.config.clientUri;
    if (this.config.scope) metadata.scope = this.config.scope;
    return metadata;
  }

  async state(): Promise<string> {
    const existing = this.load()?.state;
    if (existing) return existing;
    const state = randomBytes(24).toString("base64url");
    this.savePartial({ state });
    return state;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const stored = this.load()?.clientInformation;
    if (stored) return stored;
    if (!this.config.clientId) return undefined;
    return this.config.clientSecret ? { client_id: this.config.clientId, client_secret: this.config.clientSecret } : { client_id: this.config.clientId };
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    this.savePartial({ clientInformation });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return this.load()?.tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.savePartial({ tokens });
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    this.savePartial({ authorizationUrl: authorizationUrl.toString() });
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this.savePartial({ codeVerifier });
  }

  async codeVerifier(): Promise<string> {
    const codeVerifier = this.load()?.codeVerifier;
    if (!codeVerifier) throw new InvalidServerConfigError(`Server "${this.serverName}" is missing OAuth code verifier. Run auth-start again before auth-complete.`);
    return codeVerifier;
  }

  async invalidateCredentials(scope: OAuthCredentialScope): Promise<void> {
    clearOAuthCredentials({ home: this.home, serverName: this.serverName, serverUrl: this.serverUrl.toString(), scope });
  }

  async saveDiscoveryState(discoveryState: OAuthDiscoveryState): Promise<void> {
    this.savePartial({ discoveryState });
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return this.load()?.discoveryState;
  }

  get authorizationUrl(): string | undefined {
    return this.load()?.authorizationUrl;
  }

  private load(): OAuthAuthStoreFile | null {
    return loadOAuthStore({ home: this.home, serverName: this.serverName, serverUrl: this.serverUrl.toString() });
  }

  private savePartial(partial: Partial<OAuthAuthStoreFile>): void {
    const base = this.load() ?? this.emptyStore();
    saveOAuthStore({
      home: this.home,
      serverName: this.serverName,
      serverUrl: this.serverUrl.toString(),
      store: { ...base, ...partial, updatedAt: this.now() },
    });
  }

  private emptyStore(): OAuthAuthStoreFile {
    return { version: 1, serverName: this.serverName, serverUrl: this.serverUrl.toString(), updatedAt: this.now() };
  }
}

export function parseOAuthRedirectUrl(rawRedirectUrl: string): { code: string; state?: string } | { error: string; errorDescription?: string } {
  let url: URL;
  try {
    url = new URL(rawRedirectUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new InvalidServerConfigError(`Invalid OAuth redirectUrl: ${message}`);
  }
  const error = url.searchParams.get("error");
  if (error) {
    return { error, errorDescription: url.searchParams.get("error_description") ?? undefined };
  }
  const code = url.searchParams.get("code");
  if (!code) throw new InvalidServerConfigError(`OAuth redirectUrl is missing required "code" query parameter.`);
  return { code, state: url.searchParams.get("state") ?? undefined };
}

function getOAuthConfig(definition: ServerEntry): OAuthConfig {
  return definition.oauth && typeof definition.oauth === "object" && !Array.isArray(definition.oauth) ? definition.oauth : {};
}
