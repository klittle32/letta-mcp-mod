# Slice 4 Plan: `/mcp` Command and Setup UX

## Status

Planned. Do not start implementation until the user explicitly asks to use this file as instructions for Slice 4.

## Grounding Sources

This plan is grounded in:

- Project spec: `docs/letta-mcp-adapter-mod-spec.md`, Slice 4 section.
- Slice 3 handoff: `docs/slice-3-proxy-tool-calls-plan.md`, “Handoff to Slice 4”.
- Current implementation after Slice 3:
  - `src/mod.ts`
  - `src/runtime.ts`
  - `src/features/proxy-tool.ts`
  - `src/core/config.ts`
  - `src/core/cache.ts`
  - `src/core/tool-names.ts`
- Actual Letta Code mods API references from the `creating-mods` skill:
  - `references/commands.md`
  - `references/architecture.md`

The relevant actual command API shape from the skill is:

```ts
letta.commands.register({
  id: "mcp",
  description: "...",
  args: "[status|tools|reconnect [server]|setup]",
  run(ctx) {
    return { type: "output", output };
  },
});
```

Important command API facts:

- Command IDs do **not** include the leading slash. Use `id: "mcp"`, not `id: "/mcp"`.
- Commands are for explicit human invocation; the model-facing MCP capability remains the existing `mcp` tool.
- Output-only local command work should return `{ type: "output", output }`.
- Do not use `prompt` for Slice 4 unless we intentionally choose an agent workflow. This slice is text-first, so prefer `output`.
- Do not use `runWhenBusy: true` unless there is a busy-safe background/fork workflow. Slice 4 should not need it.
- Guard command registration with `letta.capabilities.commands` and `letta.commands`.
- Return disposers and preserve the existing runtime cleanup pattern.
- Do not import Letta Code internals; use only the mod API and local project modules.

## Slice 4 Objective

Add a human-facing `/mcp` slash command that exposes status, cached tools, reconnect, and setup guidance for the MCP adapter mod.

The command should make it easy for the user to inspect and refresh MCP adapter state without asking the model to call the `mcp` tool manually.

Target commands from the spec:

```text
/mcp
/mcp status
/mcp tools
/mcp reconnect
/mcp reconnect <server>
/mcp setup
```

Optional explicit setup creation command for safe text-first UX:

```text
/mcp setup create
```

or:

```text
/mcp setup --write
```

Only create a starter `.mcp.json` when the user explicitly asks through one of those setup creation forms. Plain `/mcp setup` must be read-only.

## Non-goals for Slice 4

Do **not** implement these in Slice 4:

- HTTP / Streamable HTTP / SSE transports.
- Bearer auth or OAuth flows.
- Direct per-MCP-server Letta tools.
- Permission overlays.
- UI panels, status values, or statusline customization.
- Background model workflows or hidden conversation forks.
- Interactive prompts or multi-step terminal UI.
- Importing from Letta Code internals.
- Changing the model-facing compact `mcp` tool schema except for description wording if necessary.
- Starting MCP servers at mod activation time.

Slice 4 should register exactly one additional command capability: `id: "mcp"`.

## Current State Assumptions

After Slice 3, this works through the model-facing `mcp` tool:

```ts
mcp({})
mcp({ connect: "filesystem" })
mcp({ server: "filesystem" })
mcp({ search: "read" })
mcp({ describe: "filesystem_read_file" })
mcp({ tool: "filesystem_read_file", args: "{\"path\":\"README.md\"}" })
```

Existing helpers to reuse:

- `createAdapterRuntime()` from `src/runtime.ts`.
- `runtime.loadState(ctx)` for config/cache-backed proxy state.
- `runtime.connectAndRefresh(ctx, serverName)` for stdio reconnect/refresh.
- `executeMcpProxy(args, state, runtime, ctx)` from `src/features/proxy-tool.ts` for status/server/search/describe/connect behavior.
- `getConfigSources()` / `loadMcpConfig()` from `src/core/config.ts` for setup path/status reporting.

Potential current issue noticed before Slice 4:

- `src/mod.ts` tool description currently repeats “connect stdio MCP servers...” twice. This is not a blocker, but Slice 4 can clean the description while adding the command, as long as tests assert the important behavior remains.

## User-Facing Behavior Design

### `/mcp` and `/mcp status`

Read-only. Should show:

- Adapter status summary from existing proxy status behavior.
- Configured server count.
- Cached tool count.
- Per-server cache/config status.
- A short command hint block.

Suggested output shape:

```text
MCP Adapter

MCP: 2 configured servers, 5 cached tools.
Servers:
- filesystem (3 cached tools)
- github (configured, no cache)

Commands:
- /mcp tools — list cached MCP tools
- /mcp reconnect — reconnect and refresh all configured stdio servers
- /mcp reconnect <server> — reconnect and refresh one server
- /mcp setup — show config paths and starter .mcp.json
```

Implementation can reuse `executeMcpProxy({}, state)` and append command-specific help.

### `/mcp tools`

Read-only. Should list cached tools across servers.

Acceptable implementation options:

1. Use existing cached state directly and format all tools with server grouping.
2. Reuse `executeMcpProxy({ search: "" })` is **not** appropriate because empty search is invalid.
3. Reuse `executeMcpProxy({ server })` for each configured server and combine output, but direct formatting is cleaner.

Expected behavior:

- If no configured servers: explain no servers are configured and suggest `/mcp setup`.
- If configured servers exist but no cached tools: explain no cached tools and suggest `/mcp reconnect` or `/mcp reconnect <server>`.
- Include synthetic resource tools in the list, because Slice 3 exposed them via cached metadata.
- Keep output concise; schemas are not necessary for `/mcp tools`. Users can use the model-facing `mcp({ describe: "..." })` for schemas until a later command slice adds `/mcp describe`.

Suggested output shape:

```text
Cached MCP tools

fixture:
- fixture_echo — Echo a message
- fixture_list_items — List fixture items
- fixture_get_fixture_readme — Read resource: fixture://readme
```

### `/mcp reconnect`

Explicit human command. Connect/refresh all configured servers one by one, using the existing runtime. This mutates the metadata cache but does not edit config files.

Behavior:

- If no servers configured: return a short message and suggest `/mcp setup`.
- For each configured server:
  - call `runtime.connectAndRefresh(ctx, serverName)`.
  - record success with tool/resource counts.
  - catch expected errors and continue to the next server.
- Do not run all connections in parallel in Slice 4. Sequential reconnect avoids overlapping stdio process startup and keeps output deterministic.
- Keep the mod tool `parallelSafe: false`; command has no `parallelSafe` property in the reference.
- Use `ctx.signal` if present, and stop with a cancellation message if aborted.

Suggested output shape:

```text
MCP reconnect

✓ fixture: cached 5 tools, 2 resources
✗ broken: Failed to connect to "broken": ...

Refreshed 1/2 servers.
```

Plain text markers should be ASCII for portability. Use `[ok]` and `[error]` if avoiding glyphs is preferred:

```text
[ok] fixture: cached 5 tools, 2 resources
[error] broken: Failed to connect to "broken": ...
```

Because the creating-mods skill says not to use emojis for loading states, avoid emoji. These static markers are acceptable; `[ok]` / `[error]` is safest.

### `/mcp reconnect <server>`

Explicit human command. Reconnect/refresh one configured server.

Behavior:

- If server is unknown: match existing error wording from the proxy where practical:

```text
Server "missing" is not configured. Use /mcp status to list configured servers.
```

- If server is HTTP-only: preserve existing Slice 5 unsupported wording from the manager/runtime error.
- On success: show tool/resource counts and mention cache path.

Suggested output shape:

```text
MCP reconnect: fixture

Connected to "fixture" and cached 5 tools, 2 resources.
Cache: /Users/.../.letta/mcp-adapter/cache.json
```

### `/mcp setup`

Read-only. Text-first setup UX.

Should show:

- Discovered config paths.
- Which paths exist.
- Which paths loaded successfully if loading has been attempted.
- Warnings from config loading, if any.
- The recommended project-level path.
- Example `.mcp.json` content.
- Explicit instructions for creation.

Use the existing config source order from `getConfigSources()` / `loadMcpConfig()`:

1. user standard: `~/.config/mcp/mcp.json`
2. Letta global: `~/.letta/mcp-adapter/mcp.json`
3. project standard: `<cwd>/.mcp.json`
4. project Letta: `<cwd>/.letta/mcp.json`

Suggested output shape:

```text
MCP setup

Config sources, in merge order:
- [missing] user-standard: /Users/kyle/.config/mcp/mcp.json
- [missing] letta-global: /Users/kyle/.letta/mcp-adapter/mcp.json
- [exists, loaded] project-standard: /repo/.mcp.json
- [missing] project-letta: /repo/.letta/mcp.json

Recommended for this project:
/repo/.mcp.json

Example .mcp.json:
{
  "mcpServers": {
    "fixture": {
      "command": "node",
      "args": ["path/to/server.js"]
    }
  }
}

To create a starter project config, run:
/mcp setup create
```

### `/mcp setup create` or `/mcp setup --write`

Optional, but valuable for the spec’s “optionally create starter `.mcp.json` only if the user explicitly chooses/asks”.

Behavior:

- Target path: `<ctx.cwd>/.mcp.json`.
- If it already exists: do not overwrite. Return a message saying it already exists and show `/mcp setup`.
- If missing: create parent directory if needed and write a minimal valid starter config.
- Starter config should not include secrets.
- Starter config should be useful but inert/comment-free because JSON cannot contain comments.
- Use `node:fs` APIs; no shell.

Starter file:

```json
{
  "mcpServers": {
    "example": {
      "command": "node",
      "args": ["path/to/mcp-server.js"]
    }
  }
}
```

The example server will fail if used as-is, so output must tell the user to replace it before reconnecting.

Suggested output:

```text
Created starter MCP config:
/repo/.mcp.json

Edit the "example" server command/args, then run:
/mcp reconnect example
```

## Proposed Code Organization

Keep command logic separate from the model-facing proxy tool:

```text
src/features/mcp-command.ts        # new: command parsing/formatting/execution
tests/mcp-command.test.ts          # new: pure-ish command behavior tests
tests/mod-command.test.ts          # new or extend mod.test.ts for registration
```

Possible exports:

```ts
export interface McpCommandContext {
  cwd: string;
  args?: string;
  signal?: AbortSignal;
  [key: string]: unknown;
}

export interface LettaCommandDefinition {
  id: string;
  description: string;
  args?: string;
  run(ctx: McpCommandContext): Promise<{ type: "output"; output: string }> | { type: "output"; output: string };
}

export function createMcpCommand(runtime?: AdapterRuntime): LettaCommandDefinition;
export function executeMcpCommand(rawArgs: string | undefined, runtime: AdapterRuntime, ctx: McpCommandContext): Promise<string>;
```

Alternative: define `LettaCommandDefinition` in `src/mod.ts` next to existing tool type and import `createMcpCommand`. Keep all command parsing and output in `src/features/mcp-command.ts`.

Update `src/mod.ts`:

```ts
export interface LettaModApi {
  capabilities?: {
    tools?: boolean;
    commands?: boolean;
    [key: string]: unknown;
  };
  tools?: {
    register(tool: LettaToolDefinition): () => void;
  };
  commands?: {
    register(command: LettaCommandDefinition): () => void;
  };
  diagnostics?: {
    report(message: unknown): void;
  };
  [key: string]: unknown;
}

export default function activate(letta: LettaModApi, runtime: AdapterRuntime = createAdapterRuntime()) {
  const disposers: Array<() => void> = [];

  if (letta.capabilities?.tools && letta.tools) {
    disposers.push(letta.tools.register(createMcpTool(runtime)));
  }

  if (letta.capabilities?.commands && letta.commands) {
    disposers.push(letta.commands.register(createMcpCommand(runtime)));
  }

  return async () => {
    for (const dispose of disposers.reverse()) dispose();
    await runtime.closeAll();
  };
}
```

This follows the actual `creating-mods` skill pattern: register capabilities behind guards, preserve disposers, and clean up runtime on reload/shutdown.

## Command Parser Design

Input from the command API is `ctx.args`, a string from after `/mcp`.

Parser requirements:

- Treat `undefined`, empty, and whitespace-only args as `status`.
- Split on whitespace for this slice.
- Supported forms:
  - `""` -> status
  - `"status"` -> status
  - `"tools"` -> tools
  - `"reconnect"` -> reconnect all
  - `"reconnect <server>"` -> reconnect one
  - `"setup"` -> setup read-only
  - `"setup create"` -> create starter
  - `"setup --write"` -> create starter
  - `"help"` -> command help
  - `"--help"` -> command help
- Unknown subcommands return help plus an unknown-command message.
- Extra args after fixed forms should return a concise usage error.

No shell-like quoting is needed in Slice 4 because supported args are simple tokens.

Suggested internal type:

```ts
type ParsedMcpCommand =
  | { kind: "status" }
  | { kind: "tools" }
  | { kind: "reconnect"; serverName?: string }
  | { kind: "setup"; create: boolean }
  | { kind: "help" }
  | { kind: "error"; message: string };
```

## Data and Formatting Helpers

Add focused pure helpers where practical:

```ts
parseMcpCommandArgs(rawArgs: string | undefined): ParsedMcpCommand
formatCommandHelp(): string
formatStatusCommand(state: ProxyState): string
formatToolsCommand(state: ProxyState): string
formatSetupCommand(ctx, loadedConfig): string
starterMcpConfigJson(): string
```

For file writes:

```ts
createStarterProjectConfig(ctx.cwd): { ok: true; path: string } | { ok: false; message: string }
```

Use `JSON.stringify(starter, null, 2) + "\n"` for stable output.

## TDD Implementation Plan

Follow this order. Do not move to the next task until the current task’s tests and `bun run typecheck` pass.

### Step 0: Baseline and Re-grounding

1. Re-read this plan.
2. Re-read actual mod command references:

```bash
sed -n '1,280p' /Users/kyle/.local/share/mise/installs/node/24.15.0/lib/node_modules/@letta-ai/letta-code/skills/creating-mods/references/commands.md
sed -n '1,240p' /Users/kyle/.local/share/mise/installs/node/24.15.0/lib/node_modules/@letta-ai/letta-code/skills/creating-mods/references/architecture.md
```

3. Inspect current code:

```bash
sed -n '1,220p' src/mod.ts
sed -n '1,260p' src/runtime.ts
sed -n '1,280p' src/features/proxy-tool.ts
sed -n '1,240p' src/core/config.ts
```

4. Run baseline:

```bash
bun run test
bun run typecheck
bun run build
```

Expected baseline after Slice 3:

- 14 test files pass.
- 141 tests pass.
- Typecheck passes.
- Build passes.

### Step 1: Command Argument Parser Tests and Implementation

Create `tests/mcp-command.test.ts` with parser tests first.

Test cases:

1. `undefined`, `""`, and whitespace parse to status.
2. `"status"` parses to status.
3. `"tools"` parses to tools.
4. `"reconnect"` parses to reconnect all.
5. `"reconnect fixture"` parses to reconnect one server.
6. `"setup"` parses to setup read-only.
7. `"setup create"` and `"setup --write"` parse to setup create.
8. `"help"` and `"--help"` parse to help.
9. Unknown command returns an error with usage/help hint.
10. Too many args for fixed commands return a concise error.

Implementation:

- Add `src/features/mcp-command.ts`.
- Implement `parseMcpCommandArgs` and `formatCommandHelp`.

Run:

```bash
bun run test tests/mcp-command.test.ts
bun run typecheck
```

### Step 2: Command Status and Tools Formatting Tests

Extend `tests/mcp-command.test.ts` or add focused tests for formatting.

Build test `ProxyState` using existing `createProxyState`, `updateServerCache`, and fixture-like cache objects.

Test status:

1. Empty state includes `MCP Adapter` and `0 configured servers`.
2. Status includes command hints for `/mcp tools`, `/mcp reconnect`, and `/mcp setup`.
3. Status preserves warnings from config/cache state if present.

Test tools:

1. No configured servers suggests `/mcp setup`.
2. Configured server with no cache suggests `/mcp reconnect`.
3. Cached tools are grouped by server.
4. Resource-backed synthetic tools are included.
5. Tool output does not include full JSON schemas.

Implementation:

- Implement `formatStatusCommand(state)` by reusing `executeMcpProxy({}, state)` plus a command help/hint block.
- Implement `formatToolsCommand(state)` by iterating `state.servers` and their `tools`.
- Keep output deterministic by sorting server names or preserving config insertion order consistently. Prefer preserving `state.servers` order because config merge order already defines it; tests should avoid relying on cross-object ambiguity unless explicit.

Run:

```bash
bun run test tests/mcp-command.test.ts
bun run typecheck
```

### Step 3: Setup Read-Only Formatting Tests

Add tests for setup output.

Use temporary `home` and `cwd`; write config files as needed.

Test cases:

1. With no config files, `/mcp setup` lists all four known source paths as missing.
2. With project `.mcp.json`, setup marks it `[exists, loaded]`.
3. Invalid JSON warnings are included but output remains helpful.
4. Output includes recommended project path `<cwd>/.mcp.json`.
5. Output includes example `.mcp.json` JSON.
6. Plain setup does not create any file.

Implementation:

- Use `loadMcpConfig({ cwd, home, env })` to obtain `sources` and `warnings`.
- Format source statuses with source `kind`, `path`, `exists`, and `loaded`.
- Include stable example JSON from `starterMcpConfigJson()`.

Run:

```bash
bun run test tests/mcp-command.test.ts
bun run typecheck
```

### Step 4: Setup Create Tests and Implementation

Add tests for explicit creation.

Test cases:

1. `/mcp setup create` creates `<cwd>/.mcp.json` when missing.
2. `/mcp setup --write` also creates it when missing.
3. Created JSON parses and has `mcpServers.example.command === "node"`.
4. Existing `.mcp.json` is not overwritten.
5. Output tells user to edit the example server before reconnecting.
6. Plain `/mcp setup` still does not create a file.

Implementation details:

- Use `existsSync`, `mkdirSync`, and `writeFileSync` from Node APIs.
- Write only under `ctx.cwd`, specifically `join(ctx.cwd, ".mcp.json")`.
- Do not use shell commands.
- Do not overwrite existing file.

Run:

```bash
bun run test tests/mcp-command.test.ts
bun run typecheck
```

### Step 5: Reconnect Command Tests and Implementation

Add reconnect tests. Use the existing stdio fixture.

Test cases:

1. `/mcp reconnect fixture` connects to fixture and reports cached `5 tools, 2 resources`.
2. After reconnect, cache is saved; a subsequent runtime load/search sees `fixture_echo`.
3. Unknown server returns a concise unknown-server message.
4. HTTP-only server returns the existing unsupported HTTP/Slice 5 message.
5. Broken server returns concise failure and does not prevent status afterwards.
6. `/mcp reconnect` with multiple configured servers reconnects sequentially and reports per-server results.
7. `/mcp reconnect` with one success and one failure reports `Refreshed 1/2 servers`.
8. No configured servers suggests `/mcp setup`.
9. Already aborted signal returns cancellation and avoids work, if command ctx exposes `signal` in tests.

Implementation:

- Add `executeReconnectCommand(runtime, ctx, state, serverName?)`.
- For all-server reconnect, iterate `state.servers.keys()` sequentially.
- For one-server reconnect, validate `state.servers.has(serverName)` before calling runtime.
- Use `runtime.connectAndRefresh(ctx, serverName)`.
- Catch errors per server and return text, not thrown exceptions, for expected connection failures.
- Preserve runtime’s existing error strings for unsupported transports.

Run:

```bash
bun run test tests/mcp-command.test.ts
bun run typecheck
```

### Step 6: Command Integration Tests Without Letta Harness

Implement `createMcpCommand(runtime)` and `executeMcpCommand(...)` tests.

Test cases:

1. `createMcpCommand().id === "mcp"`.
2. Command description mentions MCP and setup/reconnect/tools.
3. `args` string documents supported forms.
4. `run(ctx)` returns `{ type: "output", output: string }`.
5. `run({ cwd, args: "status" })` calls runtime/state path and returns status.
6. `run({ cwd, args: "tools" })` returns cached tools output.
7. `run({ cwd, args: "setup" })` returns setup output.
8. `run({ cwd, args: "reconnect fixture" })` uses runtime reconnect and returns success.

Implementation:

- `createMcpCommand(runtime = createAdapterRuntime())` returns a command object.
- `run(ctx)` should call `executeMcpCommand(ctx.args, runtime, ctx)` and wrap it:

```ts
return { type: "output", output };
```

- If `ctx.signal?.aborted`, return `{ type: "output", output: "MCP command cancelled." }` or similar.

Run:

```bash
bun run test tests/mcp-command.test.ts
bun run typecheck
```

### Step 7: Mod Registration Tests

Extend `tests/mod.test.ts` or add `tests/mod-command.test.ts`.

Current fake Letta API has tools only. Extend it to optionally include commands.

Test cases:

1. When `capabilities.commands` is false/missing, no command is registered.
2. When `capabilities.commands` is true and `commands.register` exists, exactly one command is registered with `id: "mcp"`.
3. Tool registration still works exactly as before when tools are available.
4. Both tool and command can register in the same activation.
5. Disposer calls both command and tool disposers in reverse registration order if practical to assert.
6. Runtime `closeAll` is called once on dispose.
7. Activation remains idle: registering command does not call `runtime.loadState` or `runtime.connectAndRefresh`.
8. `createMcpTool` still has `requiresApproval: true`, `parallelSafe: false`, and object schema with `additionalProperties: false`.
9. Command registration does not add tool approval fields, permission overlays, or UI dependencies.

Implementation:

- Add command interfaces to `src/mod.ts`.
- Import `createMcpCommand` from `src/features/mcp-command.ts`.
- Guard with `letta.capabilities?.commands && letta.commands`.
- Push command disposer into the shared disposers array.
- Keep existing tool behavior intact.

Run:

```bash
bun run test tests/mod.test.ts tests/mcp-command.test.ts
bun run typecheck
```

### Step 8: Update Bundle Smoke Test Pattern

The existing final smoke registers tools only. Add a command registration smoke to the final verification and, if appropriate, a test.

Smoke script shape:

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
  commandArgs: commands[0]?.args,
}));
await dispose?.();
NODE
```

Expected:

```json
{"tools":["mcp"],"commands":["mcp"],"toolRequiresApproval":true,"toolParallelSafe":false,...}
```

### Step 9: Full Verification

Run:

```bash
bun run test
bun run typecheck
bun run build
```

Then run bundle smoke with both tool and command registration.

Optionally run a command behavior smoke directly against the built bundle:

```bash
node --input-type=module <<'NODE'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import activate from './dist/letta-mcp-adapter.mjs';

const root = mkdtempSync(join(tmpdir(), 'letta-mcp-command-smoke-'));
const home = join(root, 'home');
const cwd = join(root, 'workspace');
mkdirSync(cwd, { recursive: true });
process.env.HOME = home;

const commands = [];
const dispose = activate({
  capabilities: { commands: true },
  commands: { register(command) { commands.push(command); return () => {}; } },
});

const result = await commands[0].run({ cwd, args: 'setup' });
console.log(result.type);
console.log(result.output.includes('MCP setup'));
await dispose?.();
NODE
```

Expected output includes:

```text
output
true
```

## Acceptance Criteria

Slice 4 is complete when all of these are true:

- `letta.commands.register({ id: "mcp", ... })` is implemented behind a capabilities guard.
- The existing model-facing `mcp` tool still registers and behaves as before.
- `/mcp` returns status output.
- `/mcp status` returns status output.
- `/mcp tools` lists cached MCP tools and resources, or gives helpful no-cache guidance.
- `/mcp reconnect <server>` reconnects/refreshes one stdio server through existing runtime code.
- `/mcp reconnect` reconnects/refreshes all configured servers sequentially and reports per-server results.
- Reconnect failure for one server does not crash the command or prevent reporting other servers.
- `/mcp setup` lists discovered config paths and existence/loaded status.
- `/mcp setup` includes an example `.mcp.json`.
- `/mcp setup` is read-only.
- `/mcp setup create` and/or `/mcp setup --write` creates a starter project `.mcp.json` only when missing and only when explicitly invoked.
- Existing `.mcp.json` is not overwritten.
- Command handlers return `{ type: "output", output }` for Slice 4.
- No command handler returns `{ type: "prompt" }` in Slice 4.
- No `runWhenBusy: true` workflow is added in Slice 4.
- No UI panel/status/statusline code is added.
- No permission overlay code is added.
- No HTTP/SSE/Streamable transport implementation is added.
- No bearer/OAuth implementation is added.
- No direct per-server tools are registered.
- Activation remains idle: no config load, MCP connect, or file writes during mod activation.
- Runtime cleanup still closes MCP clients/transports on dispose.
- Full tests pass.
- Typecheck passes.
- Build passes.
- Bundle smoke confirms both `mcp` tool and `/mcp` command register.

## Explicit Non-goal Audit Before Declaring Done

Before marking Slice 4 complete, inspect the source for accidental out-of-scope additions:

```bash
rg -n "ui\.|panels|statusValues|customStatusline|permissions|approvalPolicy|Streamable|SSE|OAuth|bearer|directTools|runWhenBusy|type: \"prompt\"|conversation\.fork|sendMessageStream" src tests docs/slice-4-command-setup-ux-plan.md
```

Expected:

- No UI panel/status/statusline implementation.
- No permission overlay implementation.
- No HTTP/SSE/Streamable transport implementation.
- No OAuth/bearer auth implementation beyond pre-existing config/cache data model references.
- No direct MCP server tool registration.
- No `runWhenBusy` command workflow.
- No prompt-returning command workflow.
- No background model/forked conversation workflow.

Also confirm command registration is the only new mod API capability:

```bash
rg -n "commands\.register|tools\.register|events\.|providers|permissions|ui\." src tests
```

Expected:

- Existing `tools.register` for the compact `mcp` tool.
- New `commands.register` for the `/mcp` command.
- No other new mod capability registrations.

## Handoff to Slice 5

After Slice 4, users should have:

- Model-facing compact proxy tool:

```ts
mcp({ tool: "filesystem_read_file", args: "{\"path\":\"README.md\"}" })
```

- Human-facing slash command:

```text
/mcp
/mcp status
/mcp tools
/mcp reconnect
/mcp reconnect filesystem
/mcp setup
/mcp setup create
```

Slice 5 should then add HTTP MCP servers and bearer auth, still grounded in actual MCP SDK transports and Letta Code mod API constraints. Do not start Slice 5 until Slice 4 is green and reviewed.
