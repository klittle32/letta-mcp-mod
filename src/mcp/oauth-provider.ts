import { randomBytes } from "node:crypto";
import type {
  OAuthClientInformationContext,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { validateClientMetadataUrl } from "@modelcontextprotocol/client";
import type { ServerEntry, OAuthConfig } from "../core/config.js";
import { InvalidServerConfigError } from "./errors.js";
import {
  clearOAuthCredentials,
  getOAuthCredentials,
  loadOAuthStore,
  normalizeOAuthIssuer,
  saveOAuthStore,
  type OAuthAuthStoreFile,
  type OAuthCredentialScope,
  type OAuthIssuerCredentials,
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
  readonly clientMetadataUrl?: string;
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
    validateClientMetadataUrl(this.config.clientMetadataUrl);
    this.clientMetadataUrl = this.config.clientMetadataUrl;
    if (this.config.grantType !== "client_credentials" && !this.config.redirectUri) {
      throw new InvalidServerConfigError(`Server "${options.serverName}" OAuth authorization_code flow requires oauth.redirectUri.`);
    }
  }

  get redirectUrl(): string | undefined {
    return this.config.grantType === "client_credentials" ? undefined : this.config.redirectUri;
  }

  get clientMetadata(): OAuthClientMetadata {
    if (this.config.grantType === "client_credentials") {
      const metadata: OAuthClientMetadata = {
        redirect_uris: [],
        grant_types: ["client_credentials"],
        application_type: "native",
        client_name: this.config.clientName ?? "Letta MCP Adapter",
      };
      if (this.config.clientUri) metadata.client_uri = this.config.clientUri;
      if (this.config.scope) metadata.scope = this.config.scope;
      return metadata;
    }
    const metadata: OAuthClientMetadata = {
      redirect_uris: [this.redirectUrl!],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      application_type: "native",
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

  async clientInformation(ctx?: OAuthClientInformationContext): Promise<StoredOAuthClientInformation | undefined> {
    if (this.config.clientId) {
      return {
        client_id: this.config.clientId,
        ...(this.config.clientSecret ? { client_secret: this.config.clientSecret } : {}),
        ...(ctx?.issuer ? { issuer: ctx.issuer } : {}),
      };
    }
    return getOAuthCredentials(this.load(), ctx?.issuer)?.clientInformation;
  }

  async saveClientInformation(
    clientInformation: StoredOAuthClientInformation,
    ctx?: OAuthClientInformationContext,
  ): Promise<void> {
    const issuer = requireCredentialIssuer("client information", clientInformation.issuer, ctx?.issuer);
    this.saveCredential(issuer, { clientInformation: { ...clientInformation, issuer } });
  }

  async tokens(ctx?: OAuthClientInformationContext): Promise<StoredOAuthTokens | undefined> {
    return getOAuthCredentials(this.load(), ctx?.issuer)?.tokens;
  }

  async saveTokens(tokens: StoredOAuthTokens, ctx?: OAuthClientInformationContext): Promise<void> {
    const issuer = requireCredentialIssuer("tokens", tokens.issuer, ctx?.issuer);
    this.saveCredential(issuer, { tokens: { ...tokens, issuer } });
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
    const activeIssuer = discoveryState.authorizationServerMetadata?.issuer
      ?? discoveryState.authorizationServerUrl;
    this.savePartial({ discoveryState, activeIssuer });
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return this.load()?.discoveryState;
  }

  get authorizationUrl(): string | undefined {
    return this.load()?.authorizationUrl;
  }

  prepareTokenRequest(scope?: string): URLSearchParams | undefined {
    if (this.config.grantType !== "client_credentials") return undefined;
    const params = new URLSearchParams({ grant_type: "client_credentials" });
    if (scope) params.set("scope", scope);
    if (this.config.audience) params.set("audience", this.config.audience);
    return params;
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

  private saveCredential(issuer: string, partial: OAuthIssuerCredentials): void {
    const store = this.load() ?? this.emptyStore();
    const key = normalizeOAuthIssuer(issuer);
    saveOAuthStore({
      home: this.home,
      serverName: this.serverName,
      serverUrl: this.serverUrl.toString(),
      store: {
        ...store,
        activeIssuer: issuer,
        credentials: {
          ...store.credentials,
          [key]: { ...store.credentials[key], ...partial },
        },
        updatedAt: this.now(),
      },
    });
  }

  private emptyStore(): OAuthAuthStoreFile {
    return { version: 2, serverName: this.serverName, serverUrl: this.serverUrl.toString(), updatedAt: this.now(), credentials: {} };
  }
}

export function parseOAuthRedirectUrl(rawRedirectUrl: string): { code: string; state?: string; iss?: string } | { error: string; errorDescription?: string } {
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
  return {
    code,
    state: url.searchParams.get("state") ?? undefined,
    iss: url.searchParams.get("iss") ?? undefined,
  };
}

function requireCredentialIssuer(kind: string, stampedIssuer?: string, contextIssuer?: string): string {
  const issuer = contextIssuer ?? stampedIssuer;
  if (!issuer) throw new InvalidServerConfigError(`Cannot store OAuth ${kind} without an authorization-server issuer.`);
  if (stampedIssuer && normalizeOAuthIssuer(stampedIssuer) !== normalizeOAuthIssuer(issuer)) {
    throw new InvalidServerConfigError(`Cannot store OAuth ${kind} under a different authorization-server issuer.`);
  }
  return issuer;
}

function getOAuthConfig(definition: ServerEntry): OAuthConfig {
  return definition.oauth && typeof definition.oauth === "object" && !Array.isArray(definition.oauth) ? definition.oauth : {};
}
