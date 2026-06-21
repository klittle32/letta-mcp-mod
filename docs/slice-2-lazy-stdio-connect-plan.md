# Slice 2 Plan: Lazy stdio MCP Connect and Metadata Cache Writes

## Purpose

Implement the second vertical slice of the Letta MCP Adapter mod: make the existing cache-backed `mcp` proxy live for stdio MCP servers by supporting explicit lazy connection, tool/resource metadata discovery, and metadata cache writes.

Slice 1 proved the Letta mod shape and cache-backed proxy UX. Slice 2 preserves status/list/search/describe behavior and adds:

```ts
mcp({ connect: "filesystem" })
```

After a successful connect, refreshed metadata should be available through:

```ts
mcp({ server: "filesystem" })
mcp({ search: "read" })
mcp({ describe: "filesystem_read_file" })
```

This slice still does **not** call arbitrary MCP tools. Actual `mcp({ tool, args })` calls remain Slice 3.

## Grounding Requirements

All implementation work for this slice must be grounded in the actual Letta Code mods API and the `creating-mods` skill guidance.

Before implementing or changing mod code, re-check:

- `creating-mods/SKILL.md`
- `creating-mods/references/tools.md`
- `creating-mods/references/architecture.md`

The relevant Letta mod API surface remains one model-callable tool registered during activation:

```ts
export default function activate(letta) {
  const disposers = [];
  const runtime = createAdapterRuntime();

  if (letta.capabilities.tools) {
    disposers.push(letta.tools.register({
      name: "mcp",
      description: "...",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      requiresApproval: true,
      parallelSafe: false,
      async run(ctx) {
        // use ctx.cwd, ctx.args, ctx.signal
      },
    }));
  }

  return async () => {
    for (const dispose of disposers.reverse()) dispose();
    await runtime.closeAll();
  };
}
```

### Important Letta API decision for Slice 2

Slice 1 used `requiresApproval: false` and `parallelSafe: true` because it was read-only introspection.

Slice 2 adds behavior that can spawn configured local processes and write `~/.letta/mcp-adapter/cache.json`. Per `creating-mods/references/tools.md`, `requiresApproval: false` is only for read-only low-risk local introspection. Therefore Slice 2 should change the `mcp` tool to:

```ts
requiresApproval: true
parallelSafe: false
```

Rationale:

- `connect` launches a local command from config.
- `connect` writes metadata cache.
- the tool now owns long-lived shared runtime state, so it is not parallel-safe at the tool-registration level.
- fine-grained mode-specific approvals can be improved later with permission overlays in Slice 8. Until then, safety beats convenience.

Constraints from the actual mod API and skill:

- Guard optional APIs with `letta.capabilities.*`.
- Use `letta.tools.register` only when `letta.capabilities.tools` is true.
- Tool parameters must remain a JSON Schema object with `additionalProperties: false`.
- Use `ctx.cwd` as the invocation workspace.
- Use callback context (`ctx`) rather than global app context.
- Respect `ctx.signal` for long-running operations where practical.
- Do not import Letta Code internals.
- Do not connect to MCP servers during mod activation.
- Return cleanup disposers from activation.
- Cleanup must close MCP clients/transports and any child processes on reload/shutdown.
- Keep output concise and actionable.
- Tools should return information for the model; do not start hidden model runs.

## Slice 2 Scope

### In scope

- Add MCP SDK dependency and stdio transport support.
- Add an adapter runtime object created at activation time but idle until tool invocation.
- Add `McpServerManager` for stdio server connections.
- Support explicit connect: `mcp({ connect: "server" })`.
- On connect:
  - validate the server is configured
  - reject unsupported HTTP-only servers with a clear Slice 5 message
  - start stdio MCP server lazily
  - initialize MCP client
  - list tools
  - list resources if supported
  - convert tools/resources to cache format
  - update in-memory cache
  - persist cache to `~/.letta/mcp-adapter/cache.json`
  - return concise summary
- Preserve Slice 1 behavior for status/list/search/describe, now using freshly updated cache after connect.
- Add integration tests using a local fixture stdio MCP server.
- Add tests for cleanup, error handling, cache writes, and duplicate/concurrent connect handling.
- Keep build output bundled to `dist/letta-mcp-adapter.mjs`.

### Out of scope

- Calling arbitrary MCP tools: `mcp({ tool: "...", args: "..." })` remains not implemented until Slice 3.
- HTTP MCP transport.
- SSE/Streamable HTTP.
- Bearer auth.
- OAuth.
- Direct tools.
- `/mcp` slash commands.
- Permission overlays.
- UI panels/status values.
- Sampling/elicitation.
- MCP UI resources beyond preserving cached metadata fields if present.
- Keep-alive/eager lifecycle modes.
- Idle disconnect timers.

Do not sneak these into Slice 2.

## Expected User-facing Behavior

### No config

```ts
mcp({ connect: "filesystem" })
```

returns:

```text
Server "filesystem" is not configured. Use mcp({}) to list configured servers.
```

### HTTP-only server in Slice 2

Given:

```json
{ "mcpServers": { "remote": { "url": "http://localhost:3000/mcp" } } }
```

`mcp({ connect: "remote" })` returns:

```text
Server "remote" uses HTTP MCP transport, which is not implemented in Slice 2. Slice 5 will add HTTP support.
```

### stdio server connects and caches metadata

Given:

```json
{
  "mcpServers": {
    "fixture": {
      "command": "node",
      "args": ["tests/fixtures/stdio-mcp-fixture.mjs"],
      "cwd": "."
    }
  }
}
```

Calling:

```ts
mcp({ connect: "fixture" })
```

returns something like:

```text
Connected to "fixture" and cached 2 tools, 1 resource.

Tools:
- fixture_echo - Echo a message
- fixture_list_items - List fixture items

Resources:
- fixture_get_fixture_readme - Read resource: fixture://readme
```

Then `mcp({ server: "fixture" })`, `mcp({ search: "echo" })`, and `mcp({ describe: "fixture_echo" })` should use the refreshed cache.

### Reconnect refreshes cache

Calling `mcp({ connect: "fixture" })` again should reuse or refresh the manager connection and update the cache. It must not duplicate metadata, leak processes, or corrupt the cache file.

### Failed server

If the configured command cannot start or does not speak MCP:

```text
Failed to connect to "broken": <short actionable message>
```

Status/search/describe should continue to work and should not crash the mod.

## Proposed Repository Structure After Slice 2

```text
src/
  mod.ts
  runtime.ts
  core/
    cache.ts
    config.ts
    schema-format.ts
    tool-names.ts
  features/
    proxy-tool.ts
  mcp/
    manager.ts
    metadata.ts
    stdio.ts

tests/
  cache.test.ts
  config.test.ts
  manager-stdio.test.ts
  mod.test.ts
  proxy-connect.test.ts
  proxy-tool.test.ts
  runtime.test.ts
  schema-format.test.ts
  tool-names.test.ts
  fixtures/
    stdio-mcp-fixture.mjs
    broken-server.mjs
    slow-server.mjs
```

## Dependency Plan

Add MCP SDK dependency:

```bash
bun add @modelcontextprotocol/sdk
```

Keep bundling to one ESM mod file:

```bash
bun run build
```

The bundle should include SDK dependencies unless Bun marks Node built-ins external. Do not rely on `~/.letta/mods` resolving local `node_modules`.

## Runtime Design

Slice 1 rebuilds config/cache state per invocation. Slice 2 needs long-lived state for connected MCP clients/transports.

Introduce:

```ts
export interface AdapterRuntime {
  manager: McpServerManager;
  loadState(ctx: LettaToolRunContext): ProxyState;
  connectAndRefresh(ctx: LettaToolRunContext, serverName: string): Promise<ConnectResult>;
  closeAll(): Promise<void>;
}
```

Activation creates the runtime but does not connect:

```ts
export default function activate(letta) {
  const runtime = createAdapterRuntime();
  const disposers = [];

  if (letta.capabilities?.tools && letta.tools) {
    disposers.push(letta.tools.register(createMcpTool(runtime)));
  }

  return async () => {
    for (const dispose of disposers.reverse()) dispose();
    await runtime.closeAll();
  };
}
```

Runtime responsibilities:

- Hold `McpServerManager` across tool invocations.
- Read config/cache during tool invocation so config file edits are visible without `/reload` where possible.
- Ensure `connect` updates in-memory and on-disk cache.
- Ensure all connected clients/transports close during mod dispose.
- Keep activation cheap and side-effect-free.

## Stdio Manager Design

### Public interface

```ts
export interface McpConnection {
  serverName: string;
  status: "connected" | "failed" | "closed";
  client: Client;
  close(): Promise<void>;
}

export interface McpServerManager {
  connect(serverName: string, definition: ServerEntry, options: ConnectOptions): Promise<McpConnection>;
  getConnection(serverName: string): McpConnection | undefined;
  close(serverName: string): Promise<void>;
  closeAll(): Promise<void>;
}
```

### Required behavior

- Only stdio definitions are supported in Slice 2:
  - `command` required
  - `args` optional
  - `env` optional
  - `cwd` optional
- HTTP-only definitions (`url`) return unsupported transport message.
- Missing both `command` and `url` returns invalid config message.
- Existing connected server can be reused for metadata refresh.
- Concurrent calls to connect to the same server dedupe to a single in-flight promise.
- `close(server)` closes the MCP client/transport and removes manager state.
- `closeAll()` closes every connection and clears in-flight state.
- Failed connection attempts should not leave zombie child processes or stale manager entries.
- Error messages should be concise.

### Context, paths, env, and signals

- Use `ctx.cwd` as the invocation workspace.
- Keep `~` expansion from Slice 1.
- Resolve relative `cwd` against `ctx.cwd` at connection time.
- Start from `process.env`, then overlay resolved/interpolated `definition.env`.
- Do not shell interpolate command strings. Use MCP SDK stdio transport with command/args arrays.
- Respect `ctx.signal` where SDK/transport APIs permit; otherwise check before/after async operations and close transport on abort.

## Metadata Discovery Design

On successful connect:

1. Call MCP list tools.
2. Call MCP list resources if supported.
3. Normalize to cache entries:

```ts
interface CachedTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  uiResourceUri?: string;
  uiStreamMode?: "eager" | "stream-first";
}

interface CachedResource {
  uri: string;
  name: string;
  description?: string;
}
```

4. Preserve only metadata needed for Slice 1 list/search/describe and future direct tools.
5. Compute config hash with existing `computeServerHash`.
6. Write cache entry:

```ts
cache.servers[serverName] = {
  configHash: computeServerHash(definition),
  cachedAt: Date.now(),
  tools,
  resources,
};
```

7. Save cache to disk.

Resource listing can fail if a server does not support resources. That should not fail the whole connect. Treat unsupported resources as an empty resource list and cache tools anyway.

If MCP SDK list operations expose pagination cursors, implement pagination if straightforward after inspecting actual SDK types. If not straightforward, test the non-paginated fixture and add an explicit TODO for pagination hardening.

## Cache Write Design

Slice 2 should add to `src/core/cache.ts`:

```ts
export function saveMetadataCache(options: { home?: string; cache: MetadataCache }): void;
export function updateServerCache(options: {
  home?: string;
  cache: MetadataCache;
  serverName: string;
  definition: ServerEntry;
  tools: CachedTool[];
  resources: CachedResource[];
  now?: number;
  env?: Record<string, string | undefined>;
}): MetadataCache;
```

Write behavior:

- Ensure parent directory exists.
- Write JSON with stable formatting.
- Prefer atomic-ish write: temp file in same directory then rename.
- Tests must use injected `home`, never real `~`.

## Proxy Design Changes

Mode precedence remains:

```text
action > tool > connect > describe > search > server > status
```

Slice 2 behavior:

- `action`: still not implemented.
- `tool`: still not implemented; message says Slice 3 adds tool calls.
- `connect`: implemented for stdio.
- `describe`: cache-backed, same as Slice 1.
- `search`: cache-backed, same as Slice 1.
- `server`: cache-backed, same as Slice 1.
- status: same as Slice 1 but copy changes from future-tense to current connect hint.

Update status hint to:

```text
Use mcp({ connect: "server" }) to connect and refresh cached metadata.
```

Connect output should include server name, cached tool count, cached resource count, a bounded list of discovered tools/resources, and a cache-updated note. If a server has many tools, show the first 20 and say how many were omitted.

## Test-driven Development Steps

Do these in order. Each step starts with tests, then implementation. Do not move to the next step until the focused tests and typecheck pass.

### Step 1: Dependency and SDK API spike

Actions:

1. Add MCP SDK dependency:

```bash
bun add @modelcontextprotocol/sdk
```

2. Inspect installed SDK files/types enough to confirm import paths for:

- client
- stdio transport
- list tools
- list resources
- close/cleanup

Likely imports, to verify before coding:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
```

Acceptance:

- Dependency is in `package.json`/lockfile.
- `bun run typecheck` passes after any placeholder import/API spike is removed or integrated.

### Step 2: Cache write tests first

Add tests to `tests/cache.test.ts`.

Test cases:

1. `saveMetadataCache` creates parent directory.
2. Saved cache round-trips through `loadMetadataCache`.
3. `updateServerCache` sets `configHash`, `cachedAt`, tools, resources.
4. `updateServerCache` preserves other servers.
5. Cache JSON is stable enough for review.

Implement in `src/core/cache.ts`:

- `saveMetadataCache`
- `updateServerCache`

Acceptance:

```bash
bun run test tests/cache.test.ts
bun run typecheck
```

### Step 3: Fixture stdio MCP servers

Create `tests/fixtures/stdio-mcp-fixture.mjs`.

Fixture behavior:

- Starts an MCP stdio server.
- Exposes at least two tools:
  - `echo` — description `Echo a message`, required `message: string` input schema.
  - `list_items` — description `List fixture items`, empty object input schema.
- Exposes at least one resource if SDK support is straightforward:
  - name: `Fixture README`
  - uri: `fixture://readme`
  - description: `Read resource: fixture://readme`

Create additional fixtures as needed:

- `tests/fixtures/broken-server.mjs` exits or writes invalid output.
- `tests/fixtures/slow-server.mjs` delays initialization for abort/timeout tests if practical.

Acceptance:

- Fixture is used only by tests; no real external MCP servers are needed.

### Step 4: Manager integration tests first

Create `tests/manager-stdio.test.ts`.

Test cases:

1. Connects to fixture stdio server.
2. Lists tools from fixture server.
3. Lists resources from fixture server, or returns empty resources if unsupported.
4. Reuses existing connection for second connect to same server.
5. Concurrent connect calls dedupe.
6. `close(server)` closes and removes connection.
7. `closeAll()` closes all connections.
8. Broken server returns concise error and leaves no connected entry.
9. HTTP-only server is rejected as unsupported in Slice 2.
10. Server missing both `command` and `url` returns invalid config error.
11. Relative `cwd` resolves against `ctx.cwd`.

Implement:

- `src/mcp/manager.ts`
- `src/mcp/stdio.ts`
- `src/mcp/metadata.ts` as needed

Acceptance:

```bash
bun run test tests/manager-stdio.test.ts
bun run typecheck
```

### Step 5: Metadata normalization tests first

Create focused tests in `tests/manager-stdio.test.ts` or `tests/proxy-connect.test.ts`.

Test cases:

1. MCP SDK tool metadata converts to `CachedTool`.
2. Tool name/description/input schema are preserved.
3. Resource name/uri/description are preserved.
4. Missing descriptions become empty/undefined consistently.
5. Unsupported resources do not fail connect.
6. UI metadata fields are preserved if present and easy to extract; otherwise explicitly defer UI metadata handling.

Implement metadata conversion helpers in `src/mcp/metadata.ts`.

### Step 6: Runtime tests first

Create `tests/runtime.test.ts` if runtime behavior is not already covered through proxy tests.

Test cases:

1. Runtime activation creates manager but does not connect.
2. `connectAndRefresh` connects, discovers metadata, updates cache object, and saves cache.
3. Runtime reloads config/cache per invocation where appropriate.
4. `closeAll` delegates to manager and is safe to call multiple times.
5. Cache writes use injected `home` in tests.

Implement `src/runtime.ts`.

Acceptance:

```bash
bun run test tests/runtime.test.ts
bun run typecheck
```

### Step 7: Proxy connect tests first

Create `tests/proxy-connect.test.ts`.

Test cases:

1. `mcp({ connect: "missing" })` reports unconfigured server.
2. `mcp({ connect: "http" })` reports HTTP unsupported in Slice 2.
3. `mcp({ connect: "fixture" })` connects and reports cached tool/resource counts.
4. After connect, `mcp({ server: "fixture" })` lists refreshed cached tools.
5. After connect, `mcp({ search: "echo" })` finds refreshed cached tool.
6. After connect, `mcp({ describe: "fixture_echo" })` shows schema.
7. Broken server returns concise failure and status still works afterward.
8. Status hint says connect is available, not future Slice 2.
9. `mcp({ tool: "fixture_echo" })` remains not implemented and says Slice 3 will add tool calls.
10. Mode precedence still holds.

Implement changes in:

- `src/features/proxy-tool.ts`
- `src/runtime.ts`

Acceptance:

```bash
bun run test tests/proxy-connect.test.ts tests/proxy-tool.test.ts
bun run typecheck
```

### Step 8: Mod registration tests first

Update `tests/mod.test.ts`.

Test cases:

1. Tool still registers only behind `letta.capabilities.tools`.
2. Tool still named `mcp`.
3. Parameters remain object schema with `additionalProperties: false`.
4. Tool now has `requiresApproval: true`.
5. Tool now has `parallelSafe: false`.
6. Activation creates runtime but does not connect.
7. Disposer closes runtime/manager.
8. `run(ctx)` passes `ctx.cwd`, `ctx.args`, and `ctx.signal` through to runtime/proxy.

Implement changes in `src/mod.ts`.

Acceptance:

```bash
bun run test tests/mod.test.ts
bun run typecheck
```

### Step 9: Full regression suite

Run:

```bash
bun run test
bun run typecheck
bun run build
```

Expected:

- All Slice 1 tests still pass or are intentionally updated for new Slice 2 behavior.
- New Slice 2 tests pass.
- Bundle builds to `dist/letta-mcp-adapter.mjs`.

### Step 10: Bundle smoke test

Run a local bundle import smoke test:

```bash
node --input-type=module <<'EOF'
import activate from './dist/letta-mcp-adapter.mjs';
const registered = [];
const dispose = activate({
  capabilities: { tools: true },
  tools: { register(tool) { registered.push(tool); return () => {}; } },
});
if (registered.length !== 1 || registered[0].name !== 'mcp') throw new Error('mcp tool not registered');
console.log('registered', registered[0].name, registered[0].requiresApproval, registered[0].parallelSafe);
await dispose?.();
EOF
```

Expected:

```text
registered mcp true false
```

### Step 11: Optional manual Letta smoke test

Only after automated checks pass, and only if ready to test the actual local mod environment.

Actions:

1. Copy bundle:

```bash
mkdir -p ~/.letta/mods
cp dist/letta-mcp-adapter.mjs ~/.letta/mods/letta-mcp-adapter.mjs
```

2. In Letta Code, run `/reload`.
3. Create a temporary workspace `.mcp.json` pointing at the fixture or a safe local MCP server.
4. Ask the agent/model to use:

```ts
mcp({})
mcp({ connect: "fixture" })
mcp({ search: "echo" })
mcp({ describe: "fixture_echo" })
```

5. Check diagnostics if load fails:

```text
~/.letta/mods/diagnostics/latest.json
```

Recovery if the mod breaks startup:

```bash
LETTA_DISABLE_MODS=1 letta
# or
letta --no-mods
```

Manual smoke is useful but not required to complete automated Slice 2 unless explicitly requested.

## Implementation Guardrails

- Do not commit unless the user explicitly asks.
- Do not implement MCP tool calls in Slice 2.
- Do not implement HTTP/SSE/Streamable HTTP in Slice 2.
- Do not implement OAuth or bearer auth in Slice 2.
- Do not add slash commands in Slice 2.
- Do not add direct tools in Slice 2.
- Do not add permission overlays in Slice 2.
- Do not connect to MCP servers during activation.
- Do not connect to real external MCP servers in automated tests.
- Do not read or write the real home directory in tests.
- Use injected `home`, `cwd`, and `env` in tests.
- Avoid shell strings; rely on MCP SDK stdio transport or `spawn`/`execFile` style APIs.
- Keep process cleanup strict; no zombie fixture servers after tests.
- Keep user-facing errors short and actionable.
- Respect `ctx.signal` where practical.
- Preserve Slice 1 cache-backed status/search/describe behavior.

## Completion Audit Checklist for Slice 2

Before declaring Slice 2 complete, verify every item below against real artifacts and command output.

### Deliverables

- `@modelcontextprotocol/sdk` dependency added.
- `src/mcp/manager.ts` exists.
- `src/mcp/stdio.ts` exists or stdio transport support is clearly implemented in manager.
- `src/mcp/metadata.ts` exists or metadata conversion support is clearly implemented.
- `src/runtime.ts` exists.
- `tests/fixtures/stdio-mcp-fixture.mjs` exists.
- Cache write helpers exist in `src/core/cache.ts`.
- Proxy connect behavior exists in `src/features/proxy-tool.ts`.
- Mod registration updated in `src/mod.ts`.
- Bundle still builds to `dist/letta-mcp-adapter.mjs`.

### Behavioral success criteria

- `mcp({ connect: "server" })` is implemented for stdio MCP servers.
- Connect validates unknown server.
- Connect rejects HTTP-only server with Slice 5 message.
- Connect starts a stdio MCP server lazily, not during activation.
- Connect lists tools.
- Connect lists resources or safely handles unsupported resources.
- Connect updates in-memory cache.
- Connect writes `~/.letta/mcp-adapter/cache.json` or injected test cache path.
- After connect, `server`, `search`, and `describe` use refreshed cache.
- `tool` calls remain not implemented and point to Slice 3.
- Activation does not connect.
- Dispose closes manager/connections.
- Tool uses actual Letta mod API and capability guard.
- Tool uses `ctx.cwd`, `ctx.args`, and `ctx.signal`.
- Tool has `requiresApproval: true` and `parallelSafe: false` for Slice 2.

### Verification commands

Run:

```bash
bun run test
bun run typecheck
bun run build
```

Also run a bundle import smoke test proving the built mod registers `mcp` and exposes the updated approval/parallel flags.

### Explicit non-goals verified absent

Confirm the implementation did not add:

- actual MCP tool calls
- HTTP transport
- OAuth
- direct tools
- `/mcp` slash command
- permission overlay
- UI panel/status value

## Definition of Done for Slice 2

Slice 2 is complete when:

1. All Slice 1 behavior still works, updated only where connect availability changes copy.
2. `mcp({ connect: "server" })` works for stdio MCP servers.
3. Metadata discovered from a real fixture stdio MCP server is cached.
4. Cache writes are tested and do not touch real home in tests.
5. Search/list/describe operate on refreshed cache after connect.
6. Manager cleanup is tested.
7. Connect errors are concise and do not crash status/search/describe.
8. Tool registration is grounded in actual Letta mod API and updated for Slice 2 safety.
9. Tests pass.
10. Typecheck passes.
11. Build passes.
12. Bundle smoke passes.
13. Completion audit finds no missing or weakly verified requirement.

## Next Slice Boundary

After Slice 2 is complete, Slice 3 should add actual proxy tool calls:

```ts
mcp({
  tool: "fixture_echo",
  args: "{\"message\":\"hello\"}"
})
```

Slice 3 should cover args JSON parsing/validation, lazy connect on tool calls, `client.callTool`, result content transformation, MCP `isError` handling with schema hints, and resource synthetic tool reads.

Do not start Slice 3 until Slice 2 is green and reviewed.
