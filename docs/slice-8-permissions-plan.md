# Slice 8 Plan: Letta Permission Overlays and MCP Safety

## Purpose

Slice 8 adds **Letta-specific permission overlay policy** for the MCP adapter.

The adapter is now usable through:

- one compact proxy tool named `mcp`;
- optional cache-backed direct MCP tools from Slice 7;
- slash commands for human-invoked setup, reconnect, and OAuth workflows.

Slice 8 should make model-initiated MCP use safer and less annoying by using Letta Code's actual mod permission overlay API:

- benign cached metadata operations should be auto-allowed by the overlay;
- risky MCP tool calls should force `ask`, `alwaysAsk`, or `deny` according to config;
- unknown/unconfigured targets should deny safely by default;
- execution-phase rechecks should not accidentally block already-approved risky calls, and should deny if a risky call reaches execution without the matching approval-phase decision.

Follow this plan step by step with strict TDD: write the failing test first, implement the smallest code change, run focused tests plus `bun run typecheck`, then move to the next step.

## Grounding in the actual Letta Code mods API

Before implementing, reload the `creating-mods` skill and re-read the permission/architecture references:

```bash
sed -n '1,220p' /Users/kyle/.local/share/mise/installs/node/24.15.0/lib/node_modules/@letta-ai/letta-code/skills/creating-mods/references/permissions.md
sed -n '1,220p' /Users/kyle/.local/share/mise/installs/node/24.15.0/lib/node_modules/@letta-ai/letta-code/skills/creating-mods/references/architecture.md
```

Keep these actual API facts in view:

- Permission registration is guarded by `letta.capabilities?.permissions && letta.permissions`.
- A permission overlay is registered with `letta.permissions.register({ id, description, check(event, ctx) })` and returns a disposer.
- Permission event shape is:

```ts
{
  agentId: string | null;
  conversationId: string | null;
  toolCallId: string | null;
  toolName: string;
  args: Record<string, unknown>;
  cwd: string;
  workingDirectory: string;
  permissionMode: string | null;
  phase: "approval" | "execution";
}
```

- Valid permission decisions are `allow`, `ask`, `alwaysAsk`, `deny`, or `undefined` for no opinion.
  - The skill reference lists `allow | ask | deny`, but the installed Letta Code runtime also accepts `alwaysAsk`. This was verified in the actual runtime at `normalizePermissionResult` / `composePermissionDecision` in `letta.js`.
- Composition order is: `deny` wins, then `alwaysAsk`, then `ask`, then `allow`, then `undefined`.
- Mod permission overlays run during approval classification and again immediately before execution after any `tool_start` transforms.
- During execution, `ask`/`alwaysAsk` cannot reopen approval. A risky call that needs approval must either be recognized as already approved and return `allow`, or return `deny`/an execution-blocking result.
- Mod permission overlays can override normal mod tool approval behavior unless an existing hard denial or `alwaysAsk` policy wins. In this adapter we should keep tool definitions conservative (`requiresApproval: true`, `parallelSafe: false`) as fallback, and use the overlay to allow known-benign calls when permissions are available.
- Do not import Letta Code internals. Use only the public mod API surface and callback `ctx`/`event` values.

Useful runtime audit commands while implementing:

```bash
rg -n "normalizePermissionResult|composePermissionDecision|checkModPermissions|phase: \"approval\"|phase: \"execution\"|normalizeModToolApprovalPolicy" /Users/kyle/.local/share/mise/installs/node/24.15.0/lib/node_modules/@letta-ai/letta-code/letta.js
```

## Current architecture to preserve

Current Slice 7 state:

- `src/mod.ts`
  - registers `mcp` when `letta.capabilities.tools` is available;
  - registers optional cache-backed direct tools when configured;
  - registers `/mcp` when `letta.capabilities.commands` is available;
  - returns a disposer that unregisters capabilities in reverse order and calls `runtime.closeAll()`.
- `src/features/proxy-tool.ts`
  - implements proxy status/search/describe/server listing;
  - handles `connect`, OAuth actions, and MCP tool calls only at invocation time;
  - exports `formatRuntimeCallToolResult` for proxy/direct call formatting.
- `src/features/direct-tools.ts`
  - collects direct tool descriptors from valid cache only;
  - registers direct tool definitions through `letta.tools.register`;
  - direct tool invocation calls through `runtime.callTool(...)` with a server hint.
- `src/runtime.ts`
  - owns config/cache loading and all live MCP connection/call paths;
  - `runtime.loadState(ctx)` reads config/cache only;
  - `runtime.connectAndRefresh(...)` and `runtime.callTool(...)` are live/network paths.
- `src/core/config.ts`
  - currently preserves unknown `settings` values but does not type `settings.approval`.

Slice 8 should add a permission layer without changing transports, OAuth internals, metadata discovery, or direct-tool cache registration behavior.

## Product behavior for Slice 8

### Config shape

Support the existing spec shape:

```json
{
  "settings": {
    "approval": {
      "dangerousTools": "alwaysAsk",
      "unknownServers": "ask",
      "configWrites": "alwaysAsk"
    }
  }
}
```

Add TypeScript types for this in `McpSettings`, but keep config loading tolerant:

```ts
export type ApprovalDecision = "allow" | "ask" | "alwaysAsk" | "deny";

export interface McpApprovalSettings {
  dangerousTools?: ApprovalDecision;
  unknownServers?: ApprovalDecision;
  configWrites?: ApprovalDecision;
}
```

Defaults for Slice 8:

```ts
{
  dangerousTools: "ask",
  unknownServers: "deny",
  configWrites: "alwaysAsk",
}
```

Invalid configured values should not throw during activation or permission checks. They should fall back to defaults and produce at most concise warnings in pure helper outputs or diagnostics.

### Scope of permission decisions

The permission overlay should own model-initiated tool calls only:

- proxy tool calls where `event.toolName === "mcp"`;
- direct MCP tool calls registered by Slice 7;
- no opinion (`undefined`) for unrelated tools.

Slash commands are not model tool calls. Letta's permission overlay API is for tool approval/execution, not slash command confirmation. Therefore:

- `/mcp setup create` remains a human-invoked command and should not be forced through a permission overlay in Slice 8;
- `settings.approval.configWrites` should be parsed and kept for future model-callable config-write operations, but no fake command-permission mechanism should be invented;
- if a future slice adds model-callable config writes, it must route those through a mod tool so the permission overlay can govern them.

This is an intentional grounding decision based on the actual Letta mod API.

### Benign proxy operations

For `mcp` proxy calls, the following are benign cached metadata operations and should return `allow` in both approval and execution phases:

- `mcp({})` status;
- `mcp({ search: "..." })`;
- `mcp({ describe: "..." })`;
- `mcp({ server: "configured-server" })` server listing;
- unsupported/non-mutating query errors that do not connect or call a tool.

These operations do not connect to MCP servers and do not mutate external systems.

### Live/network proxy operations

For `mcp` proxy calls that start live/network/auth work:

- `mcp({ connect: "server" })` should return `ask` by default for configured servers.
- OAuth actions (`auth-start`, `auth-complete`, `auth-clear`) should return `ask` by default because they may start callback listeners or change auth state. `auth-status` can return `allow` because it only reports local auth state.
- If the referenced server is not configured, return the configured `unknownServers` decision. Default is `deny`.

Do not connect, fetch, start OAuth, or write cache/auth files from permission checks. Permission checks should inspect only `event`, config/cache state loaded by `runtime.loadState({ cwd })`, and deterministic local helper logic.

### MCP tool-call risk detection

For actual MCP tool calls through either `mcp({ tool, args, server })` or direct tools:

1. Resolve the target server/tool from current cache-backed state when possible.
2. Deny unknown/unconfigured servers according to `unknownServers` defaulting to `deny`.
3. Treat tool names as risky when the exposed or original tool name matches this default pattern:

```ts
/delete|write|update|exec|run|shell|browser/i
```

4. Treat file/path arguments outside `event.cwd`/`event.workingDirectory` as risky.
5. For risky calls, return `settings.approval.dangerousTools` defaulting to `ask`.
6. For non-risky calls to configured/cache-resolved targets, return `allow`.

Path-risk detection should be conservative and deterministic:

- parse proxy `args` JSON when present;
- recursively inspect object fields with path-like key names such as `path`, `file`, `filename`, `dir`, `directory`, `cwd`, `root`, `target`, `dest`, `destination`;
- when a string value looks like a filesystem path, resolve relative values against `event.cwd` and flag absolute/resolved paths outside `event.cwd`;
- if JSON parsing fails, do not throw. Base the decision on tool-name/server risk and let the runtime return the parse error later.

### Approval/execution phase tracking

Because overlays run twice, implement an in-memory approval tracker inside the registered permission helper:

- At approval phase:
  - `allow` and `deny` decisions do not need tracking.
  - When returning `ask` or `alwaysAsk`, record a small fingerprint keyed by `event.toolCallId`.
- At execution phase:
  - If recomputed decision is `allow`, return `allow`.
  - If recomputed decision is `deny`, return `deny`.
  - If recomputed decision would be `ask` or `alwaysAsk`, return `allow` only when the same `toolCallId` has a matching approval-phase fingerprint, then delete that tracker entry.
  - If no matching approval-phase fingerprint exists, return `deny` with a concise reason such as `Risky MCP call reached execution without a matching prior approval.`

This prevents execution-phase `ask` from becoming an unavoidable execution block while still denying unsafe bypasses.

### Diagnostics

Use `letta.diagnostics?.report({ severity: "warning", message })` only for setup/degraded behavior, e.g. permission registration fails or invalid approval config is observed during activation. Do not log every permission decision.

## Proposed implementation files

Add:

```text
src/features/permissions.ts
tests/permissions.test.ts
```

Update:

```text
src/core/config.ts
src/mod.ts
tests/config.test.ts
tests/mod.test.ts
```

Optional updates only if tests require them:

```text
src/features/proxy-tool.ts      # export a small target-resolution helper only if needed; prefer pure helper code in permissions.ts first
tests/direct-tools.test.ts      # only if direct descriptor metadata must be exposed for permissions
```

Do not add UI panels, events, status values, providers, background conversations, or Letta internals imports in Slice 8.

## Design sketch

### Public helper API

`src/features/permissions.ts` should export pure helpers for TDD and one registration helper:

```ts
export type PermissionDecision = "allow" | "ask" | "alwaysAsk" | "deny";

export interface LettaPermissionEvent {
  agentId: string | null;
  conversationId: string | null;
  toolCallId: string | null;
  toolName: string;
  args: Record<string, unknown>;
  cwd: string;
  workingDirectory: string;
  permissionMode: string | null;
  phase: "approval" | "execution";
}

export interface PermissionCheckResult {
  decision: PermissionDecision;
  reason?: string;
}

export function normalizeApprovalSettings(settings: unknown): {
  approval: Required<McpApprovalSettings>;
  warnings: string[];
};

export function decideMcpPermission(
  event: LettaPermissionEvent,
  state: ProxyState,
  tracker?: ApprovalTracker,
): PermissionCheckResult | undefined;

export function registerMcpPermissions(options: {
  letta: LettaModApi;
  runtime: AdapterRuntime;
}): (() => void) | undefined;
```

Keep helpers deterministic and side-effect-light. The only mutable helper should be the approval tracker used to bridge approval and execution phases.

### Letta API extension in `src/mod.ts`

Extend the local test-facing `LettaModApi` type:

```ts
permissions?: {
  register(permission: {
    id: string;
    description: string;
    check(event: LettaPermissionEvent, ctx?: unknown): PermissionCheckResult | undefined | Promise<PermissionCheckResult | undefined>;
  }): () => void;
};
```

Guard registration:

```ts
if (letta.capabilities?.permissions && letta.permissions) {
  const disposePermission = registerMcpPermissions({ letta, runtime });
  if (disposePermission) disposers.push(disposePermission);
}
```

Registration order should be intentional and tested. Prefer registering permissions before tools so the overlay is available as soon as tools are registered, while still preserving reverse-order cleanup.

## Step-by-step implementation plan

### Step 0 — Re-ground and baseline

1. Reload `creating-mods` and read `permissions.md` plus `architecture.md`.
2. Inspect current source files:

```bash
sed -n '1,180p' src/mod.ts
sed -n '1,260p' src/features/proxy-tool.ts
sed -n '1,220p' src/features/direct-tools.ts
sed -n '1,220p' src/core/config.ts
```

3. Run the baseline:

```bash
bun run test && bun run typecheck && bun run build
```

Expected: green before Slice 8 changes.

### Step 1 — Config type and approval normalization tests

Add failing tests in `tests/permissions.test.ts` or `tests/config.test.ts` for:

1. `normalizeApprovalSettings(undefined)` returns defaults.
2. valid settings preserve `allow`, `ask`, `alwaysAsk`, `deny`.
3. invalid values fall back to defaults and produce concise warnings.
4. `McpSettings` can represent the `approval` object without `as any` in tests.

Focused run:

```bash
bun run test tests/permissions.test.ts tests/config.test.ts
```

Expected first failure: helper/types do not exist.

### Step 2 — Implement approval settings normalization

Implement in `src/features/permissions.ts`:

- `PermissionDecision` type;
- `DEFAULT_APPROVAL_SETTINGS`;
- `normalizeApprovalSettings(settings: unknown)`;
- robust object/value validation.

Update `src/core/config.ts` to type `settings.approval` while preserving tolerant loading.

Focused run:

```bash
bun run test tests/permissions.test.ts tests/config.test.ts && bun run typecheck
```

### Step 3 — Proxy permission decision tests for benign operations

Add failing tests for `decideMcpPermission`:

1. non-MCP tool returns `undefined`.
2. `mcp({})` returns `allow`.
3. `mcp({ search: "repo" })` returns `allow`.
4. `mcp({ describe: "github_search" })` returns `allow`.
5. `mcp({ server: "configured" })` returns `allow`.
6. `mcp({ server: "missing" })` follows `unknownServers`, defaulting to `deny`.

Use `createProxyState(...)` with small in-memory configs/caches; do not create live MCP servers.

Focused run:

```bash
bun run test tests/permissions.test.ts
```

Expected failure: `decideMcpPermission` not implemented.

### Step 4 — Implement benign proxy decisions

Implement enough of `decideMcpPermission` to classify benign proxy calls and unknown server references.

Rules:

- Read `state.config.settings?.approval` through `normalizeApprovalSettings`.
- Return `undefined` unless `event.toolName === "mcp"` or the tool name is a known cached direct tool.
- For `mcp` status/search/describe/list operations, return `allow`.
- For `mcp({ server })`, return `allow` only if configured; otherwise default `deny` with a clear reason.

Focused run:

```bash
bun run test tests/permissions.test.ts && bun run typecheck
```

### Step 5 — Proxy live/network and OAuth decision tests

Add failing tests for:

1. `mcp({ connect: "configured" })` returns `ask` with a reason.
2. `mcp({ connect: "missing" })` returns default `deny`.
3. `unknownServers: "ask"` changes missing-server decision to `ask` at approval phase.
4. `mcp({ action: "auth-status", server: "configured" })` returns `allow`.
5. `mcp({ action: "auth-start", server: "configured" })` returns `ask`.
6. `mcp({ action: "auth-complete", server: "configured", args: "..." })` returns `ask`.

No test should assert that runtime live methods are called.

Focused run:

```bash
bun run test tests/permissions.test.ts
```

### Step 6 — Implement live/network and OAuth decisions

Implement the minimum policy for `connect` and `action`:

- configured `connect` -> `ask`;
- unknown `connect` -> configured `unknownServers` decision;
- `auth-status` -> `allow` for configured target;
- state-changing OAuth actions -> `ask` for configured target, unknown-server decision otherwise.

Focused run:

```bash
bun run test tests/permissions.test.ts && bun run typecheck
```

### Step 7 — MCP tool-call risk tests

Add failing tests for proxy tool calls:

1. benign configured cached call, e.g. `mcp({ tool: "github_search", args: "{}" })`, returns `allow`.
2. dangerous exposed name matching `delete|write|update|exec|run|shell|browser` returns default `ask`.
3. `dangerousTools: "alwaysAsk"` returns `alwaysAsk`.
4. `dangerousTools: "deny"` returns `deny`.
5. original MCP name is considered, not only exposed name.
6. unknown tool/ambiguous unresolved target denies safely or follows unknown-server policy where a server hint is missing/unknown.
7. invalid proxy `args` JSON does not throw.

Use cache-backed `ProxyState` so no live metadata discovery is needed.

Focused run:

```bash
bun run test tests/permissions.test.ts
```

### Step 8 — Implement MCP tool-call risk detection

Implement helper functions in `src/features/permissions.ts`:

- `isDangerousToolName(name: string): boolean`;
- target lookup against `state.servers[*].tools`, matching exposed and original names;
- server-hint handling using `event.args.server` where provided;
- no-throw parsing of proxy `args` JSON.

Prefer existing public project helpers where appropriate (`findToolByName` if exported and useful), but do not import Letta Code internals.

Focused run:

```bash
bun run test tests/permissions.test.ts && bun run typecheck
```

### Step 9 — Path-outside-cwd risk tests

Add failing tests for:

1. path-like args inside `cwd` return `allow` for otherwise benign tools.
2. relative paths resolving inside `cwd` return `allow`.
3. absolute paths outside `cwd` return default `ask`.
4. nested path-like fields are inspected.
5. non-path strings are ignored.
6. path-risk uses `event.workingDirectory`/`event.cwd` and does not read the filesystem.

Focused run:

```bash
bun run test tests/permissions.test.ts
```

### Step 10 — Implement path-risk detection

Implement recursive path inspection:

- inspect plain objects and arrays;
- look for path-like keys;
- resolve strings with `node:path.resolve(base, value)` unless they are clearly URLs or opaque identifiers;
- use a robust `isPathInside(base, candidate)` helper based on `path.relative`;
- never call `existsSync`, `stat`, or any filesystem read.

Focused run:

```bash
bun run test tests/permissions.test.ts && bun run typecheck
```

### Step 11 — Direct tool permission tests

Add failing tests for direct tools:

1. known cached direct tool with benign name/args returns `allow`.
2. known cached direct tool with dangerous exposed/original name returns `ask` by default.
3. direct tool path args outside cwd return `ask` by default.
4. direct tool whose current config/cache no longer contains a matching target returns `deny` with a clear reason.
5. when direct tools are not enabled in current state but the event tool name is `mcp`, proxy behavior is unchanged.

This should use the same reconstructed cached metadata source as Slice 7 where possible.

Focused run:

```bash
bun run test tests/permissions.test.ts tests/direct-tools.test.ts
```

### Step 12 — Implement direct tool decisions

Implement direct-tool recognition in `decideMcpPermission`:

- reconstruct/collect cache-backed direct descriptors from current `ProxyState` using Slice 7 helpers if practical;
- match `event.toolName` against direct descriptor names;
- evaluate dangerous name/path risk the same way as proxy calls;
- deny if the event looks like an MCP direct tool from a previous registry but current state cannot resolve it safely.

Be careful not to produce false opinions for unrelated tool names. If in doubt, only treat a non-`mcp` tool as an MCP direct tool when it is present in current direct descriptor collection or matches a previously registered direct tool name captured during activation.

Focused run:

```bash
bun run test tests/permissions.test.ts tests/direct-tools.test.ts && bun run typecheck
```

### Step 13 — Approval/execution tracker tests

Add failing tests for the two-phase behavior:

1. approval phase risky call returns `ask` and records a fingerprint.
2. matching execution phase call with same `toolCallId` returns `allow` and consumes the fingerprint.
3. execution phase risky call without a prior matching approval returns `deny`.
4. execution phase with changed args/tool/server after approval returns `deny`.
5. `dangerousTools: "deny"` denies in both phases and is not tracked.
6. benign calls return `allow` in both phases without tracking.

Focused run:

```bash
bun run test tests/permissions.test.ts
```

### Step 14 — Implement approval tracker

Implement an `ApprovalTracker` helper or closure:

```ts
class ApprovalTracker {
  remember(event: LettaPermissionEvent, fingerprint: string): void;
  consume(event: LettaPermissionEvent, fingerprint: string): boolean;
}
```

Fingerprint should include at least:

- `toolName`;
- stable JSON of `args`;
- `cwd`/`workingDirectory`;
- resolved risk category/reason.

Keep the tracker bounded. A simple `Map<string, string>` keyed by `toolCallId` is enough for Slice 8; delete on consume. If desired, cap map size to avoid unbounded growth during long sessions.

Focused run:

```bash
bun run test tests/permissions.test.ts && bun run typecheck
```

### Step 15 — Permission registration helper tests

Add tests for `registerMcpPermissions`:

1. no `capabilities.permissions` -> no registration and returns `undefined`.
2. missing `letta.permissions` -> no registration and returns `undefined`.
3. with capability/API -> registers exactly one permission id, e.g. `letta-mcp-adapter` or `letta-mcp-adapter-permissions`.
4. registered `check(event)` calls `runtime.loadState({ cwd: event.cwd, args: {}, signal: ctx?.signal? })` or an intentionally minimal cwd-only context; it must not call `connectAndRefresh` or `callTool`.
5. `runtime.loadState` errors result in a safe `deny` with a concise reason.
6. disposer returned by `letta.permissions.register` is returned and called by mod activation cleanup later.

Focused run:

```bash
bun run test tests/permissions.test.ts tests/mod.test.ts
```

Expected failure: registration helper not implemented.

### Step 16 — Implement `registerMcpPermissions`

Implement:

```ts
export function registerMcpPermissions({ letta, runtime }: ...): (() => void) | undefined
```

Behavior:

- capability/API guard;
- create an approval tracker closure;
- register one permission overlay;
- in `check(event, ctx)`, load current state with `runtime.loadState({ cwd: event.cwd })`;
- call `decideMcpPermission(event, state, tracker)`;
- catch unexpected errors and return `{ decision: "deny", reason: "MCP permission check failed: ..." }`;
- do not perform live MCP work.

Focused run:

```bash
bun run test tests/permissions.test.ts tests/mod.test.ts && bun run typecheck
```

### Step 17 — Mod activation integration tests

Update `tests/mod.test.ts` for actual activation behavior:

1. when `capabilities.permissions` is false/missing, no permission is registered and existing tool/command registration still works.
2. when permissions are available, activation registers permissions behind the guard.
3. activation still registers `mcp`, direct tools, and `/mcp` according to their own guards.
4. activation may read cache for direct tools but permission registration itself must not connect/call.
5. cleanup disposers run in reverse order and include the permission disposer.
6. command registration still does not add unsupported approval fields or UI dependencies.

Focused run:

```bash
bun run test tests/mod.test.ts tests/permissions.test.ts tests/direct-tools.test.ts
```

### Step 18 — Integrate in `src/mod.ts`

Update `src/mod.ts`:

- add `permissions` to `LettaModApi`;
- import `registerMcpPermissions`;
- register permission overlay behind `letta.capabilities?.permissions && letta.permissions`;
- keep cleanup reverse-order and `runtime.closeAll()`;
- do not change direct/proxy tool runtime behavior except through permission overlay decisions.

Focused run:

```bash
bun run test tests/mod.test.ts tests/permissions.test.ts tests/direct-tools.test.ts && bun run typecheck
```

### Step 19 — Runtime-focused safety regression tests

Add or update focused tests proving permission code does not cause runtime side effects:

1. permission check for `mcp({ search })` does not call `runtime.connectAndRefresh` or `runtime.callTool`.
2. permission check for dangerous direct tool does not call live runtime methods.
3. permission check for OAuth action does not start OAuth or touch OAuth store.
4. permission check for HTTP server does not fetch or connect.

These can use fake runtime spies; avoid brittle integration with Letta's full approval engine.

Focused run:

```bash
bun run test tests/permissions.test.ts tests/runtime-http.test.ts tests/runtime-oauth.test.ts
```

### Step 20 — Optional help/status copy

If tests or manual UX indicate users need discoverability, add a small line to `/mcp help` or `/mcp status` such as:

```text
MCP safety: risky MCP calls may require approval based on settings.approval.
```

Only do this if it stays concise and focused. Do not add panels/status values/events in Slice 8.

Focused run if changed:

```bash
bun run test tests/mcp-command.test.ts tests/mod.test.ts
```

### Step 21 — Bundle smoke

Run build and a smoke import that verifies activation can register permissions without Letta internals:

```bash
bun run build
node --input-type=module -e '
  const mod = await import("./dist/letta-mcp-adapter.mjs");
  const registered = { tools: [], commands: [], permissions: [] };
  const letta = {
    capabilities: { tools: true, commands: true, permissions: true },
    tools: { register(t) { registered.tools.push(t); return () => {}; } },
    commands: { register(c) { registered.commands.push(c); return () => {}; } },
    permissions: { register(p) { registered.permissions.push(p); return () => {}; } },
    diagnostics: { report(m) {} },
  };
  const runtime = {
    manager: {},
    loadState() { return { config: { mcpServers: {} }, warnings: [], prefix: "server", servers: new Map() }; },
    connectAndRefresh() { throw new Error("unexpected connect"); },
    callTool() { throw new Error("unexpected call"); },
    async closeAll() {},
  };
  const dispose = mod.default(letta, runtime, { activationCwd: process.cwd() });
  if (!registered.tools.find((t) => t.name === "mcp")) throw new Error("missing mcp tool");
  if (registered.permissions.length !== 1) throw new Error("missing permission registration");
  await dispose();
  console.log("slice 8 bundle smoke ok");
'
```

### Step 22 — Full verification

Run:

```bash
bun run test && bun run typecheck && bun run build
```

Expected after Slice 8: all tests pass. The total test count should increase from Slice 7's `318`.

### Step 23 — Non-goal/API audit

Before declaring Slice 8 complete, run these audits:

```bash
# No UI/events/providers/background conversation work added.
rg -n "events\.|ui\.|panels|statusValues|customStatusline|providers|runWhenBusy|conversation\.fork|sendMessageStream|tool_start" src tests docs/slice-8-permissions-plan.md

# Permissions are registered only through the actual mod permission API.
rg -n "permissions\.register|capabilities\.permissions|approvalPolicy|alwaysAsk|requiresApproval" src tests

# Permission checks must not perform live MCP/OAuth/network work.
rg -n "connectAndRefresh\(|manager\.connect\(|callTool\(|auth-start|auth-complete|loadOAuthStore|saveOAuthStore|fetch\(" src/features/permissions.ts src/mod.ts tests/permissions.test.ts
```

Expected source findings:

- `permissions.register` appears in the permission helper/mod tests and `src/mod.ts` integration only.
- No UI panels, status values, events, providers, busy commands, or background conversation work are introduced.
- `src/features/permissions.ts` does not call `connectAndRefresh`, `manager.connect`, `runtime.callTool`, OAuth store helpers, or `fetch`.
- `alwaysAsk` appears only as a permission decision/config value grounded in the actual runtime support.

## Definition of done

Slice 8 is complete when:

1. `settings.approval` is typed and normalized with safe defaults.
2. A Letta mod permission overlay is registered behind `letta.capabilities.permissions` and cleaned up by the activation disposer.
3. The overlay returns `undefined` for unrelated tools.
4. Benign `mcp` cached metadata operations return `allow`.
5. Configured live/network/OAuth operations return `ask` where appropriate.
6. Unknown/unconfigured server targets default to `deny` with a concise reason.
7. Dangerous MCP tool names and outside-cwd path arguments trigger `dangerousTools` policy.
8. Direct tools are governed by the same policy as proxy tool calls.
9. Approval/execution phase tracking allows already-approved risky calls to execute and denies risky execution without matching prior approval.
10. Permission checks never connect to MCP servers, fetch HTTP URLs, start OAuth flows, write config/cache/auth files, or import Letta internals.
11. Existing proxy, direct tool, HTTP bearer, OAuth, and command behavior remains green.
12. `bun run test && bun run typecheck && bun run build` passes.

## Non-goals for Slice 8

- No UI panels/status values/statusline changes.
- No lifecycle/tool/turn events.
- No `tool_start` transforms.
- No providers or model integrations.
- No background conversation forks or busy commands.
- No new MCP transports or OAuth features.
- No project mod support.
- No attempt to make slash commands use permission overlays; the actual API governs tool calls, not human-invoked commands.
- No broad security guarantees beyond deterministic overlay decisions for MCP adapter tool calls.

## Manual smoke checklist after implementation

1. Configure a server with cached metadata.
2. Run `/reload`.
3. Ask the agent to use `mcp({ search: "..." })`; it should proceed without extra approval when the overlay is active.
4. Ask the agent to call a dangerous-looking MCP tool such as `delete_file` or `write_file`; it should request approval or deny according to `settings.approval.dangerousTools`.
5. Ask the agent to call a benign direct tool if direct tools are enabled; it should follow the same policy.
6. Ask the agent to use a path outside the workspace through an MCP tool argument; it should require approval or deny according to policy.
7. Confirm `/mcp status`, `/mcp tools`, `/mcp reconnect`, and OAuth flows still behave as before once approved where required.
