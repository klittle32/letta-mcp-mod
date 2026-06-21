# Slice 5 Plan: HTTP MCP Servers + Bearer Auth

## Purpose

Slice 5 adds support for common remote MCP servers while preserving the Slice 1-4 contract:

- the compact model-facing `mcp` tool remains the only autonomous model tool registered by the mod;
- the human-facing `/mcp` command remains an output-only command for status/setup/reconnect controls;
- mod activation stays idle and capability-guarded;
- stdio behavior remains unchanged;
- OAuth remains a Slice 6 non-goal.

Authoritative feature scope from `docs/letta-mcp-adapter-mod-spec.md`:

```text
Slice 5: HTTP MCP servers + bearer auth

Goal: support common remote MCP servers.

Features:
- HTTP transport:
  - Streamable HTTP first
  - SSE fallback if needed
- Headers
- Bearer token support:
  - bearerToken
  - bearerTokenEnv
  - env interpolation
```

Acceptance config:

```json
{
  "mcpServers": {
    "my-http-server": {
      "url": "http://localhost:3001/mcp",
      "auth": "bearer",
      "bearerTokenEnv": "MY_TOKEN"
    }
  }
}
```

## Grounding in actual Letta Code mod API

This slice does **not** require new mod capabilities. It extends the runtime behind the already-registered tool/command.

Current mod surfaces, grounded in the `creating-mods` skill references:

- Model-facing tool:
  - registered with `letta.tools.register(...)`
  - guarded by `letta.capabilities?.tools && letta.tools`
  - uses `ctx.cwd`, `ctx.args`, and `ctx.signal`
  - keeps `requiresApproval: true`
  - keeps `parallelSafe: false`
  - returns model-readable text, not hidden model work
- Human-facing command:
  - registered with `letta.commands.register(...)`
  - guarded by `letta.capabilities?.commands && letta.commands`
  - command ID is `mcp`, with no leading slash
  - returns `{ type: "output", output }`
  - does not use `runWhenBusy`, panels, prompt returns, permission overlays, events, providers, or status values
- Activation:
  - only registers capabilities and returns cleanup disposers
  - must not load config, connect to MCP servers, make HTTP requests, read auth state, or write files at startup

Relevant skill references loaded while writing this plan:

- `creating-mods/SKILL.md`
- `creating-mods/references/tools.md`
- `creating-mods/references/commands.md`
- `creating-mods/references/architecture.md`

## Grounding in actual MCP SDK APIs

Installed MCP SDK version inspected: `@modelcontextprotocol/sdk` `1.29.0`.

Client transports available in the installed SDK:

```ts
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
```

`StreamableHTTPClientTransport` constructor shape from SDK declarations:

```ts
new StreamableHTTPClientTransport(url: URL, opts?: {
  authProvider?: OAuthClientProvider;
  requestInit?: RequestInit;
  fetch?: FetchLike;
  reconnectionOptions?: StreamableHTTPReconnectionOptions;
  sessionId?: string;
})
```

Important SDK behavior:

- Streamable HTTP is the preferred transport.
- It uses HTTP `POST` for JSON-RPC messages.
- It may use HTTP `GET` with SSE for server messages.
- Request headers are supplied through `requestInit.headers`.
- `Client.connect(transport, { signal, timeout })` starts the transport and performs initialization.

`SSEClientTransport` constructor shape from SDK declarations:

```ts
new SSEClientTransport(url: URL, opts?: {
  authProvider?: OAuthClientProvider;
  eventSourceInit?: EventSourceInit;
  requestInit?: RequestInit;
  fetch?: FetchLike;
})
```

Important SDK behavior:

- SSE transport is deprecated but still provided for migration/fallback.
- It opens the initial SSE stream to the configured URL.
- It receives an `endpoint` event and then sends JSON-RPC messages via separate `POST` requests.
- Request headers are supplied through `requestInit.headers`.
- For SSE's initial EventSource request, headers must be available through `eventSourceInit.fetch` or an SDK auth provider. Since Slice 5 is bearer-only and not OAuth, use a custom `fetch` in `eventSourceInit` to merge the same headers into the initial stream request.

Server-side test fixtures can use:

```ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
```

## Current codebase state before Slice 5

Key files after Slice 4:

```text
src/mod.ts
src/runtime.ts
src/core/config.ts
src/core/cache.ts
src/features/proxy-tool.ts
src/features/mcp-command.ts
src/mcp/manager.ts
src/mcp/metadata.ts
src/mcp/calls.ts
src/mcp/stdio.ts
```

Current behavior to change:

- `src/mcp/manager.ts` rejects `definition.url && !definition.command` with an `UnsupportedTransportError` that mentions Slice 5.
- Tests currently assert this unsupported message in:
  - `tests/manager-stdio.test.ts`
  - `tests/proxy-connect.test.ts`
  - `tests/proxy-tool-call.test.ts`
  - `tests/mcp-command.test.ts`

Current behavior to preserve:

- stdio connection manager behavior:
  - reuses an existing connected connection
  - dedupes concurrent connection attempts with `inFlight`
  - `close(server)` and `closeAll()` close transports and clear maps
  - broken servers leave no connection behind
  - missing both `command` and `url` remains invalid
- runtime behavior:
  - `connectAndRefresh` discovers metadata and saves cache
  - lazy tool calls refresh metadata if needed
  - cached tools/resources are rendered consistently
  - resource reads still work through synthetic tools
- command/tool behavior:
  - `/mcp reconnect` uses `runtime.connectAndRefresh`
  - `mcp({ connect: "server" })` uses `runtime.connectAndRefresh`
  - `mcp({ tool: "..." })` uses `runtime.callTool`

## Design decisions for Slice 5

### Transport selection

Add HTTP support in `McpServerManager.connect` by selecting transport from server config:

1. If `definition.command` is present, keep existing stdio path.
2. Else if `definition.url` is present, use HTTP path.
3. Else throw `InvalidServerConfigError`.

For HTTP path:

- Default behavior is `auto`:
  1. try `StreamableHTTPClientTransport` first;
  2. if connect fails, close that failed transport/client;
  3. try `SSEClientTransport` as fallback;
  4. if both fail, return a concise error including both failures.
- Optionally support a future-friendly config field:

```ts
transport?: "auto" | "streamable-http" | "sse"
```

This field is not required by the public Slice 5 acceptance config, but it is useful for deterministic tests and for users whose old SSE endpoint causes unwanted streamable attempts. Because `ServerEntry` already allows unknown keys, adding a typed optional field is backward-compatible.

### Connection shape

Generalize the manager's connection transport type from `StdioClientTransport` to the SDK's shared `Transport` interface:

```ts
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

export interface McpConnection {
  serverName: string;
  status: "connected" | "failed" | "closed";
  client: Client;
  transport: Transport;
  transportKind: "stdio" | "streamable-http" | "sse";
  close(): Promise<void>;
}
```

The extra `transportKind` enables precise tests and better status/debug output without changing the external tool schema.

### HTTP headers

Create a small focused helper, likely in a new file `src/mcp/http.ts`, to resolve headers:

```ts
export function resolveHttpHeaders(
  definition: ServerEntry,
  env: Record<string, string | undefined>,
): Record<string, string>
```

Header rules:

1. Start with `definition.headers ?? {}`.
2. Config loading already interpolates `${VAR}` and `$env:VAR` in `headers`, so helper should not double-resolve normalized config; tests should still cover `loadMcpConfig` interpolation end-to-end.
3. If bearer auth is configured, add `Authorization: Bearer <token>`.
4. Explicit `headers.Authorization` should not silently override a configured bearer token. Prefer one deterministic rule and test it. Recommended rule:
   - if `auth: "bearer"`, `bearerToken`, or `bearerTokenEnv` is present, the resolved bearer token sets `Authorization` and wins over any existing `Authorization` header;
   - otherwise user headers are passed as-is.
5. Preserve other custom headers exactly.

### Bearer token resolution

Add a focused helper:

```ts
export function resolveBearerToken(
  definition: ServerEntry,
  env: Record<string, string | undefined>,
): string | undefined
```

Rules:

- `bearerToken` supports env interpolation through existing `loadMcpConfig` normalization.
- `bearerTokenEnv` reads `env[definition.bearerTokenEnv]` at connection/hash time.
- Recommended precedence:
  1. `bearerTokenEnv` if present and set;
  2. `bearerToken` if present and non-empty;
  3. no token.
- If `auth: "bearer"` is set but neither source resolves to a non-empty token, throw `InvalidServerConfigError` with a concise message:

```text
Server "my-http-server" requires bearer auth but no bearer token was resolved. Set bearerToken or bearerTokenEnv.
```

- If `bearerTokenEnv` is present but missing/empty, throw a specific message:

```text
Server "my-http-server" references bearerTokenEnv "MY_TOKEN", but that environment variable is not set.
```

- Never include token values in error messages, test names, snapshots, diagnostics, or command output.

### URL validation

HTTP entries require a parseable `URL` from `definition.url`.

- `http:` and `https:` should be accepted.
- Other protocols should throw `InvalidServerConfigError`.
- Missing `url` with no `command` remains invalid.

Suggested messages:

```text
Server "remote" has invalid URL "not a url": <parse error>
Server "remote" uses unsupported URL protocol "ftp:". HTTP MCP servers require http: or https:.
```

### Fallback policy

`auto` mode should try Streamable HTTP first and SSE second. Keep fallback simple in Slice 5:

- fallback on connect/init failure from `Client.connect(...)`;
- close the failed client/transport before trying the next transport;
- if streamable succeeds, do not try SSE;
- if both fail, the final error should mention both attempts without secrets:

```text
Failed to connect to "remote" over HTTP MCP. Streamable HTTP failed: <message>. SSE fallback failed: <message>.
```

Do not add a long-lived retry loop in Slice 5; the SDK transport already has reconnection behavior for streams.

### Security and secret handling

- Do not log bearer token values.
- Do not put bearer token values in command output.
- Do not persist token values to cache except through the existing `computeServerHash` identity process. Note: `computeServerHash` currently includes resolved bearer token material to invalidate cache when credentials change. It hashes the value, not stores the raw token.
- Do not create OAuth token files in Slice 5.
- Do not add a credential UI or browser workflow.

### Mod API non-changes

Slice 5 should not add:

- new `tools.register` calls;
- direct per-server tools;
- `permissions` capability or approval overlays;
- UI panels/status values/statusline;
- lifecycle/tool/turn events;
- providers;
- command `prompt` returns;
- `runWhenBusy`;
- conversation forks or `sendMessageStream`.

## Detailed TDD implementation plan

Run tests after every step. Do not move to the next step until the current step's focused tests and typecheck pass.

### Step 0: Baseline and re-grounding

1. Run the full baseline:

```bash
bun run test
bun run typecheck
bun run build
```

2. Confirm Slice 4 is still green:

```text
15 test files / 192 tests
```

3. Re-read grounding references before edits:

```bash
sed -n '1,260p' /Users/kyle/.local/share/mise/installs/node/24.15.0/lib/node_modules/@letta-ai/letta-code/skills/creating-mods/references/tools.md
sed -n '1,220p' /Users/kyle/.local/share/mise/installs/node/24.15.0/lib/node_modules/@letta-ai/letta-code/skills/creating-mods/references/commands.md
sed -n '1,220p' /Users/kyle/.local/share/mise/installs/node/24.15.0/lib/node_modules/@letta-ai/letta-code/skills/creating-mods/references/architecture.md
```

4. Re-read MCP SDK transport declarations:

```bash
sed -n '1,260p' node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.d.ts
sed -n '1,240p' node_modules/@modelcontextprotocol/sdk/dist/esm/client/sse.d.ts
```

Expected: no code changes.

### Step 1: Unit-test HTTP URL/header/bearer helpers first

Create tests before implementation. Suggested new test file:

```text
tests/http-transport.test.ts
```

Initial tests for helper-only behavior:

1. `resolveHttpUrl` accepts `http://localhost:3001/mcp`.
2. `resolveHttpUrl` accepts `https://example.com/mcp`.
3. `resolveHttpUrl` rejects non-URL strings with `InvalidServerConfigError`.
4. `resolveHttpUrl` rejects non-http protocols.
5. `resolveBearerToken` returns token from `bearerTokenEnv` when set.
6. `resolveBearerToken` returns token from `bearerToken` when no env field is configured.
7. `bearerTokenEnv` takes precedence over `bearerToken` when both are configured.
8. `auth: "bearer"` with no resolved token throws `InvalidServerConfigError`.
9. Missing `bearerTokenEnv` throws a specific `InvalidServerConfigError` mentioning the env var name but not a token value.
10. `resolveHttpHeaders` preserves custom headers.
11. `resolveHttpHeaders` adds `Authorization: Bearer <token>` when bearer is configured.
12. Bearer Authorization overrides user-provided `Authorization` when bearer config is present.
13. Headers from `loadMcpConfig` interpolate `${VAR}` and `$env:VAR` end-to-end.

Implementation target:

```text
src/mcp/http.ts
```

Suggested exports:

```ts
export type HttpTransportKind = "streamable-http" | "sse";
export type HttpTransportMode = "auto" | HttpTransportKind;

export function resolveHttpUrl(serverName: string, definition: ServerEntry): URL;
export function resolveHttpMode(definition: ServerEntry): HttpTransportMode;
export function resolveBearerToken(serverName: string, definition: ServerEntry, env: Record<string, string | undefined>): string | undefined;
export function resolveHttpHeaders(serverName: string, definition: ServerEntry, env: Record<string, string | undefined>): Record<string, string>;
```

Run:

```bash
bun run test tests/http-transport.test.ts
bun run typecheck
```

### Step 2: Add HTTP config typing and cache hash tests

Update `src/core/config.ts`:

```ts
transport?: "auto" | "streamable-http" | "sse";
```

Keep existing unknown-field compatibility.

Add/adjust cache tests in `tests/cache.test.ts`:

1. hash changes when `url` changes;
2. hash changes when `headers` change;
3. hash changes when `auth` changes;
4. hash changes when `bearerTokenEnv` env value changes;
5. hash changes when `transport` changes, if `transport` is added to cache identity.

Important: `computeServerHash` already includes `url`, `headers`, `auth`, `bearerToken`, `bearerTokenEnv`, and `bearerTokenEnvValue`. Decide explicitly whether to include `transport`; recommended yes, because changing forced `sse` vs `streamable-http` may change metadata behavior.

Run:

```bash
bun run test tests/cache.test.ts tests/config.test.ts tests/http-transport.test.ts
bun run typecheck
```

### Step 3: Refactor manager to support multiple transport kinds without changing behavior yet

Before adding actual HTTP, refactor safely:

1. Change `McpConnection.transport` type to SDK `Transport`.
2. Add `transportKind: "stdio" | "streamable-http" | "sse"`.
3. Extract existing stdio connection construction into a private helper:

```ts
private async createStdioConnection(...): Promise<McpConnection>
```

4. Keep HTTP-only entries rejected for this step.
5. Update existing manager tests to expect `transportKind === "stdio"` for stdio fixture connections.

Run:

```bash
bun run test tests/manager-stdio.test.ts tests/runtime.test.ts tests/runtime-call.test.ts tests/proxy-connect.test.ts tests/proxy-tool-call.test.ts tests/mcp-command.test.ts
bun run typecheck
```

### Step 4: Add Streamable HTTP fixture server

Create a test fixture before manager implementation:

```text
tests/fixtures/http-streamable-fixture.mjs
```

Fixture behavior:

- starts a local HTTP server on an ephemeral port;
- writes one line of JSON to stdout so tests can discover the URL:

```json
{"url":"http://127.0.0.1:<port>/mcp"}
```

- handles `POST /mcp` and `GET /mcp` using `StreamableHTTPServerTransport`;
- exposes the same style of tool/resource metadata as the stdio fixture, e.g.:
  - tool `echo`
  - tool `auth_context` or `headers_seen`
  - resource `fixture://http-readme`
- optionally requires bearer auth when launched with env:

```text
REQUIRE_BEARER=secret
REQUIRE_HEADER_NAME=x-fixture-header
REQUIRE_HEADER_VALUE=present
```

Recommended fixture implementation details:

- Use Node `http.createServer`.
- Parse request bodies for `POST` and pass parsed JSON to `transport.handleRequest(req, res, parsedBody)`.
- For stateless tests, use `new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })`.
- Use the low-level `Server` API or existing fixture patterns to define tool/list, tools/call, resources/list, and resources/read handlers.
- Return `401` for missing/wrong bearer token before handing request to the MCP transport.
- Do not print bearer tokens to stdout/stderr.

Add a tiny helper in tests if needed:

```text
tests/helpers/http-fixture.ts
```

The helper should spawn the fixture with `process.execPath`, wait for the JSON line, and return `{ url, stop }`.

Tests initially can assert fixture startup only, and they may fail until implementation if they call the manager.

Run focused fixture tests after implementation is possible; if startup-only tests are added, run them now.

### Step 5: Implement Streamable HTTP manager connect

Update `src/mcp/manager.ts`:

1. Replace HTTP unsupported branch with HTTP path.
2. Add imports:

```ts
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
```

3. Add private helper:

```ts
private async createHttpConnection(serverName: string, definition: ServerEntry, options: ConnectOptions): Promise<McpConnection>
```

4. For streamable transport:

```ts
const transport = new StreamableHTTPClientTransport(url, {
  requestInit: { headers },
});
```

5. Reuse the existing client construction and `client.connect(transport, { signal, timeout })` pattern.
6. Set `transportKind: "streamable-http"` on success.
7. On failure, close transport/client and throw a concise wrapped message.

Add/convert tests:

1. `McpServerManager` connects to streamable HTTP fixture and lists tools/resources.
2. Manager reuses existing HTTP connection on second connect.
3. Manager dedupes concurrent HTTP connects.
4. `close(server)` closes HTTP connection and removes it.
5. `closeAll()` closes HTTP connections idempotently.
6. Broken/unreachable HTTP server returns concise error and leaves no connection.
7. Existing `rejects HTTP-only servers as unsupported in Slice 2` test is replaced with successful HTTP connect tests.

Run:

```bash
bun run test tests/http-transport.test.ts tests/manager-stdio.test.ts
bun run typecheck
```

### Step 6: Implement bearer/custom headers with Streamable HTTP integration tests

Using the streamable fixture:

1. Test custom headers are sent:
   - config uses `headers: { "x-fixture-header": "present" }`;
   - fixture requires that header;
   - `manager.connect` succeeds.
2. Test bearer token env is sent:
   - fixture requires `Authorization: Bearer secret`;
   - config uses `auth: "bearer", bearerTokenEnv: "MY_TOKEN"`;
   - runtime/manager env supplies `MY_TOKEN: "secret"`;
   - connect succeeds.
3. Test bearer token literal is sent:
   - config uses `auth: "bearer", bearerToken: "secret"`;
   - connect succeeds.
4. Test missing bearer env fails before or during connect with no secret leakage.
5. Test wrong bearer token returns concise failed-connect message and does not cache metadata.

Implementation touch points:

- `resolveHttpHeaders(...)` is used when constructing transport options.
- `ConnectOptions.env` is already supplied by `createAdapterRuntime`.

Run:

```bash
bun run test tests/http-transport.test.ts tests/manager-stdio.test.ts
bun run typecheck
```

### Step 7: Add SSE fallback fixture and manager fallback behavior

Create fixture:

```text
tests/fixtures/http-sse-fixture.mjs
```

Fixture behavior:

- starts an old-style SSE MCP server;
- prints `{"url":"http://127.0.0.1:<port>/sse"}`;
- handles `GET /sse` with `SSEServerTransport`;
- handles `POST /messages?...` or the endpoint emitted by `SSEServerTransport`;
- exposes at least one tool, e.g. `echo`.

Manager fallback tests:

1. Auto mode falls back to SSE when streamable connect fails and old SSE connect succeeds.
2. `transport: "sse"` skips streamable and connects directly with SSE.
3. `transport: "streamable-http"` does not fallback; it returns the streamable error.
4. Custom headers are sent on the initial SSE stream request and follow-up POST request.
5. Bearer token is sent on the initial SSE stream request and follow-up POST request.
6. If both streamable and SSE fail, error mentions both attempts and no secrets.

Implementation notes:

- For SSE, pass headers in both places:

```ts
const transport = new SSEClientTransport(url, {
  requestInit: { headers },
  eventSourceInit: {
    fetch: async (input, init) => fetch(input, {
      ...init,
      headers: mergeHeaders(init?.headers, headers),
    }),
  },
});
```

- Add a small `mergeHeaders` helper and test it if it is non-trivial.
- Close failed Streamable transport before trying SSE.
- Do not fallback from SSE to Streamable in forced `sse` mode.

Run:

```bash
bun run test tests/http-transport.test.ts tests/manager-stdio.test.ts
bun run typecheck
```

### Step 8: Runtime metadata cache integration for HTTP

Add tests in `tests/runtime.test.ts` or a new `tests/runtime-http.test.ts`:

1. `runtime.connectAndRefresh` against streamable HTTP fixture caches tools/resources.
2. Cache path remains `~/.letta/mcp-adapter/cache.json`.
3. Cached HTTP tools appear in `runtime.loadState({ cwd })`.
4. `mcp({ connect: "remote" })` reports connected/cached metadata for HTTP.
5. `mcp({ search: "echo" })` finds HTTP cached tool after reconnect.
6. Config hash invalidates when HTTP URL changes.
7. Config hash invalidates when bearer env value changes.
8. Failed HTTP auth does not write/update successful metadata cache for that server.

Implementation should mostly work once manager connect works. Adjust runtime error handling only if HTTP errors are too noisy.

Run:

```bash
bun run test tests/runtime-http.test.ts tests/proxy-connect.test.ts tests/proxy-tool.test.ts
bun run typecheck
```

### Step 9: Tool call and resource read integration for HTTP

Add tests in a new file or existing tool-call tests:

```text
tests/proxy-tool-http.test.ts
```

Test cases:

1. Lazy tool call to HTTP server refreshes metadata and calls `echo`.
2. Explicit server-hinted tool call works:

```ts
mcp({ server: "remote", tool: "echo", args: "{\"message\":\"hello\"}" })
```

3. Prefixed exposed tool call works after metadata refresh:

```ts
mcp({ tool: "remote_echo", args: "{\"message\":\"hello\"}" })
```

4. HTTP resource-backed synthetic tool reads a resource.
5. HTTP tool errors render through existing `renderCallToolResult` behavior.
6. HTTP read/call respects `ctx.signal` and timeout.
7. Auth failure from `callTool` is concise and contains no token.

Expected implementation touch points:

- Usually no changes outside manager/runtime should be required.
- Keep output shape consistent with stdio tests.

Run:

```bash
bun run test tests/proxy-tool-http.test.ts tests/runtime-call.test.ts tests/proxy-tool-call.test.ts
bun run typecheck
```

### Step 10: `/mcp` command behavior for HTTP

Update tests in `tests/mcp-command.test.ts`:

1. Replace the old HTTP unsupported reconnect test with HTTP reconnect success:
   - `/mcp reconnect remote` connects to HTTP fixture;
   - output says `Connected to "remote" and cached ...`.
2. `/mcp reconnect` with mixed stdio + HTTP reports both per-server results.
3. `/mcp tools` lists cached HTTP tools after reconnect.
4. `/mcp status` still shows configured server counts and warnings.
5. Missing bearer env in `/mcp reconnect remote` returns concise actionable output.
6. `/mcp setup` example remains simple and does not include secrets.

Implementation should mostly be inherited through `executeReconnectCommand` and runtime.

Run:

```bash
bun run test tests/mcp-command.test.ts tests/proxy-connect.test.ts
bun run typecheck
```

### Step 11: Update tests that still expect the old Slice 5 unsupported message

Search:

```bash
rg -n "HTTP MCP transport|Slice 5|unsupported" tests src
```

Replace old expectations with one of:

- HTTP success tests;
- invalid URL tests;
- unreachable HTTP failure tests;
- forced unsupported protocol tests.

Files likely needing updates:

```text
tests/manager-stdio.test.ts
tests/proxy-connect.test.ts
tests/proxy-tool-call.test.ts
tests/mcp-command.test.ts
src/mcp/manager.ts
```

Run affected tests:

```bash
bun run test tests/manager-stdio.test.ts tests/proxy-connect.test.ts tests/proxy-tool-call.test.ts tests/mcp-command.test.ts
bun run typecheck
```

### Step 12: Bundle smoke and mod API regression tests

Keep Slice 4 mod API behavior intact.

Run existing mod tests:

```bash
bun run test tests/mod.test.ts
```

Expected:

- exactly one model-facing tool named `mcp` registers when `capabilities.tools` is true;
- exactly one command id `mcp` registers when `capabilities.commands` is true;
- both can register in one activation;
- activation remains idle;
- tool schema remains compact object schema with `additionalProperties: false`;
- tool `requiresApproval` stays `true`;
- tool `parallelSafe` stays `false`;
- command has no approval/parallel/busy UI fields;
- disposer closes runtime once.

Run bundle smoke:

```bash
bun run build
node --input-type=module <<'NODE'
import activate from './dist/letta-mcp-adapter.mjs';
const tools = [];
const commands = [];
const dispose = activate({
  capabilities: { tools: true, commands: true },
  tools: { register(tool) { tools.push(tool); return () => {}; } },
  commands: { register(command) { commands.push(command); return () => {}; } },
});
console.log(JSON.stringify({
  tools: tools.map((tool) => tool.name),
  commands: commands.map((command) => command.id),
  toolRequiresApproval: tools[0]?.requiresApproval,
  toolParallelSafe: tools[0]?.parallelSafe,
  toolAdditionalProperties: tools[0]?.parameters?.additionalProperties,
  commandArgs: commands[0]?.args,
}));
await dispose?.();
NODE
```

Expected output should still include:

```json
{
  "tools": ["mcp"],
  "commands": ["mcp"],
  "toolRequiresApproval": true,
  "toolParallelSafe": false,
  "toolAdditionalProperties": false
}
```

### Step 13: Full verification

Run:

```bash
bun run test
bun run typecheck
bun run build
```

Then run bundle smoke from Step 12.

Expected final test count will increase beyond Slice 4's baseline:

```text
>= 15 test files
>= 192 tests
```

Record exact final counts in the completion response.

### Step 14: Explicit non-goal audit before declaring Slice 5 complete

Run:

```bash
rg -n "OAuth|auth-start|auth-complete|authorization_code|client_secret|redirect|token store|\.letta/mcp-adapter/auth|directTools|permissions|approvalPolicy|ui\.|panels|statusValues|customStatusline|runWhenBusy|type: \"prompt\"|conversation\.fork|sendMessageStream|providers|events\." src tests docs/slice-5-http-bearer-plan.md
```

Expected:

- OAuth appears only in docs/spec/config type references and explicit non-goal tests, not as implemented flow.
- No OAuth token persistence path is implemented.
- No direct per-server tools are registered.
- No permission overlay implementation.
- No UI panel/status/statusline implementation.
- No event/provider implementation.
- No `runWhenBusy` workflow.
- No prompt-returning command workflow.
- No conversation fork/background model workflow.

Also verify mod capability registrations remain limited:

```bash
rg -n "commands\.register|tools\.register|events\.|providers|permissions|ui\." src tests
```

Expected:

- existing `tools.register` for compact `mcp` tool;
- existing `commands.register` for `/mcp` command;
- no new capability registrations.

Finally audit secret leakage:

```bash
rg -n "secret|MY_TOKEN|Authorization|Bearer" src tests docs/slice-5-http-bearer-plan.md
```

Expected:

- token placeholder strings may appear in tests and docs;
- no code path prints resolved token values;
- no snapshots contain real tokens.

## Acceptance criteria

Slice 5 is complete when all of the following are true:

- Streamable HTTP MCP servers connect through the installed MCP SDK `StreamableHTTPClientTransport`.
- SSE MCP servers connect through SDK `SSEClientTransport` when fallback is needed or when forced.
- HTTP custom headers are sent to Streamable HTTP requests.
- HTTP custom headers are sent to SSE initial stream and POST requests.
- `auth: "bearer"` with `bearerTokenEnv` sends `Authorization: Bearer <env value>`.
- `auth: "bearer"` with `bearerToken` sends `Authorization: Bearer <token>`.
- Env interpolation continues to work for `headers` and `bearerToken` via config normalization.
- Missing bearer token config returns concise, actionable errors without leaking secrets.
- Wrong bearer tokens fail without updating successful cache metadata.
- HTTP metadata discovery caches tools/resources just like stdio.
- HTTP cached tools appear in `mcp({ search })`, `mcp({ describe })`, `/mcp tools`, and `/mcp status` behavior consistently.
- HTTP tool calls work through the same compact `mcp` proxy tool.
- HTTP resource reads work through synthetic resource tools if `exposeResources !== false`.
- Existing stdio behavior remains green.
- Existing Slice 4 command behavior remains green.
- Mod activation remains idle.
- Tool/command registration remains capability-guarded and unchanged in shape.
- Full tests pass.
- Typecheck passes.
- Build passes.
- Bundle smoke passes.

## Non-goals for Slice 5

Do **not** implement these in Slice 5:

- OAuth flows.
- `mcp({ action: "auth-start" })`.
- `mcp({ action: "auth-complete" })`.
- OAuth token storage under `~/.letta/mcp-adapter/auth/`.
- Browser redirect handling.
- Dynamic client registration.
- Direct per-server Letta tools.
- Permission overlays.
- UI panels, status values, or statusline customization.
- New command workflows that return `{ type: "prompt" }`.
- Busy-safe command workflows or `runWhenBusy`.
- Background/forked model conversations.
- Provider mods.
- Lifecycle/tool/turn events.

## Suggested implementation order summary

1. Baseline and re-grounding.
2. HTTP URL/header/bearer helper tests and implementation.
3. Config/cache typing and hash tests.
4. Manager refactor to generic transport type while preserving stdio.
5. Streamable HTTP fixture.
6. Streamable HTTP manager connect.
7. Bearer/custom header integration tests.
8. SSE fixture and fallback behavior.
9. Runtime/cache integration for HTTP.
10. HTTP tool/resource call integration.
11. `/mcp` command behavior for HTTP.
12. Replace old unsupported-message tests.
13. Mod/bundle regression tests.
14. Full verification.
15. Non-goal and secret-leak audits.

## Handoff to Slice 6

After Slice 5, the project should support local and remote bearer-protected MCP servers through the compact `mcp` proxy and `/mcp` command. Slice 6 should then add OAuth-specific workflows, token persistence, and `auth-start` / `auth-complete` actions. Do not start Slice 6 until Slice 5 is green and reviewed.
