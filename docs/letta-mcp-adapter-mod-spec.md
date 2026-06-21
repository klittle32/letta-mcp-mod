# Letta MCP Adapter Mod Spec and Implementation Plan

## Purpose

Build a Letta Code mod that brings the core functionality of [`pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter) to Letta Code: MCP server access without dumping every MCP tool schema into the model context.

The default design is proxy-first:

```ts
mcp({
  search?: string,
  describe?: string,
  server?: string,
  connect?: string,
  tool?: string,
  args?: string,
  action?: "auth-start" | "auth-complete" | "auth-status" | "auth-clear"
})
```

Core principle:

> One compact `mcp` tool first. Optional direct tools later, cache-first.

## Product Goals

1. Give Letta Code agents access to MCP servers.
2. Avoid the context bloat of exposing all MCP tool schemas by default.
3. Preserve compatibility with standard MCP config files where possible.
4. Use Letta Code mod APIs idiomatically: tools, commands, UI/status, permissions, cleanup disposers.
5. Build spec-first, plan-first, and test-driven through vertical slices.
6. Keep startup safe: no surprising connections or expensive activation-time work.

## Non-goals for the MVP

- Full Pi interactive panel parity.
- OAuth in the first vertical slice.
- MCP UI/Glimpse/browser integration in the first vertical slice.
- Sampling and elicitation in the first vertical slice.
- Connecting to every configured MCP server at activation time.

## Compatibility Target

The mod should follow `pi-mcp-adapter` semantics where they make sense:

- One compact proxy tool named `mcp`.
- `args` is a JSON string, not an object.
- Lazy server connection by default.
- Cache metadata to disk.
- Direct tools are opt-in and registered from cache only.
- Tool names default to server-prefixed names.
- Search/list/describe can work from cached metadata.
- Regex search is supported against cached metadata only, with bounded patterns.

## Proposed File Layout

Development should happen as a real project, then bundle to a single Letta mod file.

```text
letta-mcp-mod/
  package.json
  src/
    mod.ts                    # thin Letta mod activation layer
    core/
      config.ts
      cache.ts
      tool-names.ts
      schemas.ts
      result-renderer.ts
    mcp/
      manager.ts
      stdio-transport.ts
      http-transport.ts
      oauth.ts
    features/
      proxy-tool.ts
      commands.ts
      direct-tools.ts
      permissions.ts
  tests/
    config.test.ts
    cache.test.ts
    tool-names.test.ts
    proxy-tool.test.ts
    manager-stdio.test.ts
    result-renderer.test.ts
  dist/
    letta-mcp-adapter.mjs
```

Runtime mod output:

```text
~/.letta/mods/letta-mcp-adapter.mjs
```

Because Letta mods should not assume arbitrary dependencies are resolvable from `~/.letta/mods`, the shipped mod should be bundled into a single ESM file, keeping Node built-ins external.

Likely build shape:

```bash
bun build src/mod.ts \
  --target=node \
  --format=esm \
  --outfile=dist/letta-mcp-adapter.mjs
```

## Letta Mod Activation Shape

Conceptually:

```ts
export default function activate(letta) {
  const disposers = [];
  const state = createAdapterState();

  if (letta.capabilities.tools) {
    disposers.push(registerProxyTool(letta, state));
    disposers.push(...registerCachedDirectTools(letta, state));
  }

  if (letta.capabilities.commands) {
    disposers.push(registerMcpCommands(letta, state));
  }

  if (letta.capabilities.permissions) {
    disposers.push(registerMcpPermissions(letta, state));
  }

  if (letta.capabilities.ui.statusValues) {
    disposers.push(registerStatus(letta, state));
  }

  return async () => {
    for (const dispose of disposers.reverse()) await dispose();
    await state.manager.closeAll();
  };
}
```

Rules:

- Guard all optional APIs with `letta.capabilities.*`.
- Do not import Letta Code internals.
- Use callback `ctx` for dynamic state such as `ctx.cwd`, `ctx.agent`, `ctx.conversation`, and `ctx.signal`.
- Do not connect to MCP servers during activation except in a later explicitly designed keep-alive feature.
- Return disposers for tools, commands, permissions, UI handles, timers, transports, callback servers, and other owned resources.

## Core Data Model

### Config

Compatible with Pi/shared MCP config where possible:

```ts
interface McpConfig {
  mcpServers: Record<string, ServerEntry>;
  imports?: ImportKind[];
  settings?: McpSettings;
}

interface ServerEntry {
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

interface OAuthConfig {
  grantType?: "authorization_code" | "client_credentials";
  clientId?: string;
  clientSecret?: string;
  tokenUrl?: string;
  audience?: string;
  scope?: string;
  redirectUri?: string;
  clientName?: string;
  clientUri?: string;
}
```

### Settings

```ts
interface McpSettings {
  toolPrefix?: "server" | "short" | "none";
  idleTimeout?: number;
  directTools?: boolean;
  disableProxyTool?: boolean;
  autoAuth?: boolean;
  authRequiredMessage?: string;
  regexSearch?: boolean | { maxPatternLength?: number };
  ui?: {
    status?: boolean;
    panels?: boolean;
    panelTTLms?: number;
  };
  sampling?: {
    enabled?: boolean;
    mode?: "disabled" | "summary-only" | "conversation-fork";
    alwaysAsk?: boolean;
    maxPromptChars?: number;
  };
  elicitation?: {
    enabled?: boolean;
    form?: boolean;
    url?: boolean;
    alwaysAsk?: boolean;
    timeoutMs?: number;
  };
  approval?: {
    dangerousTools?: "allow" | "ask" | "alwaysAsk" | "deny";
    unknownServers?: "allow" | "ask" | "alwaysAsk" | "deny";
    configWrites?: "allow" | "ask" | "alwaysAsk" | "deny";
  };
}
```

Sampling and elicitation settings are reserved but intentionally not advertised to MCP servers yet. The current adapter keeps MCP clients long-lived in the manager and request handlers there do not have a safe scoped Letta conversation/form input API. Until the mod API can provide per-call conversation/fork or form-input context to MCP client request handlers, the adapter must not advertise `sampling` or `elicitation` capabilities.

### Cache

```ts
interface MetadataCache {
  version: 1;
  servers: Record<string, ServerCacheEntry>;
}

interface ServerCacheEntry {
  configHash: string;
  tools: CachedTool[];
  resources: CachedResource[];
  cachedAt: number;
}
```

Cache path proposal:

```text
~/.letta/mcp-adapter/cache.json
```

### Runtime State

```ts
interface AdapterState {
  config: McpConfig;
  cache: MetadataCache;
  manager: McpServerManager;
  failureTracker: Map<string, number>;
  panels: Set<{ close(): void }>;
}
```

## Config Discovery

Initial config precedence:

1. `~/.config/mcp/mcp.json` — user-global standard MCP config
2. Letta global override: `~/.letta/mcp-adapter/mcp.json`
3. Project standard config: `.mcp.json`
4. Project Letta override: `.letta/mcp.json` or another explicit Letta-owned project override path if chosen

This differs slightly from Pi because Pi uses Pi-owned files. We should preserve standard MCP config compatibility while using Letta-owned override paths for adapter-specific settings.

Supported config behavior:

- Merge later files over earlier files.
- Expand `~` in paths.
- Interpolate `${VAR}` and `$env:VAR` in env, cwd, headers, and token fields.
- Invalid configs should produce concise warnings/diagnostics rather than crashing mod activation.

## Feature Slices

### Slice 1: Read config + proxy status/search/describe

Goal: safe non-invasive mod loaded and useful against cached metadata.

Features:

- Register one Letta mod tool: `mcp`.
- Read standard and Letta-specific MCP configs.
- Load metadata cache.
- Show status:
  - configured servers
  - cached tool counts
  - connected state if live
- Search cached metadata.
- Describe cached tools.

No live MCP calls unless explicitly connecting.

Acceptance examples:

```ts
mcp({})
mcp({ server: "filesystem" })
mcp({ search: "file read" })
mcp({ describe: "filesystem_read_file" })
```

### Slice 2: Lazy connect + list tools

Goal: connect to stdio MCP servers and cache metadata.

Features:

- Support stdio MCP servers:
  - `command`
  - `args`
  - `env`
  - `cwd`
- Lazy connect on:
  - `mcp({ connect: "server" })`
  - `mcp({ tool: "..." })` if metadata or prefix suggests a server
- List tools/resources from the MCP server.
- Save metadata cache to disk.

Acceptance examples:

```ts
mcp({ connect: "filesystem" })
mcp({ server: "filesystem" })
mcp({ search: "read" })
```

### Slice 3: Call MCP tools through proxy

Goal: full useful MVP.

Features:

- Call a tool:

```ts
mcp({
  tool: "filesystem_read_file",
  args: "{\"path\":\"README.md\"}"
})
```

- `args` is a JSON string, like `pi-mcp-adapter`, to keep schema small.
- Validate:
  - args parses
  - args is object
  - tool exists
  - server exists
- Transform MCP content into Letta-friendly output:
  - text -> text
  - image -> metadata/base64 handling only if safe/useful
  - resource -> text summary
  - audio -> placeholder

Acceptance example:

```ts
mcp({
  tool: "filesystem_read_file",
  args: "{\"path\":\"package.json\"}"
})
```

### Slice 4: `/mcp` command and setup UX

Goal: human-facing controls.

Commands:

```text
/mcp
/mcp status
/mcp tools
/mcp reconnect
/mcp reconnect <server>
/mcp setup
```

Initial `/mcp setup` should be simple and text-first:

- show discovered config paths
- show which exist
- show example `.mcp.json`
- optionally create starter `.mcp.json` only if the user explicitly chooses/asks

Letta command behavior:

- `letta.commands.register({ id: "mcp", ... })`
- Start with `{ type: "output", output }`.
- If richer setup needs an agent workflow, return `{ type: "prompt", content }`.

Acceptance examples:

```text
/mcp
/mcp tools
/mcp reconnect filesystem
```

### Slice 5: HTTP MCP servers + bearer auth

Goal: support common remote MCP servers.

Features:

- HTTP transport:
  - Streamable HTTP first
  - SSE fallback if needed
- Headers
- Bearer token support:
  - `bearerToken`
  - `bearerTokenEnv`
  - env interpolation

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

### Slice 6: OAuth

Goal: feature parity with Pi for authenticated remote MCPs.

Features:

```ts
mcp({ action: "auth-start", server: "linear" })

mcp({
  action: "auth-complete",
  server: "linear",
  args: "{\"redirectUrl\":\"http://localhost:...\"}"
})
```

Store OAuth state/tokens under:

```text
~/.letta/mcp-adapter/auth/
```

Acceptance criteria:

- Headless/manual OAuth works.
- Token is persisted.
- Reconnect succeeds after `auth-complete`.

### Slice 7: Direct tools

Goal: optional convenience, not default.

Config:

```json
{
  "settings": {
    "directTools": false,
    "toolPrefix": "server"
  },
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "directTools": ["search_repositories", "get_file_contents"]
    }
  }
}
```

Features:

- At activation, register direct tools only from cache.
- Never connect to MCP servers during activation just to discover direct tools.
- If cache is missing, proxy remains available.
- Tool names follow Pi convention:
  - `server`: `github_search_repositories`
  - `short`: strip `-mcp`
  - `none`: original name

Acceptance criteria:

- Add `directTools`, run `/reload`, direct tools appear if cache exists.
- If cache is missing, `mcp` says to run `/mcp reconnect <server>`.

### Slice 8: Letta-specific permissions and safety

Goal: improve on Pi by using Letta mod permission overlays.

Potential permission behavior:

- Ask/deny for MCP calls that:
  - call tools with names matching `delete|write|update|exec|run|shell|browser`
  - touch paths outside `ctx.cwd`
  - target unknown HTTP hosts
- Always ask for config writes.
- Optional config:

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

Acceptance criteria:

- Risky MCP tool calls trigger `ask` or `alwaysAsk`.
- Benign search/describe/status remain automatic.
- Permission failures deny safely and explain why.

## Proxy Tool Schema

The proxy tool should use a small object schema:

```ts
{
  type: "object",
  properties: {
    tool: {
      type: "string",
      description: "Tool name to call, e.g. filesystem_read_file"
    },
    args: {
      type: "string",
      description: "Arguments as JSON string, e.g. '{\"path\":\"README.md\"}'"
    },
    connect: {
      type: "string",
      description: "Server name to connect and refresh metadata"
    },
    describe: {
      type: "string",
      description: "Tool name to describe"
    },
    search: {
      type: "string",
      description: "Search MCP tools by name/description"
    },
    regex: {
      type: "boolean",
      description: "Treat search as a bounded JavaScript regex against cached metadata"
    },
    includeSchemas: {
      type: "boolean",
      description: "Include parameter schemas in search results"
    },
    server: {
      type: "string",
      description: "Filter to or disambiguate a specific server"
    },
    action: {
      type: "string",
      description: "Action: auth-start, auth-complete, auth-status, or auth-clear"
    }
  },
  additionalProperties: false
}
```

Mode precedence:

```text
action > tool > connect > describe > search > server > status
```

## Tool Naming

Default `toolPrefix` is `server`.

Rules:

- `server`: server name with hyphens changed to underscores.
  - `chrome-devtools` + `take_screenshot` -> `chrome_devtools_take_screenshot`
- `short`: strips trailing `-mcp`, then converts hyphens.
  - `foo-mcp` + `bar` -> `foo_bar`
- `none`: original MCP tool name.

Tool lookup should fuzzy-match hyphens and underscores:

```text
context7_resolve_library_id == context7_resolve-library-id
```

Resources are exposed as synthetic tools unless disabled:

```text
get_<resource-name>
```

## TDD Plan

### Test Framework

Use a normal project test runner, probably Vitest unless the project already chooses something else.

Test priority:

1. Pure deterministic functions.
2. Fake MCP manager behavior.
3. Real local fixture MCP server.
4. Manual Letta mod reload smoke tests.

### Cycle 1: Config discovery

Write tests first:

- loads empty config if no files exist
- loads `~/.config/mcp/mcp.json`
- loads project `.mcp.json`
- later files override earlier files
- env interpolation works
- `~` path expansion works
- invalid config produces warning, not crash

Implement:

- `loadMcpConfig({ cwd, home, overridePath })`
- `mergeConfigs`
- `validateConfig`
- `interpolateEnvVars`

Definition of done:

- tests green
- no Letta mod runtime required yet

### Cycle 2: Tool naming and exclusion

Tests:

- `formatToolName("read_file", "filesystem", "server")` -> `filesystem_read_file`
- `formatToolName("x", "foo-mcp", "short")` -> `foo_x`
- `toolPrefix: "none"` preserves original
- hyphen/underscore fuzzy matching works
- `excludeTools` works for original and prefixed names
- resource names become `get_<name>`

Implement:

- `getServerPrefix`
- `formatToolName`
- `findToolByName`
- `isToolExcluded`
- `resourceNameToToolName`

Definition of done:

- deterministic naming matches Pi behavior

### Cycle 3: Cache

Tests:

- computes stable hash for config identity
- ignores lifecycle/idle/debug in hash
- invalidates when command/url/env/auth changes
- cache round-trips
- cache max age works
- reconstructs metadata from cache

Implement:

- `computeServerHash`
- `loadMetadataCache`
- `saveMetadataCache`
- `isServerCacheValid`
- `reconstructToolMetadata`

Definition of done:

- direct-tool slice has a tested foundation

### Cycle 4: Proxy status/search/describe with fake state

Tests:

- `mcp({})` returns status
- `mcp({ server })` lists tools
- `mcp({ search })` searches name and description
- search terms are OR'd
- `includeSchemas: false` suppresses schemas
- `describe` shows schema
- unknown tool/server returns actionable text

Implement:

- `executeStatus`
- `executeList`
- `executeSearch`
- `executeDescribe`
- proxy dispatcher mode precedence

Definition of done:

- first Letta mod can register `mcp` and operate on cache/config without live MCP

### Cycle 5: Letta mod shell registration

Tests:

- fake `letta` object
- if `capabilities.tools` false, no tool registered
- if true, registers `mcp`
- tool schema is object schema
- dispose unregisters
- errors are short/actionable

Implement:

- `src/mod.ts`
- `registerProxyTool`

Manual smoke:

1. build bundle
2. copy or symlink to `~/.letta/mods/letta-mcp-adapter.mjs`
3. run `/reload`
4. ask agent to call `mcp({})`

Definition of done:

- mod loads successfully with no MCP servers configured

### Cycle 6: Stdio connection integration

Tests:

- create a fixture MCP stdio server
- manager connects
- manager lists tools
- manager calls echo tool
- manager closes transport
- concurrent connects dedupe
- failed connect sets failure state/backoff

Implement:

- `McpServerManager`
- stdio transport
- `connect`
- `callTool`
- `close`
- `closeAll`

Definition of done:

- can connect to a test MCP server and call a tool

### Cycle 7: Proxy call

Tests:

- invalid args JSON errors
- args array/null/string rejected
- unknown tool suggests search
- cached tool triggers lazy connect
- tool call returns transformed text content
- MCP `isError` returns schema hint
- resource tool reads resource

Implement:

- `executeConnect`
- `executeCall`
- result renderer
- cache update after connect

Manual smoke config:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    }
  }
}
```

Manual smoke calls:

```ts
mcp({ connect: "filesystem" })
mcp({ search: "read" })
mcp({ tool: "filesystem_read_file", args: "{\"path\":\"README.md\"}" })
```

Definition of done:

- useful MVP

### Cycle 8: `/mcp` commands

Tests:

- command registration guarded by capabilities
- `/mcp` status output
- `/mcp tools`
- `/mcp reconnect <server>`
- invalid subcommand gives help

Implement:

- `registerMcpCommands`

Manual smoke:

```text
/mcp
/mcp tools
/mcp reconnect filesystem
```

Definition of done:

- human-controllable UX exists

### Cycle 9: HTTP + bearer auth

Tests:

- HTTP fixture MCP server
- Streamable HTTP connect
- SSE fallback if feasible
- headers passed
- bearer token env read
- auth missing errors actionable

Implement:

- HTTP transport
- bearer header resolution

Definition of done:

- local HTTP MCP servers work

### Cycle 10: Direct tools

Tests:

- direct tools registered from cache only
- no server connection during activation
- direct false/true/string[] behavior
- built-in collisions skipped
- duplicate names skipped
- direct executor lazy-connects and calls original tool

Implement:

- `registerCachedDirectTools`
- direct executor

Manual smoke:

1. connect/cache server
2. set `directTools`
3. `/reload`
4. verify direct tool appears and works

Definition of done:

- optional context-expensive mode works intentionally

### Cycle 11: Permissions

Tests:

- benign `mcp search` allow/no opinion
- dangerous tool name asks/alwaysAsks
- server not configured denies
- config write commands ask
- permission failures deny safely

Implement:

- `registerMcpPermissions`

Definition of done:

- safer-than-Pi behavior for risky MCP interactions

## Milestones

### Milestone A: Useful MVP

1. Config
2. Cache
3. Tool naming
4. Proxy status/search/describe
5. Mod registration
6. Stdio connect/call
7. `/mcp` basic commands

Outcome: local MCP servers usable in Letta Code via `mcp`.

### Milestone B: Production-quality adapter

1. HTTP
2. Bearer auth
3. Direct tools
4. Robust lifecycle cleanup
5. Better diagnostics
6. Permission overlay

Outcome: strong day-to-day MCP adapter.

### Milestone C: Parity and polish

1. OAuth
2. Setup wizard
3. UI panels/status
4. MCP UI resource handling
5. Regex search, auth-clear, and client-credentials OAuth
6. Sampling/elicitation only if Letta mod APIs support safe scoped handlers

Outcome: closer parity with `pi-mcp-adapter`.

## Risks and Decisions

### Dependency loading from mods

Risk: mods in `~/.letta/mods` may not resolve project `node_modules`.

Decision: bundle the mod into one `.mjs` file.

### Startup side effects

Risk: connecting to every MCP server on activation is slow and surprising.

Decision: cache-first activation; lazy live connections only from explicit tool/command calls.

### Direct tools increase context

Risk: direct tools recreate the MCP bloat problem.

Decision: proxy-first; direct tools opt-in and cache-backed.

### OAuth complexity

Risk: OAuth is a large feature.

Decision: stdio MVP first, bearer HTTP second, OAuth later.

### UI parity

Risk: Pi has richer panel/overlay primitives than Letta mods currently expose.

Decision: start with text command output and optional lightweight `openPanel`; do not try to recreate the full Pi interactive panel immediately.

## Recommended First Vertical Slice

Start with Slice 1 plus mod registration:

> A Letta mod that registers `mcp`, reads config/cache, and supports status/search/describe from cache.

Then Slice 2 makes it live:

> Add stdio connect, metadata discovery, and cache write.

Then Slice 3 makes it useful:

> Add actual tool calls.

This keeps each implementation chunk coherent, reviewable, and testable.
