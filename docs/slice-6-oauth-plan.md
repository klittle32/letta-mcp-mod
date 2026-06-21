# Slice 6 Plan: OAuth for Authenticated Remote MCP Servers

## Purpose

Slice 6 adds OAuth support for remote MCP servers while preserving the shape built in Slices 1-5:

- the compact model-facing `mcp` tool remains the only autonomous model tool registered by the mod;
- the human-facing `/mcp` command remains an output-only command for status/setup/reconnect controls unless this plan explicitly adds a text-only auth helper;
- mod activation stays idle and capability-guarded;
- stdio, Streamable HTTP, SSE fallback, custom headers, and bearer auth remain unchanged;
- OAuth token/state persistence is scoped to `~/.letta/mcp-adapter/auth/`;
- no direct tools, permission overlays, panels, events, providers, or status values are introduced in this slice.

Authoritative feature scope from `docs/letta-mcp-adapter-mod-spec.md`:

```text
Slice 6: OAuth

Goal: feature parity with Pi for authenticated remote MCPs.

Features:

mcp({ action: "auth-start", server: "linear" })

mcp({
  action: "auth-complete",
  server: "linear",
  args: "{\"redirectUrl\":\"http://localhost:...\"}"
})

Store OAuth state/tokens under:

~/.letta/mcp-adapter/auth/

Acceptance criteria:
- Headless/manual OAuth works.
- Token is persisted.
- Reconnect succeeds after auth-complete.
```

## Grounding in actual Letta Code mod API

This slice should use the existing mod API surfaces only. Load and follow the `creating-mods` skill before implementation.

Relevant guidance already loaded while writing this plan:

- `creating-mods/SKILL.md`
- `creating-mods/references/tools.md`
- `creating-mods/references/commands.md`
- `creating-mods/references/architecture.md`

Current mod surface in `src/mod.ts`:

- Tool registration:
  - `letta.tools.register(createMcpTool(runtime))`
  - guarded with `letta.capabilities?.tools && letta.tools`
  - tool name is `mcp`
  - JSON schema is an object schema with `additionalProperties: false`
  - tool currently uses `ctx.cwd`, `ctx.args`, and `ctx.signal`
  - keep `requiresApproval: true`
  - keep `parallelSafe: false`
  - return concise model-readable strings
  - do **not** start hidden model runs from the tool
- Command registration:
  - `letta.commands.register(createMcpCommand(runtime))`
  - guarded with `letta.capabilities?.commands && letta.commands`
  - command ID is `mcp`, with no leading slash
  - command returns `{ type: "output", output }`
  - no `runWhenBusy`, no panels, no prompt-return command flow
- Activation:
  - may register capabilities and return cleanup disposers only
  - must not load config, start OAuth, connect to MCP servers, open callback listeners, make HTTP requests, read auth files, or write auth files at startup
  - all OAuth work must happen only when the `mcp` tool or `/mcp` command is invoked

### Mod API decisions for Slice 6

Use the existing `mcp` tool actions as the primary OAuth interface:

```ts
mcp({ action: "auth-start", server: "linear" })
mcp({ action: "auth-complete", server: "linear", args: "{\"redirectUrl\":\"http://127.0.0.1:...\"}" })
```

Optional command aliases may be added only if they remain text-only output commands and do not change the mod surface shape:

```text
/mcp auth-start linear
/mcp auth-complete linear <redirectUrl>
/mcp auth-status linear
```

Do **not** add UI panels, status values, events, permission overlays, local providers, or direct tool registration in this slice. Those belong to later slices in the spec.

## Grounding in actual MCP SDK APIs

Installed SDK inspected: `@modelcontextprotocol/sdk` `1.29.0`.

Relevant imports from the installed SDK:

```ts
import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import { auth, UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
```

`OAuthClientProvider` must provide, at minimum:

```ts
get redirectUrl(): string | URL | undefined;
get clientMetadata(): OAuthClientMetadata;
state?(): string | Promise<string>;
clientInformation(): OAuthClientInformationMixed | undefined | Promise<OAuthClientInformationMixed | undefined>;
saveClientInformation?(clientInformation: OAuthClientInformationMixed): void | Promise<void>;
tokens(): OAuthTokens | undefined | Promise<OAuthTokens | undefined>;
saveTokens(tokens: OAuthTokens): void | Promise<void>;
redirectToAuthorization(authorizationUrl: URL): void | Promise<void>;
saveCodeVerifier(codeVerifier: string): void | Promise<void>;
codeVerifier(): string | Promise<string>;
addClientAuthentication?;
validateResourceURL?;
invalidateCredentials?(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void | Promise<void>;
saveDiscoveryState?(state: OAuthDiscoveryState): void | Promise<void>;
discoveryState?(): OAuthDiscoveryState | undefined | Promise<OAuthDiscoveryState | undefined>;
```

Important SDK behavior to build around:

- `auth(provider, { serverUrl })` performs OAuth discovery, dynamic client registration when needed, token refresh when possible, or starts an authorization-code redirect flow.
- If interactive authorization is needed, `auth(...)` calls `provider.redirectToAuthorization(authorizationUrl)` and returns `"REDIRECT"`.
- `auth(provider, { serverUrl, authorizationCode })` exchanges an authorization code for tokens and calls `provider.saveTokens(tokens)`.
- Streamable HTTP and SSE transports both accept `authProvider` and will attach `Authorization: Bearer <access_token>` from `provider.tokens()`.
- If a transport receives a 401 and has an `authProvider`, it uses the SDK auth flow. If interactive authorization is required during `connect`, the transport throws `UnauthorizedError`; user-facing output should tell the user to run `mcp({ action: "auth-start", server: "..." })`.
- `StreamableHTTPClientTransport.finishAuth(code)` and `SSEClientTransport.finishAuth(code)` exist, but this adapter should prefer `auth(provider, { serverUrl, authorizationCode })` for explicit `auth-complete` actions so auth can complete without maintaining a live pre-auth transport instance.

## Proposed configuration contract

Keep the existing `ServerEntry.oauth?: OAuthConfig | false` shape and refine it, without breaking existing config files.

Current `OAuthConfig` fields:

```ts
export interface OAuthConfig {
  grantType?: "authorization_code" | "client_credentials";
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  redirectUri?: string;
  clientName?: string;
  clientUri?: string;
}
```

Slice 6 should support at least authorization-code OAuth for HTTP MCP servers:

```json
{
  "mcpServers": {
    "linear": {
      "url": "https://mcp.linear.app/mcp",
      "auth": "oauth",
      "oauth": {
        "clientId": "${LINEAR_CLIENT_ID}",
        "clientSecret": "${LINEAR_CLIENT_SECRET}",
        "redirectUri": "http://127.0.0.1:3334/callback",
        "scope": "read write",
        "clientName": "Letta MCP Adapter"
      }
    }
  }
}
```

Also allow dynamic client registration when the authorization server supports it:

```json
{
  "mcpServers": {
    "remote": {
      "url": "https://example.com/mcp",
      "auth": "oauth",
      "oauth": {
        "redirectUri": "http://127.0.0.1:3334/callback",
        "clientName": "Letta MCP Adapter"
      }
    }
  }
}
```

Rules:

1. OAuth applies only to URL-based HTTP MCP servers.
2. `auth: "oauth"` or a truthy `oauth` object enables OAuth.
3. `auth: "bearer"` keeps existing bearer behavior and must not create/read OAuth state.
4. If both OAuth and bearer material are configured, return a concise invalid-config error. Do not guess precedence.
5. Authorization-code flow requires `oauth.redirectUri` for manual/headless auth. If absent, `auth-start` should return an actionable error.
6. Interpolate environment variables in OAuth string fields (`clientId`, `clientSecret`, `scope`, `redirectUri`, `clientName`, `clientUri`) using the same `${VAR}` / `$env:VAR` rules as existing env/header/token fields.
7. Never print `clientSecret`, access tokens, refresh tokens, code verifiers, authorization codes, or raw state JSON.

`client_credentials` can be planned as a narrow extension if trivial through the SDK provider APIs, but authorization-code manual OAuth is the required Slice 6 acceptance path. If client-credentials adds complexity, defer it.

## Auth storage design

Store all OAuth data under:

```text
~/.letta/mcp-adapter/auth/
```

Recommended layout:

```text
~/.letta/mcp-adapter/auth/
  <safe-server-key>.json
```

where `<safe-server-key>` is deterministic and path-safe, for example:

```ts
safeServerKey = encodeURIComponent(serverName).replace(/%/g, "_")
```

or a short hash of `{ serverName, url }` plus a readable server prefix. The key must prevent path traversal and collisions.

Recommended file shape:

```ts
interface OAuthAuthStoreFile {
  version: 1;
  serverName: string;
  serverUrl: string;
  updatedAt: number;
  state?: string;
  authorizationUrl?: string;
  codeVerifier?: string;
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  discoveryState?: OAuthDiscoveryState;
}
```

Storage rules:

- Create the auth directory recursively only when OAuth is invoked or tokens/state must be saved.
- Write files atomically with a temp file + rename, mirroring the cache-writing style.
- Set restrictive permissions when practical (`0o700` for directory, `0o600` for files) using Node `fs` APIs. Tests can assert content, not exact mode, if cross-platform mode behavior is flaky.
- Validate loaded JSON shape defensively. Malformed files should produce concise warnings/errors and should not crash module activation.
- `tokens`, `clientInformation.client_secret`, `codeVerifier`, and `state` are secrets or sensitive values. They may be stored in this auth file because the feature requires persistence, but must never be copied into cache, diagnostics, test snapshots, or user output.
- `auth-start` may show the authorization URL because the user must open it. The URL can contain OAuth `state`, `code_challenge`, and `client_id`; this is acceptable user-facing auth material, but still should not be logged elsewhere.

## New modules to add

### `src/mcp/oauth-store.ts`

Responsibilities:

- compute auth directory and per-server file path;
- sanitize server names / derive safe file names;
- load auth store files;
- validate auth store file shape enough for runtime safety;
- save auth store files atomically;
- delete credentials by scope for `invalidateCredentials`;
- expose small helpers for tests.

Suggested exports:

```ts
export interface OAuthStorePaths { authDir: string; authFile: string }
export interface OAuthAuthStoreFile { ... }

export function getOAuthAuthDir(home?: string): string;
export function getOAuthStorePaths(options: { home?: string; serverName: string; serverUrl: string }): OAuthStorePaths;
export function loadOAuthStore(options: ...): OAuthAuthStoreFile | null;
export function saveOAuthStore(options: ...): void;
export function updateOAuthStore(options: ..., update: (current) => OAuthAuthStoreFile): OAuthAuthStoreFile;
export function clearOAuthCredentials(options: ..., scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void;
export function redactOAuthMessage(error: unknown): string;
```

### `src/mcp/oauth-provider.ts`

Responsibilities:

- implement `OAuthClientProvider` against `oauth-store.ts`;
- adapt `ServerEntry.oauth` and HTTP URL into SDK `OAuthClientMetadata` / `OAuthClientInformationMixed`;
- capture authorization URLs during `auth-start`;
- perform state generation/validation support;
- keep secrets out of output/errors.

Suggested exports:

```ts
export interface OAuthProviderOptions {
  serverName: string;
  serverUrl: URL;
  definition: ServerEntry;
  home?: string;
  env?: Record<string, string | undefined>;
  now?: () => number;
}

export class FileOAuthClientProvider implements OAuthClientProvider { ... }

export function isOAuthEnabled(definition: ServerEntry): boolean;
export function assertOAuthServerConfig(serverName: string, definition: ServerEntry): void;
export function createOAuthProvider(options: OAuthProviderOptions): FileOAuthClientProvider;
export function parseOAuthRedirectUrl(rawRedirectUrl: string): { code: string; state?: string; error?: string; errorDescription?: string };
export function formatAuthStartResult(...): string;
export function formatAuthCompleteResult(...): string;
```

Provider behavior:

- `redirectUrl` returns `definition.oauth.redirectUri` for authorization-code flow.
- `clientMetadata` includes:
  - `redirect_uris: [redirectUri]`
  - `client_name` from config or default `Letta MCP Adapter`
  - `client_uri` if configured
  - `scope` if configured
  - `grant_types: ["authorization_code", "refresh_token"]` if useful/accepted by SDK schema
  - `response_types: ["code"]` if useful/accepted by SDK schema
- `clientInformation()` returns, in order:
  1. persisted dynamic registration client info, if present;
  2. static `{ client_id, client_secret? }` from config if `clientId` is configured;
  3. `undefined` to allow SDK dynamic registration if `saveClientInformation` is supported.
- `saveClientInformation(info)` persists dynamic registration info.
- `tokens()` returns persisted tokens.
- `saveTokens(tokens)` persists tokens and clears one-time authorization URL if desired.
- `state()` returns persisted state if present or generates a new cryptographically random state and persists it.
- `redirectToAuthorization(url)` persists `authorizationUrl` and returns; it must not open a browser or perform UI work.
- `saveCodeVerifier(verifier)` persists it.
- `codeVerifier()` returns persisted verifier or throws a concise missing-verifier error.
- `invalidateCredentials(scope)` removes only the requested scope.
- `saveDiscoveryState` / `discoveryState` persist/load SDK discovery state.

### `src/features/oauth-actions.ts`

Responsibilities:

- implement text-first tool actions;
- parse action args safely;
- call SDK `auth(...)` with the file-backed provider;
- format concise user/model-facing output;
- avoid leaking secrets.

Suggested exports:

```ts
export type OAuthActionResult = { ok: true; message: string } | { ok: false; message: string };

export async function executeOAuthAction(options: {
  action: "auth-start" | "auth-complete" | "auth-status" | "auth-clear";
  serverName: string | undefined;
  rawArgs: string | undefined;
  runtime: AdapterRuntime;
  ctx: RuntimeToolContext;
  state: ProxyState;
}): Promise<string>;

export async function executeAuthStart(...): Promise<string>;
export async function executeAuthComplete(...): Promise<string>;
export function formatAuthStatus(...): string;
```

Action behavior:

- `auth-start`:
  1. require `server`;
  2. require server configured;
  3. require HTTP URL server;
  4. require OAuth enabled and bearer not enabled;
  5. construct provider;
  6. call `auth(provider, { serverUrl })`;
  7. if result is `"AUTHORIZED"`, say tokens are already available/refreshed and suggest `mcp({ connect: "server" })`;
  8. if result is `"REDIRECT"`, load the persisted `authorizationUrl` and print instructions:
     - open this URL in a browser;
     - finish login;
     - copy the full redirected URL;
     - run `mcp({ action: "auth-complete", server: "server", args: "{\"redirectUrl\":\"...\"}" })`;
     - after success, run `mcp({ connect: "server" })` or `/mcp reconnect server`.
- `auth-complete`:
  1. require `server`;
  2. parse `args` as JSON object;
  3. require `redirectUrl` string, or optionally accept `code` string for test/headless convenience;
  4. parse URL query params: `code`, `state`, `error`, `error_description`;
  5. if OAuth provider returned an error, return concise error without dumping URL;
  6. validate state against the persisted state if present;
  7. call `auth(provider, { serverUrl, authorizationCode: code })`;
  8. verify `provider.tokens()` now returns an access token;
  9. return success and suggest reconnect.
- `auth-status` (optional but useful):
  - show whether OAuth is configured and whether tokens/client/discovery/verifier are present;
  - never show token values, client secrets, code verifier, state, or full raw store JSON.
- `auth-clear` (optional but useful):
  - requires approval already because the `mcp` tool requires approval;
  - clears OAuth store for the server;
  - returns concise output.

Keep the required acceptance actions (`auth-start`, `auth-complete`) first. Implement optional status/clear only after required path is green.

## Changes to existing modules

### `src/core/config.ts`

Tests first, then implementation:

- Interpolate OAuth string fields:
  - `oauth.clientId`
  - `oauth.clientSecret`
  - `oauth.scope`
  - `oauth.redirectUri`
  - `oauth.clientName`
  - `oauth.clientUri`
- Preserve `oauth: false`.
- Preserve unknown OAuth object fields if present.
- Validate only enough to avoid crashes; runtime OAuth validation lives in OAuth helpers.

### `src/core/cache.ts`

Tests first, then implementation:

- Ensure `computeServerHash` includes normalized OAuth config, including interpolated client ID/secret/scope/redirect URI, so metadata cache invalidates when OAuth client configuration changes.
- Do **not** include persisted OAuth tokens, code verifier, state, authorization URL, or discovery state in metadata cache hash.
- Existing bearer/header/url/transport hash behavior must remain unchanged.

### `src/mcp/http.ts`

Tests first, then implementation:

- Add helper to detect invalid mixed auth:
  - OAuth and bearer configured together should throw `InvalidServerConfigError`.
- Ensure bearer header resolution is skipped for OAuth servers.
- Keep existing bearer tests unchanged.

### `src/mcp/manager.ts`

Tests first, then implementation:

- When OAuth is enabled for an HTTP server, construct a file-backed `OAuthClientProvider` and pass it as `authProvider` to `StreamableHTTPClientTransport` and `SSEClientTransport`.
- Preserve existing custom headers by continuing to pass `requestInit.headers`.
- For SSE, preserve the Slice 5 custom `eventSourceInit.fetch` header merge; SDK `_commonHeaders()` will add OAuth `Authorization` from tokens before custom fetch is called.
- If connection fails with `UnauthorizedError` or a message indicating interactive OAuth is needed, return a concise message:

```text
Server "linear" requires OAuth authorization. Run mcp({ action: "auth-start", server: "linear" }) and then mcp({ action: "auth-complete", server: "linear", args: "{\"redirectUrl\":\"...\"}" }).
```

- Do not include authorization codes, state, client secret, access token, refresh token, or code verifier in errors.
- Existing Streamable HTTP/SSE fallback behavior must remain unchanged for non-OAuth HTTP servers.

### `src/features/proxy-tool.ts`

Tests first, then implementation:

- Replace `executeUnsupportedAction` for supported actions:
  - `auth-start`
  - `auth-complete`
  - optionally `auth-status` / `auth-clear`
- Preserve unsupported action precedence over `tool`, `connect`, `describe`, `search`, `server`.
- Require runtime/ctx for OAuth actions; if direct unit call lacks runtime, return a concise runtime-required message.
- Update `MCP_PROXY_PARAMETERS.action.description` from “Not implemented in Slice 3” to current supported action language.
- Update status/connect guidance where useful to mention auth-start only when OAuth failure happens, not in normal status output.

### `src/features/mcp-command.ts`

Minimum requirement: no command changes are required for acceptance because the spec’s OAuth entry points are `mcp` tool actions.

Optional, if implemented after tool actions are green:

- Extend parser with:
  - `/mcp auth-start <server>`
  - `/mcp auth-complete <server> <redirectUrl>`
  - `/mcp auth-status [server]`
  - `/mcp auth-clear <server>`
- Keep command result type `{ type: "output", output }`.
- Do not add `runWhenBusy`.
- Do not add panels or prompt results.
- Command should delegate to the same OAuth action helpers as the tool.

### `src/mod.ts`

Keep changes minimal:

- Update `createMcpTool` description to mention OAuth auth-start/auth-complete.
- Preserve registration guards.
- Preserve `requiresApproval: true` and `parallelSafe: false`.
- Preserve idle activation.

## Test fixtures to add

Add a deterministic OAuth-protected MCP HTTP fixture.

Suggested files:

```text
tests/fixtures/http-oauth-fixture.mjs
tests/helpers/oauth-fixture.ts
```

Fixture responsibilities:

- Serve a Streamable HTTP MCP endpoint at `/mcp`.
- Return 401 with an appropriate `WWW-Authenticate` header when no valid bearer access token is supplied.
- Serve OAuth discovery endpoints needed by the SDK, for example:
  - protected resource metadata (`/.well-known/oauth-protected-resource` or the exact URL needed by SDK discovery)
  - authorization server metadata (`/.well-known/oauth-authorization-server` and/or OIDC fallback if needed)
  - dynamic client registration endpoint if testing no-static-client flow
  - authorization endpoint that redirects to configured `redirect_uri` with `code` and `state`
  - token endpoint that exchanges code + verifier for access/refresh tokens
  - token endpoint refresh path, if testing refresh
- Keep test tokens deterministic but never log them.
- Expose helper methods for tests, e.g.:

```ts
const fixture = await startOAuthFixture(...);
fixture.url;              // MCP URL
fixture.redirectUri;      // redirect URI used in config
fixture.authorize(...);   // returns redirected URL or makes auth-start URL easy to follow
fixture.stop();
```

Simpler fixture strategy is acceptable if it uses real SDK auth behavior. Do not mock the adapter’s OAuth provider in all tests; at least one integration path should exercise the SDK `auth(...)` flow and the real MCP transport.

## Detailed TDD implementation steps

### Step 0: Re-ground, baseline, and API inspection

1. Re-read:
   - this plan;
   - `docs/letta-mcp-adapter-mod-spec.md` Slice 6;
   - `src/mod.ts`;
   - `src/mcp/manager.ts`;
   - `src/mcp/http.ts`;
   - `src/features/proxy-tool.ts`;
   - `src/features/mcp-command.ts`.
2. Re-open `creating-mods` skill if not already loaded.
3. Inspect installed MCP SDK declarations for OAuth APIs if uncertain:

```bash
rg -n "OAuthClientProvider|auth\(|UnauthorizedError|finishAuth" node_modules/@modelcontextprotocol/sdk/dist/esm/client -g '*.d.ts'
```

4. Run baseline:

```bash
bun run test
bun run typecheck
bun run build
```

Expected: all existing tests pass before changes.

### Step 1: OAuth config normalization tests

Add tests in `tests/config.test.ts` proving:

1. OAuth config fields are loaded unchanged when literals are used.
2. `${VAR}` and `$env:VAR` interpolate in `oauth.clientId`, `oauth.clientSecret`, `oauth.scope`, `oauth.redirectUri`, `oauth.clientName`, and `oauth.clientUri`.
3. `oauth: false` remains false.
4. Existing env/header/bearer interpolation tests remain green.

Implement the smallest `normalizeServerEntry` changes to pass.

Run:

```bash
bun run test tests/config.test.ts
bun run typecheck
```

### Step 2: OAuth cache hash tests

Add tests in `tests/cache.test.ts` proving:

1. hash changes when OAuth `clientId` changes;
2. hash changes when OAuth `clientSecret` env value changes;
3. hash changes when OAuth `redirectUri` changes;
4. hash does not depend on any persisted OAuth auth-store file;
5. existing bearer/header/url/transport hash tests remain green.

Implement normalized OAuth identity in `computeServerHash`.

Run:

```bash
bun run test tests/cache.test.ts tests/config.test.ts
bun run typecheck
```

### Step 3: OAuth store tests and implementation

Create `tests/oauth-store.test.ts` and `src/mcp/oauth-store.ts`.

Test:

1. auth dir defaults to `~/.letta/mcp-adapter/auth` with injectable `home`.
2. per-server file path is inside auth dir and safe for weird server names (`../evil`, spaces, slashes, Unicode).
3. missing store loads as `null`.
4. saved store can be loaded back.
5. saves create the directory.
6. saves are atomic enough: temp path is not left on success.
7. malformed JSON returns `null` or a concise warning/error according to chosen API.
8. `clearOAuthCredentials(..., "tokens")` removes tokens but preserves client/discovery where appropriate.
9. `clearOAuthCredentials(..., "all")` removes or resets all sensitive fields.

Implementation notes:

- Use `node:fs` sync APIs like the existing cache module unless async APIs simplify tests.
- Use `mkdirSync(dir, { recursive: true, mode: 0o700 })` and `writeFileSync(temp, data, { mode: 0o600 })` where practical.
- Keep the stored JSON sorted/deterministic enough for tests.

Run:

```bash
bun run test tests/oauth-store.test.ts
bun run typecheck
```

### Step 4: OAuth provider unit tests and implementation

Create `tests/oauth-provider.test.ts` and `src/mcp/oauth-provider.ts`.

Test:

1. `isOAuthEnabled` returns true for `auth: "oauth"`.
2. `isOAuthEnabled` returns true for `oauth: { ... }` even if `auth` omitted, if that is the chosen compatibility rule.
3. bearer + oauth mixed config throws `InvalidServerConfigError` without secret values.
4. OAuth without HTTP URL is rejected when provider/action is constructed.
5. authorization-code flow without `redirectUri` returns/throws actionable error.
6. provider `clientMetadata` includes redirect URI, client name, client URI, and scope.
7. static client info is returned from config client ID/secret.
8. dynamic client info can be saved and loaded.
9. `state()` generates and persists a non-empty value; repeated calls reuse it for the pending flow.
10. `redirectToAuthorization(url)` persists the URL.
11. `saveCodeVerifier` / `codeVerifier` round-trip.
12. `saveTokens` / `tokens` round-trip.
13. `invalidateCredentials` scopes remove the expected fields.
14. `parseOAuthRedirectUrl` extracts code/state and handles OAuth error params.
15. user-facing errors do not include client secret, tokens, code verifier, or authorization code.

Run:

```bash
bun run test tests/oauth-provider.test.ts tests/oauth-store.test.ts
bun run typecheck
```

### Step 5: HTTP OAuth fixture

Create `tests/fixtures/http-oauth-fixture.mjs` and `tests/helpers/oauth-fixture.ts`.

Test in `tests/http-fixtures.test.ts` or new `tests/oauth-fixture.test.ts`:

1. fixture starts and exposes an MCP URL.
2. unauthenticated `/mcp` request returns 401 with `WWW-Authenticate` metadata needed by SDK discovery.
3. OAuth metadata endpoints return valid JSON.
4. authorization endpoint returns a redirect containing `code` and original `state`.
5. token endpoint exchanges a valid code for deterministic access/refresh tokens.
6. MCP endpoint accepts the deterministic access token and lists/calls fixture tools.

Run:

```bash
bun run test tests/oauth-fixture.test.ts tests/http-fixtures.test.ts
bun run typecheck
```

### Step 6: OAuth actions tests and implementation

Create `tests/oauth-actions.test.ts` and `src/features/oauth-actions.ts`.

Test `auth-start`:

1. missing `server` returns a concise requirement message.
2. unknown server returns existing unknown-server style.
3. non-HTTP/stdout server returns OAuth requires HTTP URL.
4. server without OAuth config returns OAuth not configured.
5. missing `redirectUri` returns actionable config message.
6. configured OAuth server returns an authorization URL and exact next-step `auth-complete` instruction.
7. auth-start persists state/code verifier/client/discovery as expected, but output does not include store JSON or secrets.
8. if tokens already exist and refresh/authorization succeeds, output says authorized/refreshed and suggests reconnect.

Test `auth-complete`:

1. missing args returns JSON shape guidance.
2. invalid JSON returns concise parse error.
3. missing `redirectUrl` returns required message.
4. OAuth `error` redirect returns concise error.
5. state mismatch returns concise error and does not save tokens.
6. valid redirect exchanges code, persists tokens, and suggests reconnect.
7. output does not include access token, refresh token, code verifier, client secret, or full redirect URL.

Implementation:

- Use `auth(provider, { serverUrl })` for start.
- Use `auth(provider, { serverUrl, authorizationCode: code })` for complete.
- Use fixture helper for at least one integration-style action test.
- Use plain unit state for parse/error tests where possible.

Run:

```bash
bun run test tests/oauth-actions.test.ts tests/oauth-provider.test.ts tests/oauth-store.test.ts
bun run typecheck
```

### Step 7: Proxy tool action integration

Update `tests/proxy-tool.test.ts` / add `tests/proxy-oauth.test.ts`.

Test:

1. `mcp({ action: "auth-start", server: "remote" })` routes to OAuth action when runtime is present.
2. `mcp({ action: "auth-complete", server: "remote", args: "..." })` routes to OAuth action when runtime is present.
3. supported OAuth actions still take precedence over `tool`, `connect`, `describe`, `search`, and `server`.
4. unsupported actions still return concise unsupported-action message.
5. direct unit call without runtime returns runtime-required message for supported OAuth actions.
6. `MCP_PROXY_PARAMETERS.action.description` mentions supported OAuth actions, not “Not implemented in Slice 3”.
7. no supported action output leaks tokens/secrets.

Implement in `src/features/proxy-tool.ts` by delegating to `executeOAuthAction`.

Run:

```bash
bun run test tests/proxy-tool.test.ts tests/proxy-oauth.test.ts
bun run typecheck
```

### Step 8: Manager OAuth authProvider integration

Update `tests/manager-stdio.test.ts` or create `tests/manager-http-oauth.test.ts`.

Test with the OAuth fixture:

1. OAuth-enabled HTTP server with no tokens fails connect with an actionable auth-start/auth-complete message.
2. After auth-start/auth-complete persists tokens, `manager.connect(...)` succeeds using Streamable HTTP.
3. Tool/resource metadata can be listed after OAuth connect.
4. Existing custom headers still arrive alongside OAuth auth if fixture checks them.
5. SSE forced mode also uses OAuth tokens if fixture supports SSE; if not, add a narrow SSE fixture test or explicitly defer SSE OAuth fixture if Streamable path exercises the same provider behavior sufficiently.
6. Wrong/expired tokens trigger concise auth-required output and do not leak token values.
7. Existing bearer/custom-header/SSE fallback tests remain green.

Implementation:

- In `createHttpTransportConnection`, pass `authProvider` when OAuth is enabled.
- Preserve `requestInit.headers` for custom headers.
- Preserve `eventSourceInit.fetch` merge for SSE.
- Catch `UnauthorizedError` or equivalent and convert to concise guidance.

Run:

```bash
bun run test tests/manager-stdio.test.ts tests/manager-http-oauth.test.ts tests/http-transport.test.ts
bun run typecheck
```

### Step 9: Runtime/cache reconnect after auth-complete

Add `tests/runtime-oauth.test.ts`.

Test:

1. `runtime.connectAndRefresh` before auth returns auth-required guidance and does not write successful metadata cache.
2. `auth-start` + fixture redirect + `auth-complete` persists tokens under injected `home`.
3. `runtime.connectAndRefresh` after auth-complete succeeds and writes metadata cache.
4. Subsequent `runtime.callTool` against cached OAuth server succeeds.
5. Stale/changed OAuth config invalidates metadata cache as designed.
6. Auth store path uses `ctx.home`/runtime home injection in tests rather than real home.

Run:

```bash
bun run test tests/runtime-oauth.test.ts tests/runtime-http.test.ts tests/runtime-call.test.ts
bun run typecheck
```

### Step 10: Optional `/mcp` command OAuth aliases

Only do this step after the tool-action acceptance path is green. If time or complexity is high, explicitly defer command aliases and keep acceptance through the `mcp` tool actions.

If implemented, update `tests/mcp-command.test.ts`:

1. parser accepts `auth-start <server>`.
2. parser accepts `auth-complete <server> <redirectUrl>` without needing shell-like quoting; treat the rest of the string after server as the redirect URL.
3. parser accepts `auth-status [server]` if implemented.
4. parser accepts `auth-clear <server>` if implemented.
5. command output delegates to same OAuth action helpers.
6. command metadata/help mentions OAuth aliases.
7. command still returns `{ type: "output", output }`.
8. no `runWhenBusy`, panels, or prompt result is introduced.

Run:

```bash
bun run test tests/mcp-command.test.ts tests/oauth-actions.test.ts
bun run typecheck
```

### Step 11: Mod registration and activation regression

Update `tests/mod.test.ts`.

Test:

1. activation with tools+commands still registers exactly one tool `mcp` and one command `mcp`.
2. activation does not call `runtime.loadState`, `runtime.connectAndRefresh`, OAuth store load/save, or network operations.
3. tool keeps `requiresApproval: true`.
4. tool keeps `parallelSafe: false`.
5. tool schema still has `additionalProperties: false`.
6. tool action description mentions OAuth but no new standalone OAuth tool is registered.
7. command remains output-only in type definitions/tests.
8. dispose still calls registered disposers and `runtime.closeAll()`.

Run:

```bash
bun run test tests/mod.test.ts
bun run typecheck
bun run build
```

### Step 12: Secret-redaction audit tests

Add focused assertions across OAuth tests or a dedicated `tests/oauth-redaction.test.ts`.

Use placeholder secret values such as:

```text
client-secret-test-value
access-token-test-value
refresh-token-test-value
code-verifier-test-value
authorization-code-test-value
```

Test that these values do not appear in:

1. `auth-start` output, except the authorization URL may contain non-secret OAuth parameters like `state`, `code_challenge`, and `client_id`;
2. `auth-complete` success/failure output;
3. manager connect errors;
4. runtime call/connect errors;
5. `/mcp` command output, if command aliases are implemented;
6. metadata cache JSON.

Run:

```bash
bun run test tests/oauth-redaction.test.ts tests/oauth-actions.test.ts tests/manager-stdio.test.ts tests/runtime-oauth.test.ts
bun run typecheck
```

### Step 13: Full verification

Run the full suite:

```bash
bun run test
bun run typecheck
bun run build
```

Expected:

- all tests pass;
- TypeScript passes;
- bundle builds to `dist/letta-mcp-adapter.mjs`.

### Step 14: Non-goal and mod API audit

Run searches:

```bash
rg -n "directTools|permissions|approvalPolicy|ui\.|panels|statusValues|customStatusline|runWhenBusy|type: \"prompt\"|conversation\.fork|sendMessageStream|providers|events\." src tests docs/slice-6-oauth-plan.md
rg -n "access-token-test-value|refresh-token-test-value|client-secret-test-value|code-verifier-test-value|authorization-code-test-value|Authorization: Bearer|client_secret" src tests docs/slice-6-oauth-plan.md
rg -n "commands\.register|tools\.register|events\.|providers|permissions|ui\." src tests
```

Expected:

- no direct tools implemented;
- no permission overlays implemented;
- no UI panels/status/statusline implemented;
- no lifecycle/tool/turn events implemented;
- no providers implemented;
- no prompt-return commands or busy commands implemented;
- token/secret literal strings appear only in tests/docs and are explicitly asserted absent from user-facing outputs;
- mod registration remains limited to one `mcp` tool and one `/mcp` command.

## Acceptance checklist

Slice 6 is complete when:

1. `mcp({ action: "auth-start", server: "linear" })` returns an authorization URL and manual completion instructions for a configured OAuth HTTP MCP server.
2. `mcp({ action: "auth-complete", server: "linear", args: "{\"redirectUrl\":\"...\"}" })` exchanges the authorization code and persists tokens under `~/.letta/mcp-adapter/auth/`.
3. `mcp({ connect: "linear" })` or `/mcp reconnect linear` succeeds after auth-complete and caches tools/resources.
4. A subsequent OAuth-protected tool call succeeds through the compact `mcp` proxy.
5. OAuth token/client/discovery state persists across runtime instances by reading the auth store file.
6. Missing auth, missing redirect URI, unknown server, state mismatch, OAuth redirect errors, and expired/wrong tokens all produce concise actionable messages.
7. No access token, refresh token, client secret, code verifier, authorization code, or raw auth store JSON appears in user-facing output or metadata cache.
8. Existing stdio, Streamable HTTP, SSE fallback, custom header, and bearer auth behavior remains green.
9. Mod activation remains idle and capability-guarded.
10. The mod still registers one model-facing `mcp` tool and one human-facing `/mcp` command.
11. `bun run test`, `bun run typecheck`, and `bun run build` all pass.

## Non-goals for Slice 6

Do not implement:

- direct MCP tools (`directTools`) — Slice 7;
- Letta permission overlays — Slice 8;
- UI panels/status values/statusline;
- lifecycle/eager/keep-alive connection management;
- full Pi interactive panel parity;
- browser auto-open behavior;
- local OAuth callback listener, unless explicitly requested later;
- cloud secret managers or OS keychain integration;
- automatic auth-start from mod activation;
- automatic auth-start from normal status/search/list operations;
- storing OAuth tokens in metadata cache;
- changing the compact proxy-tool architecture.

## Handoff to implementation

When implementing this plan, stay strict TDD:

1. write a failing test for the current step;
2. implement the smallest code change;
3. run the focused test and `bun run typecheck`;
4. update the task plan before moving to the next step;
5. run full verification at the end;
6. audit against non-goals and secret leaks before declaring Slice 6 done.

All implementation decisions must remain grounded in:

- the actual Letta Code mod API exposed through the `creating-mods` skill;
- the installed `@modelcontextprotocol/sdk` OAuth APIs;
- the existing adapter architecture from Slices 1-5.
