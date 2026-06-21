# Slice 1 Plan: Cache-backed MCP Proxy Tool for Letta Code

## Purpose

Implement the first vertical slice of the Letta MCP Adapter mod: a safe, cache-backed `mcp` proxy tool that loads MCP config and metadata cache, then supports status, server listing, search, and describe without connecting to live MCP servers.

This slice deliberately avoids live MCP transport. Its job is to prove the Letta mod shape, project scaffolding, config/cache/naming foundations, test style, and user-facing proxy UX before adding stdio connection in Slice 2.

## Grounding Requirements

All implementation work for this slice must be grounded in the actual Letta Code mods API and the `creating-mods` skill guidance.

Before implementing or changing mod code, re-check the relevant skill references if context has drifted:

- `creating-mods/SKILL.md`
- `creating-mods/references/tools.md`
- `creating-mods/references/architecture.md`

For this slice, the relevant Letta mod API surface is:

```ts
export default function activate(letta) {
  const disposers = [];

  if (letta.capabilities.tools) {
    disposers.push(letta.tools.register({
      name: "mcp",
      description: "...",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      requiresApproval: false,
      parallelSafe: true,
      async run(ctx) {
        // use ctx.cwd, ctx.args, ctx.signal
      },
    }));
  }

  return () => {
    for (const dispose of disposers.reverse()) dispose();
  };
}
```

Constraints from the mod API and skill:

- Guard optional APIs with `letta.capabilities.*`.
- Use `letta.tools.register` only when `letta.capabilities.tools` is true.
- Tool parameters must be a JSON Schema object.
- Use `additionalProperties: false` where possible.
- Use `ctx.cwd` as the invocation workspace.
- Use callback context (`ctx`) rather than global app context.
- Do not import Letta Code internals.
- Do not do surprising startup side effects.
- Return cleanup disposers from activation.
- Keep output concise and actionable.
- Tools should return information for the model; tools should not start hidden model runs.
- `requiresApproval: false` and `parallelSafe: true` are acceptable in Slice 1 because this slice is read-only local introspection: config/cache read plus formatting.

## Slice 1 Scope

### In scope

- Initialize a real TypeScript project in this repository.
- Add test runner and build tooling.
- Implement pure config loading helpers.
- Implement tool naming and lookup helpers.
- Implement metadata cache loading/reconstruction helpers.
- Implement cache-backed proxy modes:
  - status: `mcp({})`
  - list server: `mcp({ server: "name" })`
  - search: `mcp({ search: "query" })`
  - describe: `mcp({ describe: "tool_name" })`
- Implement a Letta mod activation file that registers the `mcp` tool.
- Bundle to `dist/letta-mcp-adapter.mjs`.
- Optionally copy to `~/.letta/mods/letta-mcp-adapter.mjs` only when explicitly doing the local smoke test; do not symlink because Letta Code's mod loader ignores symlinked mod files.
- Document how to smoke test with `/reload`.

### Out of scope

- Stdio MCP connection.
- HTTP MCP connection.
- Calling MCP tools.
- OAuth.
- Direct tools.
- `/mcp` slash commands.
- Permission overlays.
- UI panels/status values.
- Config writes/setup wizard.

These are future slices. Do not sneak them into Slice 1.

## Expected User-facing Behavior

With no config files and no cache:

```ts
mcp({})
```

returns a concise status like:

```text
MCP: 0 configured servers, 0 cached tools.

No MCP servers configured.
Create a .mcp.json in this workspace or configure ~/.config/mcp/mcp.json.
```

With config but no cache:

```text
MCP: 2 configured servers, 0 cached tools.

○ filesystem (configured, no cache)
○ github (configured, no cache)

Use mcp({ connect: "server" }) after Slice 2 supports live connections.
```

With cache:

```ts
mcp({ server: "filesystem" })
```

returns:

```text
filesystem (3 cached tools):

- filesystem_read_file - Read file contents
- filesystem_list_directory - List directory contents
- filesystem_get_readme - Read resource: file:///README.md
```

Search:

```ts
mcp({ search: "read file" })
```

returns matching tools. Non-regex search should OR space-separated terms, matching name or description.

Describe:

```ts
mcp({ describe: "filesystem_read_file" })
```

returns the tool name, server, description, and a readable parameter summary from JSON Schema.

Unsupported proxy modes in Slice 1 should return a clear not-yet-implemented message, not crash:

```ts
mcp({ connect: "filesystem" })
```

returns something like:

```text
Live MCP connections are not implemented in Slice 1. This slice supports status, server listing from cache, search, and describe.
```

Similarly, `tool` calls should say Slice 2/3 will add connect/call support.

## Proposed Repository Structure After Slice 1

```text
.
├── docs/
│   ├── letta-mcp-adapter-mod-spec.md
│   └── slice-1-cache-backed-proxy-plan.md
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── src/
│   ├── mod.ts
│   ├── core/
│   │   ├── cache.ts
│   │   ├── config.ts
│   │   ├── paths.ts
│   │   ├── result.ts
│   │   ├── schema-format.ts
│   │   └── tool-names.ts
│   └── features/
│       └── proxy-tool.ts
└── tests/
    ├── cache.test.ts
    ├── config.test.ts
    ├── mod.test.ts
    ├── proxy-tool.test.ts
    ├── schema-format.test.ts
    └── tool-names.test.ts
```

Keep the implementation modular for testability. The final mod bundle can still be a single `.mjs` file.

## Config Design for Slice 1

### Config sources

Slice 1 should read these files, in order, with later files overriding earlier files:

1. User-global standard MCP config:

```text
~/.config/mcp/mcp.json
```

2. Letta global override:

```text
~/.letta/mcp-adapter/mcp.json
```

3. Project standard MCP config:

```text
<ctx.cwd>/.mcp.json
```

4. Project Letta override:

```text
<ctx.cwd>/.letta/mcp.json
```

Rationale:

- Keep compatibility with standard MCP config files.
- Use Letta-owned paths for Letta-specific overrides rather than Pi-owned paths.

### Config types

Minimum Slice 1 types:

```ts
export interface McpConfig {
  mcpServers: Record<string, ServerEntry>;
  imports?: ImportKind[];
  settings?: McpSettings;
}

export interface ServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;

  url?: string;
  headers?: Record<string, string>;

  auth?: "oauth" | "bearer" | false;
  bearerToken?: string;
  bearerTokenEnv?: string;
  oauth?: OAuthConfig | false;

  lifecycle?: "lazy" | "eager" | "keep-alive";
  idleTimeout?: number;

  exposeResources?: boolean;
  directTools?: boolean | string[];
  excludeTools?: string[];
  debug?: boolean;
}

export interface McpSettings {
  toolPrefix?: "server" | "short" | "none";
  idleTimeout?: number;
  directTools?: boolean;
  disableProxyTool?: boolean;
  autoAuth?: boolean;
  authRequiredMessage?: string;
}
```

Slice 1 should accept and preserve fields needed later, but only use:

- `mcpServers`
- `settings.toolPrefix`
- `exposeResources`
- `excludeTools`

### Config behavior

Implement:

- `loadMcpConfig({ cwd, home, globalOverridePath?, projectOverridePath? })`
- `getConfigSources({ cwd, home })`
- `readConfigFile(path)`
- `validateConfig(raw)`
- `mergeConfigs(base, next)`
- `interpolateEnvVars(value, env)`
- `resolveConfigPath(value, home, env)`

Validation should be permissive and safe:

- Missing file -> ignored.
- Invalid JSON -> warning object, not activation crash.
- Missing `mcpServers` -> treat as empty if rest is object.
- Invalid `mcpServers` shape -> warning and skip that file.
- Unknown fields -> preserve if harmless, but do not depend on them.

Return shape should include warnings so the proxy status can show them concisely:

```ts
interface LoadedMcpConfig {
  config: McpConfig;
  sources: ConfigSourceStatus[];
  warnings: string[];
}
```

## Cache Design for Slice 1

### Cache path

```text
~/.letta/mcp-adapter/cache.json
```

For tests, all path helpers must accept injected `home` so tests do not touch real home.

### Cache types

```ts
export interface MetadataCache {
  version: 1;
  servers: Record<string, ServerCacheEntry>;
}

export interface ServerCacheEntry {
  configHash: string;
  tools: CachedTool[];
  resources: CachedResource[];
  cachedAt: number;
}

export interface CachedTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  uiResourceUri?: string;
  uiStreamMode?: "eager" | "stream-first";
}

export interface CachedResource {
  uri: string;
  name: string;
  description?: string;
}

export interface ToolMetadata {
  name: string;
  originalName: string;
  description: string;
  inputSchema?: unknown;
  resourceUri?: string;
  uiResourceUri?: string;
  uiStreamMode?: "eager" | "stream-first";
}
```

### Cache behavior

Implement:

- `getMetadataCachePath(home)`
- `loadMetadataCache({ home })`
- `emptyMetadataCache()`
- `computeServerHash(definition, env, home)`
- `isServerCacheValid(entry, definition, opts)`
- `reconstructToolMetadata(serverName, entry, prefix, definition)`

Slice 1 only reads cache. It can implement `saveMetadataCache` now if trivial, but tests should not require live metadata writing until Slice 2.

Hash behavior should match `pi-mcp-adapter` intent:

Include identity/tool-shape fields:

- `command`
- `args`
- resolved/interpolated `env`
- resolved `cwd`
- `url`
- interpolated `headers`
- `auth`
- resolved bearer token value or `bearerTokenEnv`
- `exposeResources`
- `excludeTools`

Exclude runtime fields:

- `lifecycle`
- `idleTimeout`
- `debug`
- `directTools`

Rationale: cache validity should depend on server/tool identity, not startup behavior or direct-tool display policy.

## Tool Naming Design

Implement Pi-compatible naming:

```ts
export type ToolPrefixMode = "server" | "short" | "none";

export function getServerPrefix(serverName: string, mode: ToolPrefixMode): string;
export function formatToolName(toolName: string, serverName: string, mode: ToolPrefixMode): string;
export function normalizeToolName(value: string): string;
export function findToolByName(metadata: ToolMetadata[] | undefined, requestedName: string): ToolMetadata | undefined;
export function isToolExcluded(toolName: string, serverName: string, prefix: ToolPrefixMode, excludeTools?: unknown): boolean;
export function resourceNameToToolName(name: string): string;
```

Rules:

- Default prefix mode: `server`.
- `server`: replace hyphens with underscores.
- `short`: strip trailing `-mcp`, then replace hyphens with underscores. If empty, use `mcp`.
- `none`: no prefix.
- Lookup fuzzy-matches hyphen vs underscore.
- Exclusion should match original, current-prefixed, server-prefixed, and short-prefixed forms.
- Resource synthetic tools should be named `get_<resourceNameToToolName(resource.name)>`.

## Schema Formatting Design

Implement a compact readable schema formatter:

```ts
export function formatSchema(schema: unknown, indent = "  "): string;
```

Minimum behavior:

- Object schema with properties -> list each property.
- Required properties marked `*required*`.
- Type shown when available.
- Enum/const shown.
- Description appended.
- Defaults and common constraints shown when available.
- Empty object schema -> `(no parameters)`.
- Invalid/missing schema -> `(no schema)`.

This lets `describe` and search results be useful without dumping raw JSON.

## Proxy Feature Design

### Proxy input type

```ts
interface McpProxyArgs {
  tool?: string;
  args?: string;
  connect?: string;
  describe?: string;
  search?: string;
  regex?: boolean;
  includeSchemas?: boolean;
  server?: string;
  action?: string;
}
```

### Proxy tool schema

The registered Letta tool parameters must be an object schema:

```ts
const MCP_PROXY_PARAMETERS = {
  type: "object",
  properties: {
    tool: {
      type: "string",
      description: "Tool name to call, e.g. filesystem_read_file. Tool calls are not implemented until a later slice.",
    },
    args: {
      type: "string",
      description: "Arguments as JSON string, e.g. '{\"path\":\"README.md\"}'.",
    },
    connect: {
      type: "string",
      description: "Server name to connect and refresh metadata. Not implemented in Slice 1.",
    },
    describe: {
      type: "string",
      description: "Tool name to describe from cached metadata.",
    },
    search: {
      type: "string",
      description: "Search cached MCP tools by name or description.",
    },
    regex: {
      type: "boolean",
      description: "Treat search as a regex. Slice 1 may reject regex or support safe simple regex.",
    },
    includeSchemas: {
      type: "boolean",
      description: "Include parameter schemas in search results. Defaults to true.",
    },
    server: {
      type: "string",
      description: "Filter to or list tools from a specific server.",
    },
    action: {
      type: "string",
      description: "Action such as ui-messages, auth-start, or auth-complete. Not implemented in Slice 1.",
    },
  },
  additionalProperties: false,
};
```

### Mode precedence

Follow the project spec and Pi behavior:

```text
action > tool > connect > describe > search > server > status
```

Slice 1 implementation:

- `action` -> not yet implemented message.
- `tool` -> not yet implemented message.
- `connect` -> not yet implemented message.
- `describe` -> implemented from cache.
- `search` -> implemented from cache.
- `server` -> implemented from cache/config.
- no args -> status.

### State construction per invocation

Because Slice 1 has no live connection, keep activation light and rebuild config/cache at tool invocation time so changes to files are visible without requiring `/reload` for config/cache reads.

Recommended:

```ts
async function loadInvocationState(ctx): Promise<ProxyState> {
  const loaded = loadMcpConfig({ cwd: ctx.cwd, home: homedir() });
  const cache = loadMetadataCache({ home: homedir() }) ?? emptyMetadataCache();
  const prefix = loaded.config.settings?.toolPrefix ?? "server";
  const metadata = reconstructAllConfiguredMetadata(loaded.config, cache, prefix);
  return { loaded, cache, prefix, metadata };
}
```

Rationale:

- No surprising activation work.
- Users can edit `.mcp.json` and retry `mcp({})` immediately.
- Still fast because it only reads small JSON files.

### Status output

`executeStatus(state)` should show:

- configured server count
- cached tool/resource count
- per-server status:
  - configured, valid cache with count
  - configured, cache missing
  - configured, cache stale
- concise config warnings if any
- next action hint

### List server output

`executeList(state, serverName)` should:

- error if server not configured
- show cached tools if present
- distinguish no cache vs empty cache
- include short descriptions

### Search output

`executeSearch(state, query, opts)` should:

- reject empty query
- for non-regex: split whitespace and OR terms
- match tool name or description
- optionally restrict to `server`
- default `includeSchemas` to true
- show parameter summary when schemas are included

Regex decision for Slice 1:

- Preferred simple approach: reject `regex: true` with a message saying regex search is deferred unless we add a safe regex dependency.
- If implemented, cap query length and avoid catastrophic regexes. Do not add complexity unless needed.

### Describe output

`executeDescribe(state, toolName)` should:

- find by exact or hyphen/underscore normalized name
- search all configured/cached servers
- show server
- show original MCP tool name
- show description
- show resource URI if resource synthetic tool
- show formatted schema or no-parameters message
- suggest `mcp({ search: "..." })` if not found

## Test-driven Development Steps

Do these in order. Each step should start with tests, then implementation.

### Step 1: Project scaffolding

Actions:

1. Create `package.json`.
2. Add scripts:

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "build": "bun build src/mod.ts --target=node --format=esm --outfile=dist/letta-mcp-adapter.mjs",
    "typecheck": "tsc --noEmit"
  }
}
```

3. Add TypeScript/Vitest dev dependencies as appropriate.
4. Add `tsconfig.json`.
5. Add `vitest.config.ts` if needed.

Acceptance:

- `npm test` or chosen package-manager equivalent runs with no tests or a placeholder test.
- `npm run typecheck` works once code exists.
- `npm run build` can eventually create `dist/letta-mcp-adapter.mjs`.

Package manager note:

- Inspect existing project files first. If no lockfile exists, choose one package manager and stay consistent. Since Letta Code is running in a Node environment and Bun build is useful for bundling, Bun is acceptable if available; otherwise use npm plus esbuild/tsx/Vitest.

### Step 2: Config tests first

Create `tests/config.test.ts`.

Test cases:

1. Returns empty config when no config files exist.
2. Loads user-global standard MCP config.
3. Loads project `.mcp.json`.
4. Later project config overrides earlier global config for same server name.
5. Settings merge with later settings overriding earlier settings.
6. Invalid JSON produces warning and skips file.
7. Invalid `mcpServers` shape produces warning and skips file.
8. `${VAR}` and `$env:VAR` interpolation works.
9. `~` expansion works for `cwd`.
10. Config source statuses include path and exists boolean.

Implement `src/core/config.ts` and `src/core/paths.ts` until green.

Acceptance:

- `vitest run tests/config.test.ts` passes.

### Step 3: Tool naming tests first

Create `tests/tool-names.test.ts`.

Test cases:

1. `server` prefix converts hyphens to underscores.
2. `short` prefix strips trailing `-mcp`.
3. `none` prefix returns original tool name.
4. Empty short prefix falls back to `mcp`.
5. `findToolByName` exact match works.
6. `findToolByName` hyphen/underscore fuzzy match works.
7. `excludeTools` matches original name.
8. `excludeTools` matches prefixed name.
9. Resource names become safe synthetic tool names.

Implement `src/core/tool-names.ts` until green.

Acceptance:

- naming behavior matches Pi-compatible expectations.

### Step 4: Cache tests first

Create `tests/cache.test.ts`.

Test cases:

1. Missing cache returns null or empty cache by helper.
2. Invalid cache JSON returns null and warning if warnings are part of API.
3. Valid cache loads.
4. Server hash is stable independent of object key order.
5. Server hash changes when command/args/url/env/headers/auth/excludeTools changes.
6. Server hash does not change when lifecycle/idleTimeout/debug/directTools changes.
7. Cache invalidates when hash differs.
8. Cache invalidates when older than max age.
9. Reconstruct metadata includes cached tools.
10. Reconstruct metadata includes resources as synthetic tools when `exposeResources !== false`.
11. Reconstruct metadata omits excluded tools/resources.

Implement `src/core/cache.ts` until green.

Acceptance:

- cache foundations are tested without real MCP connections.

### Step 5: Schema formatter tests first

Create `tests/schema-format.test.ts`.

Test cases:

1. Missing schema -> `(no schema)`.
2. Empty object schema -> `(no parameters)`.
3. Object properties show name/type.
4. Required property is marked.
5. Description appears.
6. Enum and default appear.
7. Nested object/array is at least readable.

Implement `src/core/schema-format.ts` until green.

Acceptance:

- search/describe can rely on formatted schemas.

### Step 6: Proxy mode tests first

Create `tests/proxy-tool.test.ts`.

Use fake in-memory config/cache state, not filesystem, for core proxy mode tests.

Test cases:

1. Empty status says 0 configured servers.
2. Status with configured server and no cache says configured/no cache.
3. Status with valid cached server shows cached tool count.
4. Server list for unknown server returns actionable error.
5. Server list with cached tools shows names and descriptions.
6. Search rejects empty query.
7. Search ORs whitespace terms.
8. Search can filter by server.
9. Search includes schemas by default.
10. Search suppresses schemas when `includeSchemas: false`.
11. Describe returns server, original name, description, schema.
12. Describe unknown tool suggests search.
13. `action` returns Slice 1 not-yet-implemented message.
14. `tool` returns Slice 1 not-yet-implemented message.
15. `connect` returns Slice 1 not-yet-implemented message.
16. Dispatcher precedence is `action > tool > connect > describe > search > server > status`.

Implement `src/features/proxy-tool.ts` until green.

Acceptance:

- proxy behavior is fully tested independent of Letta runtime.

### Step 7: Letta mod registration tests first

Create `tests/mod.test.ts`.

Use a fake `letta` object:

```ts
function createFakeLetta(capabilities = { tools: true }) {
  const registeredTools = [];
  const disposers = [];
  return {
    capabilities,
    tools: {
      register(tool) {
        registeredTools.push(tool);
        const dispose = vi.fn();
        disposers.push(dispose);
        return dispose;
      },
    },
    diagnostics: { report: vi.fn() },
    registeredTools,
    disposers,
  };
}
```

Test cases:

1. Does not register tool when `capabilities.tools` is false.
2. Registers exactly one tool named `mcp` when tools are available.
3. Tool description explains when to use it.
4. Tool parameters are an object schema with `additionalProperties: false`.
5. Tool is read-only: `requiresApproval: false`.
6. Tool is parallel-safe for Slice 1: `parallelSafe: true`.
7. Returned disposer calls registered disposer.
8. Tool `run(ctx)` uses `ctx.args` and returns status for empty args.

Implement `src/mod.ts` until green.

Acceptance:

- Letta mod shell is API-correct and tested.

### Step 8: Build bundle

Actions:

1. Run typecheck.
2. Run tests.
3. Run build.
4. Confirm `dist/letta-mcp-adapter.mjs` exists.
5. Inspect top/bottom of bundle enough to ensure it exports default activation function.

Commands:

```bash
npm test
npm run typecheck
npm run build
ls -lh dist/letta-mcp-adapter.mjs
```

Use the actual package manager selected in Step 1.

Acceptance:

- Tests pass.
- Typecheck passes.
- Bundle exists.

### Step 9: Manual Letta mod smoke test

Only after automated checks pass.

Actions:

1. Ensure `~/.letta/mods` exists.
2. Copy the bundle; do not symlink it because Letta Code's mod loader ignores symlinked mod files:

```bash
mkdir -p ~/.letta/mods
cp dist/letta-mcp-adapter.mjs ~/.letta/mods/letta-mcp-adapter.mjs
```

3. In Letta Code, run `/reload`.
4. Ask the agent/model to use `mcp({})`, or inspect tool availability if the UI exposes it.
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

Acceptance:

- `/reload` succeeds.
- `mcp({})` returns status rather than throwing.
- No unexpected startup side effects.

## Implementation Guardrails

- Do not commit unless the user explicitly asks.
- Do not implement live MCP connection in Slice 1.
- Do not add slash commands in Slice 1.
- Do not add permission overlays in Slice 1.
- Do not write config files in Slice 1.
- Do not connect to external MCP servers in tests for Slice 1.
- Do not read or write the real home directory in tests.
- Keep filesystem helpers injectable with `home`, `cwd`, and `env`.
- Do not store secrets.
- Do not import Letta Code internals.
- Keep mod activation cheap.
- Read config/cache during tool invocation, not activation, for Slice 1.

## Definition of Done for Slice 1

Slice 1 is complete when:

1. The repo has a working TypeScript test/build setup.
2. Config loading is tested and implemented.
3. Cache loading/reconstruction is tested and implemented.
4. Tool naming/exclusion is tested and implemented.
5. Schema formatting is tested and implemented.
6. Proxy status/list/search/describe are tested and implemented.
7. `src/mod.ts` registers a Letta mod tool named `mcp` using the actual `letta.tools.register` API shape.
8. The mod uses `letta.capabilities.tools` guard.
9. The tool schema is a JSON Schema object with `additionalProperties: false`.
10. The tool is read-only in this slice and uses `requiresApproval: false`, `parallelSafe: true`.
11. The tool uses `ctx.cwd` and `ctx.args` at invocation time.
12. No live MCP server connection happens.
13. Tests pass.
14. Typecheck passes.
15. Bundle builds to `dist/letta-mcp-adapter.mjs`.
16. Manual `/reload` smoke test succeeds, if performed.
17. Any limitations are documented in output and README/spec notes.

## Next Slice Boundary

When Slice 1 is done, Slice 2 should add live stdio connection and metadata cache writes:

- `mcp({ connect: "server" })`
- stdio `McpServerManager`
- list MCP tools/resources from a real server
- update cache
- keep search/describe/list working from refreshed cache

Do not start Slice 2 until Slice 1 is green and reviewed.
