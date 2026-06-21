# Slice 7 Plan: Optional Cache-Backed Direct MCP Tools

## Purpose

Slice 7 adds **optional direct MCP tool registration** on top of the compact `mcp` proxy tool.

The core architecture remains proxy-first:

- the compact `mcp` tool remains the default and must continue to work everywhere;
- direct tools are opt-in convenience affordances;
- direct tools are registered from **existing metadata cache only**;
- activation must never connect to MCP servers or perform OAuth/bearer network work just to discover direct tools.

This plan is the implementation checklist for Slice 7. Follow it step by step, using strict TDD: write the failing test first, implement the smallest code change, run the focused test and `bun run typecheck`, then move to the next step.

## Grounding in the actual Letta Code mod API

Before implementing, reload the `creating-mods` skill and keep these facts in view:

- Tools are registered with `letta.tools.register({ name, description, parameters, requiresApproval, parallelSafe, run(ctx) })`.
- Tool registration must be guarded with `letta.capabilities?.tools && letta.tools`.
- Mod activation has **no dynamic invocation context**. Dynamic workspace state is passed to tool/command callbacks as `ctx.cwd`; activation-time direct-tool discovery can only use explicit/global activation state such as `process.cwd()` or an injected test override.
- Tool names are validated by Letta Code as `^[a-zA-Z0-9_-]{1,64}$`.
- Tool parameter schemas must be JSON Schema object schemas.
- Tool `run(ctx)` must use `ctx.cwd`, `ctx.args`, and `ctx.signal` for invocation-time behavior.
- Return disposers for every registered tool and clean them up in reverse order on reload/shutdown.
- Do not import Letta Code internals.

Relevant skill references:

```bash
sed -n '1,220p' /Users/kyle/.local/share/mise/installs/node/24.15.0/lib/node_modules/@letta-ai/letta-code/skills/creating-mods/references/tools.md
sed -n '1,220p' /Users/kyle/.local/share/mise/installs/node/24.15.0/lib/node_modules/@letta-ai/letta-code/skills/creating-mods/references/architecture.md
```

If implementation requires changing `/mcp` command output, also ground that change in:

```bash
sed -n '1,240p' /Users/kyle/.local/share/mise/installs/node/24.15.0/lib/node_modules/@letta-ai/letta-code/skills/creating-mods/references/commands.md
```

## Current architecture to preserve

Current Slice 6 state:

- `src/mod.ts`
  - registers one proxy tool named `mcp` through `createMcpTool(runtime)`;
  - registers one slash command id `mcp` through `createMcpCommand(runtime)`;
  - guards capabilities and closes `runtime.closeAll()` in the returned disposer.
- `src/runtime.ts`
  - owns config/cache loading via `runtime.loadState(ctx)`;
  - owns live server connections via `runtime.connectAndRefresh(ctx, serverName)` and `runtime.callTool(ctx, state, toolName, rawArgs)`.
- `src/features/proxy-tool.ts`
  - builds `ProxyState` from config + metadata cache;
  - reconstructs cached exposed tool names using `reconstructToolMetadata`;
  - already supports proxy call formatting and lazy refresh.
- `src/core/tool-names.ts`
  - implements `toolPrefix`: `server`, `short`, `none`.
- `src/core/cache.ts`
  - persists cached MCP tools/resources and reconstructs exposed metadata.

Slice 7 should add a direct-tool registration layer without changing the MCP manager, transports, OAuth store, or command parser except for optional status/help hints.

## Product behavior

### Opt-in rules

Direct tools are **not default**.

A cached exposed tool is eligible for direct registration when all are true:

1. the server has a valid metadata cache for the current activation workspace;
2. the cached exposed tool is not excluded by `excludeTools`;
3. direct tools are enabled by one of:
   - `settings.directTools === true`, unless the server explicitly sets `directTools: false`;
   - `server.directTools === true`;
   - `server.directTools` is a non-empty string array and the tool matches the allow-list;
4. the final tool name is a valid Letta mod tool name and no longer than 64 characters;
5. the final tool name does not collide with the proxy tool `mcp`, a built-in/reserved tool, or another direct tool.

If `settings.directTools` is false or missing and `server.directTools` is missing/false, no direct tools are registered.

### Allow-list matching

When `server.directTools` is an array, match entries against normalized candidates:

- original MCP tool/resource synthetic name, e.g. `search_repositories`;
- exposed name under the active `toolPrefix`, e.g. `github_search_repositories`;
- exposed name under `server` prefix;
- exposed name under `short` prefix;
- hyphen/underscore-normalized variants of those names.

This mirrors existing `excludeTools` matching behavior and keeps config ergonomic.

### Resource-backed synthetic tools

Use the same reconstructed metadata source as the proxy (`ProxyServerState.tools`). That means resource-backed synthetic tools can be directly registered when they are present in cache, `exposeResources !== false`, and direct-tool selection allows them.

Direct resource tools should use an empty object schema and call through `runtime.callTool(...)`, which already handles resource targets.

### Activation-time behavior

Because actual Letta Code mod activation has no `ctx.cwd`, direct-tool discovery must be explicit:

- in production activation, use `process.cwd()` as the activation workspace for cache-backed registration;
- in tests, inject an activation cwd option to avoid relying on the test runner cwd;
- activation may read config/cache files, but must not connect to MCP servers, make HTTP requests, perform OAuth flows, start callback listeners, or write metadata/auth files.

If a user changes project `.mcp.json` or refreshes metadata, they should run `/reload` to refresh the direct tool registry.

### Direct tool invocation behavior

Each direct tool `run(ctx)` must:

1. respect `ctx.signal` and return `MCP request cancelled.` if already aborted;
2. load fresh invocation state with `runtime.loadState(ctx)` using the real invocation `ctx.cwd`;
3. call the underlying MCP target through `runtime.callTool(...)`;
4. pass direct tool arguments as `JSON.stringify(ctx.args ?? {})` because `runtime.callTool` expects the proxy JSON-string argument shape;
5. set a server hint in the runtime context (`args.server`) so `toolPrefix: none` or otherwise ambiguous names resolve to the intended server;
6. render output consistently with proxy calls:
   - success: `Called "tool" on "server".\n\n<output>`;
   - resource: `Read resource "uri" from "server".\n\n<output>`;
   - MCP tool error: `MCP tool "tool" on "server" returned an error.\n\n<output>`;
   - failure: return the concise failure message from `runtime.callTool`.

Do not start background model work from direct tool handlers. Do not use `ctx.conversation` unless a future slice explicitly requires it.

## Proposed implementation files

Add:

```text
src/features/direct-tools.ts
```

Update:

```text
src/mod.ts
tests/mod.test.ts
```

Add tests:

```text
tests/direct-tools.test.ts
tests/direct-tools-runtime.test.ts
```

Optional small updates if needed:

```text
src/features/proxy-tool.ts        # export shared call-result formatter if useful
src/features/mcp-command.ts       # only for direct-tool status/help hints if implemented
```

## Design sketch

### Direct tool descriptor

```ts
export interface DirectToolDescriptor {
  name: string;              // exposed Letta tool name
  serverName: string;
  originalName: string;      // original MCP tool name or synthetic resource name
  description: string;
  parameters: unknown;       // normalized object JSON Schema
  resourceUri?: string;
}
```

### Main helpers

```ts
export function collectDirectToolDescriptors(state: ProxyState): {
  descriptors: DirectToolDescriptor[];
  warnings: string[];
};

export function createDirectMcpTool(
  descriptor: DirectToolDescriptor,
  runtime: AdapterRuntime,
): LettaToolDefinition;

export function registerCachedDirectTools(options: {
  letta: LettaModApi;
  runtime: AdapterRuntime;
  activationCwd: string;
  diagnostics?: LettaModApi['diagnostics'];
}): Array<() => void>;
```

Implementation can choose slightly different names, but keep the separation:

1. pure descriptor collection from `ProxyState`;
2. pure tool definition creation for a descriptor;
3. mod registration glue that touches `letta.tools.register`.

### Tool schema normalization

Letta mod tools require object schemas. For cached MCP `inputSchema`:

- if it is a record and `type` is absent or `type === "object"`, use it;
- otherwise fall back to `{ type: "object", properties: {}, additionalProperties: true }` and add a warning;
- for resource-backed tools, use `{ type: "object", properties: {}, additionalProperties: false }`.

Never register a direct tool with a non-object parameter schema.

### Approval/safety defaults

Direct tools may mutate external systems. Until Slice 8 permission overlays exist:

- `requiresApproval: true`;
- `parallelSafe: false`.

Do **not** add permission overlays in Slice 7. Do **not** set `approvalPolicy: "alwaysAsk"` unless a focused test and plan change explicitly requires it; Slice 8 owns nuanced approval policy.

## Step-by-step implementation plan

### Step 0: Re-ground and baseline

Read the grounding docs and current source:

```bash
sed -n '1,220p' /Users/kyle/.local/share/mise/installs/node/24.15.0/lib/node_modules/@letta-ai/letta-code/skills/creating-mods/references/tools.md
sed -n '1,220p' /Users/kyle/.local/share/mise/installs/node/24.15.0/lib/node_modules/@letta-ai/letta-code/skills/creating-mods/references/architecture.md
sed -n '1,220p' src/mod.ts
sed -n '1,260p' src/features/proxy-tool.ts
sed -n '1,240p' src/runtime.ts
sed -n '1,220p' src/core/cache.ts
sed -n '1,180p' src/core/tool-names.ts
```

Run the baseline:

```bash
bun run test
bun run typecheck
bun run build
```

Expected: green before Slice 7 changes.

### Step 1: Descriptor collection tests

Create `tests/direct-tools.test.ts` with failing tests for pure descriptor collection.

Test cases:

1. no direct tools when `settings.directTools` is missing/false and servers do not opt in;
2. `settings.directTools: true` exposes all cached valid tools for all servers;
3. `server.directTools: true` exposes all cached valid tools for that server even when global setting is false;
4. `server.directTools: ["search_repositories"]` exposes only matching tools;
5. allow-list matching accepts original names, exposed names, and hyphen/underscore-normalized names;
6. `server.directTools: false` opts that server out when global setting is true;
7. stale/missing cache produces no descriptors and a reconnect-oriented warning;
8. `excludeTools` still removes excluded tools;
9. `toolPrefix: "server" | "short" | "none"` controls names using existing `formatToolName` behavior;
10. resource-backed synthetic tools are included only when reconstructed metadata includes them;
11. invalid/too-long/colliding names are skipped with warnings.

Run and confirm expected failure:

```bash
bun run test tests/direct-tools.test.ts
```

### Step 2: Implement descriptor collection

Create `src/features/direct-tools.ts` with descriptor collection helpers only.

Important details:

- Reuse `ProxyState` and `ProxyServerState.tools`; do not reimplement cache reconstruction.
- Reuse `normalizeToolName`/`formatToolName` semantics indirectly through already reconstructed tool names and explicit candidate matching.
- Keep warnings concise and actionable, e.g. `Direct tool "..." skipped because Letta tool names must be 1-64 characters using letters, numbers, underscores, or hyphens.`
- No Letta API calls in this pure helper.

Run:

```bash
bun run test tests/direct-tools.test.ts
bun run typecheck
```

### Step 3: Direct tool definition tests

Extend `tests/direct-tools.test.ts` or add a focused describe block for `createDirectMcpTool`.

Test cases:

1. tool definition uses descriptor `name`, description, and normalized object `parameters`;
2. direct tools default to `requiresApproval: true` and `parallelSafe: false`;
3. non-object MCP schemas fall back to an object schema;
4. resource descriptors use an empty object schema;
5. `run(ctx)` returns cancellation if `ctx.signal.aborted` before loading state;
6. `run(ctx)` passes `ctx.cwd` through `runtime.loadState` and `runtime.callTool`;
7. `run(ctx)` JSON-stringifies `ctx.args ?? {}` before calling runtime;
8. `run(ctx)` supplies the descriptor server as a server hint.

Use a fake runtime; do not start MCP fixtures in this step.

Run:

```bash
bun run test tests/direct-tools.test.ts
bun run typecheck
```

### Step 4: Implement direct tool definition and shared rendering

Implement `createDirectMcpTool(...)`.

If proxy call rendering is duplicated today, prefer extracting a shared helper from `src/features/proxy-tool.ts`, for example:

```ts
export function formatRuntimeCallToolResult(result: CallToolResult): string
```

Then both proxy and direct tools can format runtime results identically.

Keep the direct tool handler small:

```ts
async run(ctx) {
  if (ctx.signal?.aborted) return "MCP request cancelled.";
  const state = runtime.loadState(ctx);
  const result = await runtime.callTool(
    { ...ctx, args: { ...(ctx.args ?? {}), server: descriptor.serverName } },
    state,
    descriptor.name,
    JSON.stringify(ctx.args ?? {}),
  );
  return formatRuntimeCallToolResult(result);
}
```

Adjust exact code to match project types. Ensure the server hint cannot overwrite direct tool arguments in a way that is sent to the MCP server; it should only be in the runtime context, not in the JSON-stringified MCP arguments.

Run:

```bash
bun run test tests/direct-tools.test.ts tests/proxy-tool-call.test.ts
bun run typecheck
```

### Step 5: Registration helper tests

Add tests for `registerCachedDirectTools(...)` in `tests/direct-tools.test.ts` or `tests/mod.test.ts`.

Test cases:

1. no registration when `capabilities.tools` is false or `letta.tools` is missing;
2. registration reads activation state from injected `activationCwd` and `runtime.loadState({ cwd: activationCwd })`;
3. registration registers only descriptors returned from valid cache;
4. registration returns disposers for every registered direct tool;
5. duplicate/invalid registration failures are reported through `letta.diagnostics.report({ severity: "warning", message })` when diagnostics exist, not thrown from activation unless unexpected;
6. registration does not call `runtime.connectAndRefresh`, `runtime.callTool`, OAuth store helpers, or network APIs;
7. activation remains usable when direct-tool descriptor collection fails: proxy and command registration should still succeed.

Run:

```bash
bun run test tests/direct-tools.test.ts tests/mod.test.ts
bun run typecheck
```

### Step 6: Integrate direct registration into `src/mod.ts`

Update activation flow:

1. create `activationCwd` option for tests, defaulting to `process.cwd()` in actual activation;
2. keep proxy `mcp` tool registration guarded by `letta.capabilities?.tools && letta.tools`;
3. after proxy registration, register cached direct tools behind the same tools guard;
4. keep command registration unchanged except for optional text updates;
5. return a single disposer that reverses all disposers and then calls `runtime.closeAll()`.

Recommended shape:

```ts
export interface ActivateOptions {
  activationCwd?: string;
}

export default function activate(
  letta: LettaModApi,
  runtime: AdapterRuntime = createAdapterRuntime(),
  options: ActivateOptions = {},
) {
  const activationCwd = options.activationCwd ?? process.cwd();
  const disposers = [];

  if (letta.capabilities?.tools && letta.tools) {
    disposers.push(letta.tools.register(createMcpTool(runtime)));
    disposers.push(...registerCachedDirectTools({ letta, runtime, activationCwd }));
  }

  if (letta.capabilities?.commands && letta.commands) {
    disposers.push(letta.commands.register(createMcpCommand(runtime)));
  }

  return async () => { ... };
}
```

Do not implement `settings.disableProxyTool` in this step unless explicitly required by tests. Proxy availability is the safety fallback when direct-tool cache is missing.

Run:

```bash
bun run test tests/mod.test.ts tests/direct-tools.test.ts
bun run typecheck
```

### Step 7: Runtime fixture tests for direct stdio tools

Create `tests/direct-tools-runtime.test.ts`.

Use the existing stdio fixture and temp home/cwd helpers.

Test flow:

1. write `.mcp.json` with a fixture server and `directTools: ["echo"]`;
2. create runtime with injected temp `home`;
3. run `runtime.connectAndRefresh({ cwd }, "fixture")` to create metadata cache;
4. activate the mod with `activationCwd: cwd` and fake Letta tools registry;
5. assert that the proxy `mcp` plus direct `fixture_echo` are registered;
6. call the direct tool's `run({ cwd, args: { message: "hello" } })`;
7. assert output matches proxy-style call output and includes `hello`.

Also test the missing cache case:

1. write `.mcp.json` with direct tools configured;
2. activate without reconnect/cache;
3. assert only proxy `mcp` registers;
4. assert `mcp({})` or `/mcp tools` output tells the user to run reconnect.

Run:

```bash
bun run test tests/direct-tools-runtime.test.ts tests/runtime-call.test.ts tests/mod.test.ts
bun run typecheck
```

### Step 8: Runtime fixture tests for HTTP/bearer/OAuth direct tools

Add focused integration coverage without over-expanding:

1. HTTP bearer fixture:
   - configure `auth: "bearer"` with env token;
   - refresh cache;
   - activate direct tool;
   - call direct HTTP `remote_echo` and assert success.
2. OAuth fixture:
   - configure OAuth server direct tools;
   - complete `auth-start`/`auth-complete` using existing helpers;
   - refresh cache;
   - activate direct tool;
   - call direct OAuth `remote_echo` and assert success;
   - assert output does not leak OAuth tokens/client secret.

Run:

```bash
bun run test tests/direct-tools-runtime.test.ts tests/runtime-http.test.ts tests/runtime-oauth.test.ts
bun run typecheck
```

### Step 9: Tool prefix and collision regression tests

Add direct runtime or pure tests for prefix/collision details:

1. `toolPrefix: "short"` strips `-mcp` from server names for direct tool names;
2. `toolPrefix: "none"` registers original tool names only when they do not collide;
3. collision under `none` skips duplicate direct tools and reports a warning;
4. a cached tool named `mcp` is skipped to avoid colliding with the compact proxy tool;
5. too-long tool names are skipped before `letta.tools.register` sees them.

Run:

```bash
bun run test tests/direct-tools.test.ts tests/tool-names.test.ts tests/mod.test.ts
bun run typecheck
```

### Step 10: User-facing status/help hints

Keep this small and text-only.

If missing-cache direct tools are configured, status output should help users understand why direct tools did not appear after `/reload`:

- `mcp({})` / `/mcp status`: configured server with direct tools but no valid cache should still say to run `mcp({ connect: "server" })` or `/mcp reconnect <server>`.
- `/mcp tools`: existing no-cache reconnect guidance should remain sufficient, but tests may add a direct-tool-specific sentence if useful.

Do not add new slash commands unless necessary. Direct tool refresh should remain `/reload` after `/mcp reconnect` because Letta tool registration happens at activation.

Run:

```bash
bun run test tests/proxy-tool.test.ts tests/mcp-command.test.ts tests/direct-tools.test.ts
bun run typecheck
```

### Step 11: Bundle smoke tests

Extend existing build/mod smoke patterns if present, or add a bundle smoke test script in an existing test file.

Verify the built mod:

1. registers `mcp` and direct tools when cache exists;
2. direct tool definitions have object schemas;
3. direct tools have `requiresApproval: true` and `parallelSafe: false`;
4. direct tool disposers run on cleanup;
5. no command registration changes break `/mcp`.

Run:

```bash
bun run build
node -e '<small ESM import smoke if consistent with prior slice smoke style>'
```

If no prior node bundle smoke exists, keep this as a manual verification section in the final Slice 7 checklist rather than adding brittle tests.

### Step 12: Full verification

Run:

```bash
bun run test
bun run typecheck
bun run build
```

Expected: all green.

### Step 13: Non-goal/API audit

Before declaring Slice 7 complete, run targeted audits:

```bash
rg -n "events\.|permissions|ui\.|panels|statusValues|customStatusline|providers|runWhenBusy|conversation\.fork|sendMessageStream|approvalPolicy|alwaysAsk" src tests docs/slice-7-direct-tools-plan.md
rg -n "connectAndRefresh\(|manager\.connect\(|auth-start|auth-complete|loadOAuthStore|saveOAuthStore|fetch\(" src/features/direct-tools.ts src/mod.ts tests/direct-tools*.test.ts
rg -n "tools\.register|commands\.register" src tests
```

Expected:

- no permission overlays (Slice 8);
- no events, panels/status UI, providers, statusline, busy commands, or background conversation work;
- no activation-time MCP network connects or OAuth store operations for direct registration;
- `tools.register` includes the existing proxy tool plus cache-backed direct tools only behind `capabilities.tools`;
- `commands.register` remains one `/mcp` command behind `capabilities.commands`;
- direct tools use `ctx.cwd` at invocation time;
- all disposers are returned and reversed on cleanup.

## Acceptance checklist

Slice 7 is complete when:

1. Direct tools are opt-in and never registered by default.
2. Direct tools are registered at activation from valid metadata cache only.
3. Activation never connects to MCP servers or runs OAuth/bearer network work for direct discovery.
4. `settings.directTools`, `server.directTools: true`, `server.directTools: string[]`, and `server.directTools: false` behave as documented.
5. Direct tool names follow existing `toolPrefix` behavior (`server`, `short`, `none`).
6. Invalid, too-long, duplicate, or proxy-colliding direct tool names are skipped safely with concise warnings/diagnostics.
7. Direct tool schemas are always object schemas acceptable to `letta.tools.register`.
8. Direct tools call through the existing runtime path, so stdio, HTTP bearer, and OAuth behavior matches proxy calls.
9. Direct tool output is formatted consistently with proxy tool output.
10. Direct tools use `requiresApproval: true` and `parallelSafe: false` until Slice 8 permission overlays exist.
11. Missing/stale cache leaves the proxy tool available and tells the user to run `mcp({ connect: "server" })` or `/mcp reconnect <server>`.
12. `/reload` after reconnect/cache refresh is sufficient to update direct tool registration.
13. Existing proxy `mcp` and `/mcp` command behavior remains green.
14. `bun run test`, `bun run typecheck`, and `bun run build` pass.

## Non-goals for Slice 7

Do not implement:

- Letta permission overlays or nuanced approval policy — Slice 8;
- UI panels/status values/statusline;
- lifecycle/eager/keep-alive connection management;
- automatic cache refresh at activation;
- activation-time MCP server connection;
- activation-time OAuth flows or token refresh;
- local OAuth callback listener or browser auto-open;
- dynamic project-specific tool registration after activation without `/reload`;
- direct tool registration from missing/stale cache;
- prompt-return or busy-safe commands;
- providers or model integrations;
- importing Letta Code internals.

## Handoff to implementation

When implementing this plan:

1. use the `creating-mods` skill before coding and re-check `tools.md`/`architecture.md` whenever the mod API shape is in question;
2. keep implementation grounded in the actual installed Letta Code mod runtime, especially activation having no dynamic `ctx`;
3. write failing tests first;
4. prefer pure helpers before activation glue;
5. run focused tests plus `bun run typecheck` after every step;
6. run full verification before final response;
7. audit for non-goals and activation-time side effects before declaring the slice done.
