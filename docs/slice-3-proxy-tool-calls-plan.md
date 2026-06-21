# Slice 3 Plan: Proxy MCP Tool Calls and Resource Reads

## Purpose

Implement the third vertical slice of the Letta MCP Adapter mod: make the compact `mcp` proxy actually call MCP tools through an explicitly configured/lazily connected MCP server while keeping the model context small.

Slice 1 provided cache-backed status/list/search/describe. Slice 2 added lazy stdio connect, metadata discovery, metadata cache writes, and runtime cleanup. Slice 3 should preserve all Slice 1/2 behavior and add useful MVP tool execution:

```ts
mcp({
  tool: "fixture_echo",
  args: "{\"message\":\"hello\"}"
})
```

It should also support synthetic resource tools generated from cached resources:

```ts
mcp({ tool: "fixture_get_fixture_readme", args: "{}" })
```

This slice is still proxy-first. It does **not** register every MCP tool as a separate Letta tool. Direct tools remain a later slice.

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

  if (letta.capabilities?.tools && letta.tools) {
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

### Important Letta API decision for Slice 3

Keep the Slice 2 safety flags:

```ts
requiresApproval: true
parallelSafe: false
```

Rationale:

- MCP tool calls can mutate local/remote state depending on the underlying server.
- Calls may spawn/connect local stdio processes as part of lazy connection.
- Calls share long-lived manager/runtime state.
- Fine-grained approval policy remains out of scope until the permission-overlay slice.

Constraints from the actual mod API and skill:

- Guard optional APIs with `letta.capabilities.*`.
- Use `letta.tools.register` only when `letta.capabilities.tools` is true.
- Tool parameters must remain a JSON Schema object with `additionalProperties: false`.
- Keep `args` as a JSON string to avoid dumping per-MCP-tool schemas into Letta context.
- Use `ctx.cwd` as the invocation workspace.
- Use callback context (`ctx`) rather than global app context.
- Respect `ctx.signal` for long-running connect/call/read operations where practical.
- Do not import Letta Code internals.
- Do not connect to MCP servers during mod activation.
- Return cleanup disposers from activation.
- Cleanup must close MCP clients/transports and child processes on reload/shutdown.
- Keep output concise and actionable.
- Tools should return information for the model; do not start hidden model runs from the tool.

## Slice 3 Scope

### In scope

- Implement `mcp({ tool, args })` for cached MCP tools.
- Keep `args` as a JSON string and parse it into a JSON object before calling MCP.
- Validate:
  - `tool` is non-empty
  - `args` is valid JSON if provided
  - parsed `args` is a non-array object
  - requested tool exists in cached metadata after lazy refresh attempts
  - target server exists and is supported by Slice 2 stdio manager
- Resolve the requested tool to:
  - server name
  - original MCP tool name
  - cached `ToolMetadata`
  - resource URI for synthetic resource tools
- Lazy connect on tool calls when needed:
  - if valid cache already identifies the tool, connect/reuse that server and call
  - if no valid cache identifies it but `server` or a server-prefixed name identifies a configured server, connect/refresh that server and re-resolve
  - if still unresolved, return a concise search/connect hint
- Call real MCP tools through the SDK client with `client.callTool({ name, arguments })`.
- Read synthetic resource tools through `client.readResource({ uri })`.
- Render MCP call/read results into Letta-friendly text.
- Preserve MCP `isError` as a clear error-looking result without crashing the mod.
- Preserve Slice 1/2 behavior for status/list/search/describe/connect.
- Add tests for args parsing, tool resolution, lazy connect, real tool calls, resource reads, result rendering, error handling, cancellation, and cleanup.
- Keep build output bundled to `dist/letta-mcp-adapter.mjs`.

### Out of scope

- Direct Letta tool registration for each MCP tool.
- Slash commands.
- Permission overlays / fine-grained approval policies.
- HTTP MCP transport.
- SSE/Streamable HTTP.
- Bearer auth.
- OAuth.
- UI panels/status values.
- Sampling/elicitation.
- MCP UI/Glimpse rendering beyond preserving metadata and returning concise text.
- Binary download/file persistence for image/audio/blob results.
- Full JSON Schema validation of MCP input schemas before calling. The MCP server/client can validate; this slice only validates the proxy JSON string and object shape.
- Tool result pagination/streaming/task support beyond ordinary `client.callTool` responses.
- Keep-alive/eager lifecycle modes.
- Idle disconnect timers.

Do not sneak these into Slice 3.

## Expected User-facing Behavior

### Call with invalid args JSON

```ts
mcp({ tool: "fixture_echo", args: "not json" })
```

returns:

```text
Invalid args JSON for "fixture_echo": expected a JSON object string, e.g. {"key":"value"}.
Parse error: <short parser message>
```

### Call with non-object args

```ts
mcp({ tool: "fixture_echo", args: "[]" })
```

returns:

```text
Invalid args for "fixture_echo": args must parse to a JSON object, not an array.
```

### Unknown tool with no cache hint

```ts
mcp({ tool: "read_file", args: "{}" })
```

when no server can be inferred returns:

```text
Tool "read_file" was not found in cached MCP metadata. Use mcp({ search: "read_file" }) or mcp({ connect: "server" }) first.
```

### Unknown tool with server hint

```ts
mcp({ server: "fixture", tool: "fixture_echo", args: "{\"message\":\"hi\"}" })
```

If `fixture` is configured but has no cache yet, Slice 3 should connect/refresh `fixture`, re-resolve the tool, and then call it.

### Server-prefixed tool lazy-connects

```ts
mcp({ tool: "fixture_echo", args: "{\"message\":\"hi\"}" })
```

If `fixture` is configured and the tool prefix setting is `server`, but there is no cache yet, Slice 3 should infer `fixture` from `fixture_echo`, connect/refresh `fixture`, re-resolve the tool, and then call it.

### Successful text result

```ts
mcp({ tool: "fixture_echo", args: "{\"message\":\"hello\"}" })
```

returns something like:

```text
Called "fixture_echo" on "fixture".

hello
```

### Structured content result

If an MCP server returns `structuredContent`, include a bounded JSON rendering after content text:

```text
Called "fixture_get_status" on "fixture".

Status: ok

Structured content:
{
  "ok": true
}
```

Large structured content should be truncated with a note.

### MCP error result

If `client.callTool` returns `{ isError: true, content: [...] }`, do not throw away the content. Return:

```text
MCP tool "fixture_fail" on "fixture" returned an error.

<rendered MCP content>
```

### Thrown call error

If the SDK call rejects:

```text
Failed to call MCP tool "fixture_fail" on "fixture": <short actionable message>
```

Status/search/describe should continue to work after a failed call.

### Synthetic resource read

For a cached resource synthetic tool such as `fixture_get_fixture_readme`:

```ts
mcp({ tool: "fixture_get_fixture_readme", args: "{}" })
```

returns:

```text
Read resource "fixture://readme" from "fixture".

Fixture README content
```

If the resource returns blobs/binary data, return metadata/placeholder only:

```text
Read resource "fixture://image" from "fixture".

[blob content: image/png, 128 bytes base64]
```

## Proposed Repository Structure After Slice 3

```text
src/
  mod.ts
  runtime.ts
  core/
    args.ts                 # new: parse/validate proxy args JSON string
    cache.ts
    config.ts
    result-renderer.ts      # new: render MCP call/read results
    schema-format.ts
    tool-names.ts
  features/
    proxy-tool.ts
  mcp/
    calls.ts                # new: callTool/readResource wrappers and target types
    manager.ts
    metadata.ts
    stdio.ts

tests/
  args.test.ts              # new
  cache.test.ts
  config.test.ts
  manager-stdio.test.ts
  mod.test.ts
  proxy-connect.test.ts
  proxy-tool-call.test.ts   # new
  proxy-tool.test.ts
  result-renderer.test.ts   # new
  runtime.test.ts
  schema-format.test.ts
  tool-names.test.ts
  fixtures/
    stdio-mcp-fixture.mjs   # extend with tool-call/error/structured/blob cases
    broken-server.mjs
    slow-server.mjs
```

File names can vary if the implementation stays cohesive, but keep parsing/rendering/call logic separated enough to test without spawning MCP servers.

## Data and Type Design

### Parsed proxy args

Add a small parser that treats missing `args` as `{}` and rejects invalid shapes:

```ts
export interface ParseArgsResult {
  ok: true;
  value: Record<string, unknown>;
} | {
  ok: false;
  message: string;
}

export function parseProxyArgs(raw: string | undefined, toolName: string): ParseArgsResult;
```

Rules:

- `undefined`, `""`, and whitespace-only strings parse to `{}`.
- Valid JSON object parses to that object.
- Arrays, strings, numbers, booleans, and null are invalid.
- Error messages include the requested tool name and an example object string.
- Do not validate against per-tool input schema in Slice 3.

### Tool target resolution

Add a target resolution helper that works from `ProxyState` and optional lazy refresh:

```ts
export interface ToolTarget {
  serverName: string;
  requestedName: string;
  exposedName: string;
  originalName: string;
  metadata: ToolMetadata;
  isResource: boolean;
  resourceUri?: string;
}
```

Resolution order:

1. If `args.server` is present, only search that configured server.
2. Search valid cached metadata for an exact exposed-name or original-name match using existing `findToolByName` semantics.
3. If no match and a server hint exists:
   - explicit `args.server`, or
   - parse server prefix from `tool` when `toolPrefix === "server"` and a configured server name matches the prefix,
   then call `runtime.connectAndRefresh(ctx, serverName)` and re-search that server.
4. If no match and exactly one configured server exists, optionally connect/refresh it only when the requested name is unprefixed or could plausibly belong to that server. Keep this conservative to avoid surprising process launches.
5. If multiple matches are possible after refresh, return an ambiguity message listing the candidate exposed names.
6. If still no match, return an unknown-tool message with `search` and `connect` hints.

Important: tool calls should not connect every configured server just to search. Connect only a directly hinted server or the single-server conservative case.

### Runtime call API

Extend `AdapterRuntime` with a call method while preserving `loadState`, `connectAndRefresh`, and `closeAll`:

```ts
export interface CallToolResult {
  target: ToolTarget;
  output: string;
  isError: boolean;
}

export interface AdapterRuntime {
  manager: McpServerManager;
  loadState(ctx: RuntimeToolContext): ProxyState;
  connectAndRefresh(ctx: RuntimeToolContext, serverName: string): Promise<ConnectRefreshResult>;
  callTool(ctx: RuntimeToolContext, state: ProxyState, toolName: string, rawArgs: string | undefined): Promise<CallToolResult>;
  closeAll(): Promise<void>;
}
```

Runtime `callTool` should:

1. Parse args.
2. Resolve target, possibly calling `connectAndRefresh` for a hinted server.
3. Ensure there is an MCP connection for target server, reusing `McpServerManager`.
4. If `target.isResource`, call/read resource through the SDK client.
5. Otherwise call `client.callTool({ name: target.originalName, arguments: parsedArgs }, undefined, { signal, timeout })`.
6. Render the result to a bounded string.
7. Return a result object for `features/proxy-tool.ts` to format.

### MCP SDK call surface

Use the actual installed SDK APIs already confirmed in Slice 2:

```ts
await client.callTool(
  { name: target.originalName, arguments: parsedArgs },
  undefined,
  { signal: ctx.signal, timeout: timeoutMs },
);

await client.readResource(
  { uri: target.resourceUri },
  { signal: ctx.signal, timeout: timeoutMs },
);
```

Do not import Letta internals or use hidden conversation/model work.

## Result Rendering Plan

Create `src/core/result-renderer.ts` with focused functions:

```ts
export interface RenderOptions {
  maxTextChars?: number;
  maxJsonChars?: number;
}

export function renderCallToolResult(result: unknown, options?: RenderOptions): { text: string; isError: boolean };
export function renderReadResourceResult(result: unknown, options?: RenderOptions): string;
```

Rendering rules:

### Tool content blocks

- `type: "text"`: include `text` directly.
- `type: "image"`: include placeholder with MIME type and base64 length, not raw base64 by default.
- `type: "audio"`: include placeholder with MIME type and base64 length, not raw base64 by default.
- `type: "resource"`: render embedded resource contents using resource rules.
- `type: "resource_link"`: render URI/name/mime metadata.
- Unknown content block: render bounded JSON.

### Read-resource contents

- Text content: include text with optional URI/mime heading when multiple contents exist.
- Blob content: placeholder with URI, MIME type, and base64 length.
- Multiple contents: render each in order separated by blank lines.

### Structured content

- If `structuredContent` exists on a call result, append bounded pretty JSON under `Structured content:`.
- If content is empty but structured content exists, still return useful structured content.

### Truncation

- Default max text output: choose a conservative bound such as 20,000 characters.
- Default max JSON output: choose a conservative bound such as 8,000 characters.
- Truncation note should say how many characters were omitted when possible.
- Do not dump raw large base64 into model context.

### Error semantics

- `renderCallToolResult` returns `isError: true` when the MCP result has `isError === true`.
- SDK thrown errors are handled by caller and rendered as `Failed to call...`.

## Proxy Dispatcher Changes

Current precedence is:

```ts
if (args.action) ...
if (args.tool) ...
if (args.connect) ...
if (args.describe) ...
if (args.search !== undefined) ...
if (args.server) ...
status
```

Keep the same precedence. Replace the Slice 2 `executeUnsupportedToolCall` branch with an async call path when `runtime` and `ctx` are available:

```ts
if (args.tool) {
  if (!runtime || !ctx) return executeToolCallUnavailable(args.tool);
  return executeToolCall(runtime, ctx, state, args.tool, args.args);
}
```

Important behavior:

- `action` still wins over `tool` and remains unsupported until a later auth/UI slice.
- `tool` wins over `connect`, `describe`, `search`, and `server`.
- `server` can still act as a hint for tool resolution when `tool` is present.
- Non-runtime unit tests may still use synchronous `executeMcpProxy` for status/list/search/describe.

## Fixture Server Plan

Extend `tests/fixtures/stdio-mcp-fixture.mjs` with deterministic call cases:

Tools:

1. `echo`
   - input: `{ message: string }`
   - result: text block containing the message
2. `list_items`
   - input: `{}`
   - result: text block with `alpha`, `beta`, `gamma`
3. `structured_status`
   - input: `{}`
   - result: text block plus `structuredContent: { ok: true, source: "fixture" }`
4. `fail_soft`
   - input: `{ message?: string }`
   - result: `{ isError: true, content: [{ type: "text", text: "fixture failure" }] }`
5. `throw_error`
   - input: `{}`
   - handler throws `Error("fixture thrown failure")`
6. Optional `mixed_content`
   - returns text plus image/audio/resource-link placeholders if straightforward with SDK schemas

Resources:

1. `fixture://readme`
   - text content: `Fixture README content`
2. Optional `fixture://blob`
   - blob content with small base64 string and MIME type

Keep fixture behavior simple and deterministic.

## TDD Implementation Plan

Work through these steps in order. Do not move to the next implementation step until the focused tests for the current step pass.

### Step 0: Baseline and API re-grounding

1. Re-read this plan, `creating-mods/references/tools.md`, and `creating-mods/references/architecture.md`.
2. Inspect current code in:
   - `src/mod.ts`
   - `src/runtime.ts`
   - `src/features/proxy-tool.ts`
   - `src/mcp/manager.ts`
   - `src/mcp/metadata.ts`
   - `src/core/tool-names.ts`
3. Run baseline:

```bash
bun run test
bun run typecheck
bun run build
```

Expected baseline at the time this plan was written:

```text
9 test files, 88 tests passing
```

### Step 1: Args parser tests and implementation

Add `tests/args.test.ts` first.

Test cases:

1. `undefined` args returns `{}`.
2. Empty/whitespace args returns `{}`.
3. Valid object string returns object.
4. Nested object/array values inside an object are allowed.
5. Invalid JSON returns helpful message with tool name and parser summary.
6. Array JSON is rejected.
7. `null` is rejected.
8. String/number/boolean JSON values are rejected.

Then implement `src/core/args.ts`.

Verification gate:

```bash
bun run test tests/args.test.ts
bun run typecheck
```

### Step 2: Result renderer tests and implementation

Add `tests/result-renderer.test.ts` first.

Test cases:

1. Text-only tool result renders text.
2. Multiple text blocks are separated by blank lines.
3. `isError: true` is preserved in renderer return.
4. Structured content is appended as pretty JSON.
5. Empty content plus structured content still renders useful output.
6. Image/audio blocks render placeholders and omit raw base64.
7. Embedded resource text renders text.
8. Resource link renders URI/name metadata.
9. Read-resource text contents render text.
10. Read-resource blob contents render bounded placeholder.
11. Long text is truncated with a note.
12. Long JSON is truncated with a note.
13. Unknown blocks render bounded JSON instead of throwing.

Then implement `src/core/result-renderer.ts`.

Verification gate:

```bash
bun run test tests/result-renderer.test.ts
bun run typecheck
```

### Step 3: Extend fixture server for call cases

Update `tests/fixtures/stdio-mcp-fixture.mjs`.

Add tests to `tests/manager-stdio.test.ts` or a new fixture-focused test that uses the SDK manager directly to ensure:

1. `client.callTool({ name: "echo", arguments: { message: "hello" } })` returns `hello`.
2. `client.callTool({ name: "structured_status", arguments: {} })` returns structured content.
3. `client.callTool({ name: "fail_soft", arguments: {} })` returns `isError: true`.
4. `client.readResource({ uri: "fixture://readme" })` returns `Fixture README content`.

Verification gate:

```bash
bun run test tests/manager-stdio.test.ts
bun run typecheck
```

### Step 4: Tool target resolution tests and implementation

Add focused tests, either in `tests/runtime.test.ts` or a new `tests/tool-resolution.test.ts`.

Test cases:

1. Finds cached exposed name `fixture_echo`.
2. Finds cached original name `echo` when unambiguous.
3. Honors `server` hint and does not search other servers.
4. Reports unknown server hint.
5. Reports unknown tool with search/connect hint.
6. Identifies synthetic resource target from `resourceUri`.
7. Infers server prefix from `fixture_echo` when `fixture` is configured and `toolPrefix === "server"`.
8. Does not connect every configured server for an unhinted unknown tool.
9. Reports ambiguity if original name appears in multiple cached servers.

Implementation can live in `src/mcp/calls.ts` or a small resolver module imported by runtime.

Verification gate:

```bash
bun run test tests/tool-resolution.test.ts
bun run typecheck
```

### Step 5: Runtime `callTool` tests and implementation

Add runtime-level tests using the stdio fixture.

Test cases:

1. With valid cache, `runtime.callTool(..., "fixture_echo", "{\"message\":\"hello\"}")` connects/reuses fixture and returns rendered `hello`.
2. With no cache but server-prefixed tool name, runtime lazy-connects, refreshes metadata, and calls the tool.
3. With explicit `server: "fixture"` hint and no cache, runtime lazy-connects and calls the tool.
4. Failed args parse returns parser error and does not connect.
5. Unknown tool returns unknown-tool message and does not leak a connection.
6. `fail_soft` returns `isError: true` and rendered content.
7. `throw_error` returns or throws a concise failure that proxy can render.
8. Synthetic resource tool calls `readResource`, not `callTool`, and returns resource text.
9. `ctx.signal` already aborted returns a cancellation/abort message and avoids work where possible.
10. `closeAll` still closes connections after calls.

Implementation details:

- Extend `AdapterRuntime` with `callTool`.
- Use `connectAndRefresh` for lazy refresh paths, but avoid duplicate metadata writes when cache is already valid and only a connection is needed.
- Reuse `McpServerManager.connect` for connection reuse.
- Use SDK request options `{ signal: ctx.signal, timeout: timeoutMs }`.
- Convert expected thrown errors into concise messages at the proxy boundary.

Verification gate:

```bash
bun run test tests/runtime.test.ts tests/proxy-tool-call.test.ts
bun run typecheck
```

### Step 6: Proxy dispatcher tests and implementation

Add `tests/proxy-tool-call.test.ts`.

Test cases:

1. `mcp({ tool: "fixture_echo", args: "{\"message\":\"hi\"}" })` returns `Called "fixture_echo" on "fixture"` and `hi`.
2. `tool` branch has precedence over `connect`, `describe`, `search`, and `server`.
3. `action` still has precedence over `tool` and remains unsupported.
4. `mcp({ tool: "fixture_echo", args: "not json" })` returns invalid args message.
5. `mcp({ tool: "fixture_fail_soft", args: "{}" })` returns MCP error result text.
6. `mcp({ tool: "fixture_throw_error", args: "{}" })` returns failed call message.
7. `mcp({ tool: "fixture_get_fixture_readme", args: "{}" })` returns resource text.
8. Calling a tool refreshes cache when needed, and subsequent `search/describe/server` sees the updated metadata.
9. Calling an unknown tool gives search/connect guidance.
10. Calling an HTTP-only server-hinted tool still returns the Slice 5 unsupported message.
11. Calling without runtime returns runtime-required message for low-level unit compatibility.

Implementation details:

- Replace `executeUnsupportedToolCall` with `executeToolCall` when runtime/ctx are available.
- Keep the unsupported/runtime-required helper only for direct unit calls without runtime.
- Format output in `features/proxy-tool.ts`, not in the Letta mod activation layer.

Verification gate:

```bash
bun run test tests/proxy-tool-call.test.ts tests/proxy-tool.test.ts tests/proxy-connect.test.ts
bun run typecheck
```

### Step 7: Mod registration regression tests

Update `tests/mod.test.ts` only if needed.

Assertions to preserve:

1. `mcp` remains the only registered tool.
2. Parameters remain one compact object schema with `additionalProperties: false`.
3. `requiresApproval === true`.
4. `parallelSafe === false`.
5. `run(ctx)` uses `ctx.cwd`, `ctx.args`, and `ctx.signal` through runtime.
6. Activation does not connect on startup.
7. Disposer closes runtime.

Verification gate:

```bash
bun run test tests/mod.test.ts
bun run typecheck
```

### Step 8: Full verification and bundle smoke

Run:

```bash
bun run test
bun run typecheck
bun run build
```

Then smoke-test the bundled mod import and registration:

```bash
node --input-type=module <<'EOF'
import activate from './dist/letta-mcp-adapter.mjs';
const registered = [];
const dispose = activate({
  capabilities: { tools: true },
  tools: { register(tool) { registered.push(tool); return () => {}; } },
});
if (registered.length !== 1 || registered[0].name !== 'mcp') throw new Error('mcp tool not registered');
console.log(JSON.stringify({
  registered: registered.map((tool) => tool.name),
  requiresApproval: registered[0].requiresApproval,
  parallelSafe: registered[0].parallelSafe,
}));
await dispose?.();
EOF
```

Expected smoke output shape:

```json
{"registered":["mcp"],"requiresApproval":true,"parallelSafe":false}
```

## Error Handling Requirements

Keep errors short and actionable.

Expected handled errors:

- Invalid JSON args.
- Parsed args is not an object.
- Missing/unknown server hint.
- Unknown tool.
- Ambiguous tool.
- Unsupported HTTP-only server.
- Broken stdio server connect.
- MCP tool returned `isError: true`.
- MCP call/read threw an SDK error.
- Request cancelled through `ctx.signal`.

Do not let these crash status/search/describe. Unexpected programming errors may still throw during tests, but user-facing proxy calls should return concise messages for expected runtime failures.

## Cache and Connection Semantics

- Tool calls may lazily connect a single hinted server.
- Tool calls should not connect every configured server just to discover a tool.
- If a tool target is found in valid cache, calling it should connect/reuse that server but does not need to refresh metadata first.
- If no valid cache exists but the server is directly hinted, connect/refresh first, then call.
- If stale cache contains a target, prefer refreshing the hinted server before call so original tool metadata is current.
- A successful lazy refresh should persist cache just like `mcp({ connect })`.
- Failed calls should not corrupt cache.
- Manager connection reuse and `closeAll` behavior from Slice 2 must remain intact.

## Security and Approval Notes

- Keep `requiresApproval: true` for the proxy tool in Slice 3.
- Keep `parallelSafe: false`.
- Do not add permission overlays in Slice 3.
- Do not infer or whitelist safe MCP tools yet; a filesystem read can still expose sensitive files, and other MCP servers may mutate state.
- Do not include raw base64 image/audio/blob payloads in output by default.
- Do not store secrets or call remote auth flows.

## Documentation Updates

Update docs only if implementation behavior diverges from this plan. At minimum, after implementation consider adding a brief Slice 3 completion note to this file or a changelog-style section if the user asks.

Do not rewrite the project spec unless the implementation discovers a durable design change that affects future slices.

## Completion Checklist

Slice 3 is complete only when all of the following are true:

- `mcp({ tool, args })` calls real MCP tools through the proxy.
- `args` remains a JSON string in the Letta tool schema.
- Invalid args JSON and non-object args produce helpful messages.
- Tool resolution works from cached metadata.
- Tool calls can lazy-connect/refresh a directly hinted stdio server.
- Server-prefixed tool names can lazy-connect the matching configured server.
- Synthetic resource tools read resources and render text/blob placeholders.
- MCP `isError` results are rendered as error results without throwing away content.
- SDK thrown errors are concise and do not break later status/search/describe calls.
- Result rendering handles text, structured content, embedded resources, resource links, image/audio placeholders, unknown blocks, and truncation.
- No direct tools are registered.
- No commands, UI, permission overlays, HTTP, bearer auth, or OAuth are implemented.
- Mod registration remains capability-guarded and activation remains idle.
- Runtime cleanup still closes MCP clients/transports.
- Full tests, typecheck, build, and bundle smoke pass.

## Explicit Non-goal Audit Before Declaring Done

Before marking Slice 3 complete, inspect the diff/source for these accidental additions and remove them if present:

```bash
rg -n "commands\.register|permissions|ui\.|Streamable|SSE|OAuth|bearer|directTools|approvalPolicy" src tests docs/slice-3-proxy-tool-calls-plan.md
```

Expected:

- No new command registrations.
- No permission overlay code.
- No UI panel/status code.
- No HTTP/SSE/Streamable transport implementation.
- No OAuth/bearer auth implementation.
- No direct tool registration.
- `approvalPolicy` should not be added in Slice 3 unless the user explicitly changes scope.

## Handoff to Slice 4

After Slice 3, the compact proxy should be a useful MVP:

```ts
mcp({})
mcp({ connect: "filesystem" })
mcp({ search: "read" })
mcp({ describe: "filesystem_read_file" })
mcp({ tool: "filesystem_read_file", args: "{\"path\":\"README.md\"}" })
```

Slice 4 should then add human-facing `/mcp` command/setup UX using `letta.commands.register`, still grounded in the `creating-mods` command reference. Do not start Slice 4 until Slice 3 is green and reviewed.
