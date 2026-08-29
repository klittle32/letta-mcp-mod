# Letta MCP Adapter Mod

A Letta Code port of the `pi-mcp-adapter` pattern: a lazy, context-efficient MCP gateway. It exposes two compact model tools, `search_tools` and `call_tool`, instead of dumping every configured MCP tool schema into the model context. Optional cache-backed direct tools remain available for selected integrations.

## What this mod provides

- `search_tools` for finding current MCP capabilities and their argument schemas.
- `call_tool` for invoking a result using object-valued arguments.
- A human `/lmcp` slash command for setup, status, cached tool listing, reconnects, and OAuth actions.
- Lazy MCP connections: activation reads local config/cache but does not start MCP server processes or perform HTTP MCP network work.
- Transparent metadata refresh when search needs current information.
- Aggregate output guarding with private spill files for oversized results.
- TTL- and auth-scope-aware metadata caching under `~/.letta/mcp-adapter/cache.json`.
- Stdio and Streamable HTTP MCP transports.
- MCP protocol-version negotiation with cached discovery results.
- Safe MCP 2026 result handling: completed results render normally, while
  unresolved input and unsupported task results return explicit guidance.
- HTTP bearer auth and OAuth authorization-code / client-credentials flows.
- Optional direct tool registration from cache only.
- Guarded Letta permission overlay plus status/panel UI integration when the host supports it.

## Requirements

- Letta Code with local mod support.
- Bun for local development/builds.
- Node.js 20 or newer.

## Install and build

Clone the repository and install dependencies:

```bash
git clone <this-repo-url> letta-mcp-mod
cd letta-mcp-mod
bun install
```

Run the checks:

```bash
bun test
bun run typecheck
```

Build the bundled mod file:

```bash
bun run build
```

The build writes:

```text
dist/letta-mcp-adapter.mjs
```

`dist/` is intentionally git-ignored; rebuild it locally whenever source changes.

## Install the mod into Letta Code

Letta Code loads local mods from:

```text
~/.letta/mods/
```

Create the directory if needed:

```bash
mkdir -p ~/.letta/mods
```

### Copy the built bundle

Letta Code currently discovers mod files with filesystem directory entries that
must be regular files. Do not install this bundle as a symlink: symlinked mods
are ignored by the loader.

```bash
bun run build
cp dist/letta-mcp-adapter.mjs ~/.letta/mods/letta-mcp-adapter.mjs
```

After rebuilding later, copy the file again and reload Letta Code.

### Reload Letta Code

After installing or rebuilding the mod, restart Letta Code or run:

```text
/reload
```

## MCP config files

The adapter reads JSON config files in merge order:

1. `~/.config/mcp/mcp.json`
2. `~/.letta/mcp-adapter/mcp.json`
3. `<project>/.mcp.json`
4. `<project>/.letta/mcp.json`

Later files override earlier files for the same server names and settings. For project-specific setup, put a `.mcp.json` in the project root.

You can inspect the paths Letta sees with:

```text
/lmcp setup
```

Create a starter project config with:

```text
/lmcp setup create
```

## `.mcp.json` examples

### Stdio server

Use stdio for local MCP servers launched as child processes:

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

Then refresh metadata:

```text
/lmcp reconnect filesystem
```

### HTTP server with bearer auth

Prefer `bearerTokenEnv` over an inline token:

```json
{
  "mcpServers": {
    "remote": {
      "url": "https://mcp.example.com/mcp",
      "transport": "streamable-http",
      "protocolVersion": "auto",
      "auth": "bearer",
      "bearerTokenEnv": "MCP_REMOTE_TOKEN",
      "headers": {
        "X-Client": "letta-code"
      }
    }
  }
}
```

Run Letta Code with `MCP_REMOTE_TOKEN` in the environment, then:

```text
/lmcp reconnect remote
```

Streamable HTTP is the only HTTP transport. Omitting `transport`, using
`"auto"`, or using `"streamable-http"` all select it. The deprecated `"sse"`
value emits a warning and is treated as Streamable HTTP; there is no SSE
fallback.

`protocolVersion` controls MCP protocol negotiation for both HTTP and stdio
servers:

- `"legacy"` (the default) connects without a discovery probe.
- `"auto"` discovers modern protocol support and falls back to legacy when
  appropriate.
- `"2026-07-28"` requires that modern protocol version.

Successful negotiation is cached with the server configuration, so later
connections can skip redundant discovery. Changing connection configuration
invalidates that result.

### OAuth authorization-code server

Use authorization-code OAuth for user login flows:

```json
{
  "mcpServers": {
    "linear": {
      "url": "https://mcp.linear.app/mcp",
      "auth": "oauth",
      "oauth": {
        "grantType": "authorization_code",
        "clientId": "${LINEAR_CLIENT_ID}",
        "clientSecret": "$env:LINEAR_CLIENT_SECRET",
        "redirectUri": "http://127.0.0.1:3334/callback",
        "scope": "read write",
        "clientName": "Letta MCP Adapter"
      }
    }
  }
}
```

Client identity is selected in this order:

1. configured `clientId` (pre-registered client);
2. `clientMetadataUrl` when the authorization server advertises CIMD support;
3. Dynamic Client Registration as a compatibility fallback.

`clientMetadataUrl` must be an HTTPS URL with a non-root path. DCR registrations
identify this loopback-redirect client as a native application.

Start login:

```text
/lmcp auth-start linear
```

Open the returned authorization URL in a browser. After login, copy the full redirected URL and run:

```text
/lmcp auth-complete linear <full redirected URL>
```

Check local auth state:

```text
/lmcp auth-status linear
```

Clear stored OAuth material:

```text
/lmcp auth-clear linear
```

Finally refresh metadata:

```text
/lmcp reconnect linear
```

### OAuth client credentials

Use client credentials for machine-to-machine OAuth servers:

```json
{
  "mcpServers": {
    "machine": {
      "url": "https://mcp.example.com/mcp",
      "auth": "oauth",
      "oauth": {
        "grantType": "client_credentials",
        "clientId": "${MCP_CLIENT_ID}",
        "clientSecret": "$env:MCP_CLIENT_SECRET",
        "audience": "https://mcp.example.com",
        "scope": "read"
      }
    }
  }
}
```

The token endpoint is discovered from protected-resource and authorization-server
metadata. `tokenUrl` is no longer required or used as the source of truth.

Fetch and store a token:

```text
/lmcp auth-start machine
```

Then refresh metadata:

```text
/lmcp reconnect machine
```

### Optional direct tools

By default, only `search_tools` and `call_tool` are registered. Direct MCP tools are opt-in and are registered from the local metadata cache during mod activation.

Enable all cached tools globally:

```json
{
  "settings": {
    "directTools": true,
    "toolPrefix": "server"
  },
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    }
  }
}
```

Enable direct tools for only one server:

```json
{
  "settings": {
    "directTools": false
  },
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "directTools": true
    }
  }
}
```

Allow-list specific direct tools:

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "directTools": ["search_repositories", "get_file_contents"]
    }
  }
}
```

Filter a noisy server's catalog with glob selectors:

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "includeTools": ["search_*", "get_*", "create_issue"],
      "excludeTools": ["get_*_secret"]
    }
  }
}
```

`includeTools` filters first; `excludeTools` then removes matches and wins on
overlap. The same filtered catalog is used by search, describe, `call_tool`,
resources, and direct-tool registration.

Direct-tool workflow:

1. Configure the server.
2. Run `/lmcp reconnect <server>` to cache metadata.
3. Run `/reload` so Letta Code reactivates the mod and registers direct tools from the cache.

`toolPrefix` controls names returned by `search_tools` and used for direct tools:

- `"server"` (default): `github_search_repositories`
- `"short"`: strips a trailing `-mcp` from the server name before prefixing
- `"none"`: uses original MCP tool names when they are valid and non-conflicting

## `/lmcp` command reference

| Command | Purpose |
| --- | --- |
| `/lmcp` | Show MCP adapter status. |
| `/lmcp status` | Same as `/lmcp`. Shows configured server/cache state and hints. |
| `/lmcp tools` | List cached MCP tools and resource-backed synthetic tools. Does not connect. |
| `/lmcp reconnect` | Connect to every configured server sequentially and refresh metadata cache. |
| `/lmcp reconnect <server>` | Connect to one server and refresh its metadata cache. |
| `/lmcp auth-start <server>` | Start OAuth login, or fetch a client-credentials token for that server. |
| `/lmcp auth-complete <server> <redirectUrl>` | Complete authorization-code OAuth with a copied redirected URL. |
| `/lmcp auth-status <server>` | Show whether local OAuth tokens/client info/pending auth/discovery state exist. |
| `/lmcp auth-clear <server>` | Clear stored OAuth material for a server. |
| `/lmcp setup` | Show config paths and an example `.mcp.json`. |
| `/lmcp setup create` | Create a starter project `.mcp.json` if one does not already exist. |
| `/lmcp help` | Show command usage. |

The command may open a short transient panel when Letta Code exposes panel UI support. Full details remain in command output.

## Model-facing tool quick reference

The model surface follows a discover-then-call workflow:

```ts
search_tools({
  query: string,
  limit?: number // 1-50; defaults to 10
})

call_tool({
  name: string,
  args: Record<string, unknown>,
  maxOutput?: number // 1,000-1,000,000 characters for this call
})
```

For example:

```ts
const matches = search_tools({ query: "read a file" })

call_tool({
  name: "filesystem_read_file",
  args: { path: "README.md" }
})
```

`search_tools` refreshes missing or stale metadata as needed and returns bounded, ranked results with callable names, tool titles, read-only/destructive hints, descriptions, and full argument schemas. If one integration is unavailable, usable results from other integrations are still returned with a concise failure note.

`call_tool` accepts the callable name returned by search and a normal object matching that result's schema. It connects lazily and supports stdio, HTTP, and synthetic resource tools through the same interface.

On MCP 2026-07-28 connections, both explicit `resultType: "complete"` and
compatibility results without a discriminator use the normal output path.
`input_required` results are intercepted before rendering or output spilling.
Letta Code 0.31.5 does not expose an interactive form/input API to a running mod
tool, so the adapter stops that call with a concise explanation rather than
displaying or retaining opaque continuation state.

Setup, status, explicit reconnects, and OAuth are intentionally human-facing `/lmcp` operations rather than model tool modes.

## Metadata cache behavior

The adapter persists tool/resource metadata and negotiated protocol discovery, but MCP servers control freshness:

- `ttlMs` is honored without background polling. Expired metadata refreshes at the next lazy search, resolution, or explicit reconnect.
- `cacheScope: "public"` metadata can be reused across authenticated principals for the same server configuration.
- `cacheScope: "private"` metadata is partitioned by a one-way fingerprint of the effective bearer identity or OAuth issuer and subject. Raw credentials are never written to the metadata cache.
- Live `notifications/tools/list_changed` events invalidate the active disk entry. An unknown-tool or invalid-params call error refreshes the catalog without replaying the failed tool call.
- Legacy servers without cache hints retain the adapter's seven-day fallback.

The version 2 cache format is a clean replacement. Older cache files are ignored and rebuilt lazily; run `/lmcp reconnect` to rebuild immediately.

## Output guard and retained results

Every MCP tool and resource result is measured after its complete model-facing output has been assembled. Results up to 40,000 characters are returned unchanged by default. Larger results return a bounded preview and a path to the complete private artifact:

```text
Output truncated (82431 chars). Full result: ~/.letta/mcp-adapter/results/<server>/<tool>-<timestamp>.txt. Use the file tools to read more.
```

Actual paths are absolute. Text spills use `.txt`; structured results use complete `.json`; oversized image, audio, and resource blobs are decoded to MIME-appropriate files rather than placing base64 in model context. Direct tools and synthetic resource tools use the same guard.

Set a project or global default in MCP configuration:

```json
{
  "settings": {
    "outputGuard": {
      "maxChars": 40000,
      "maxFiles": 100,
      "maxAgeMs": 604800000
    }
  },
  "mcpServers": {}
}
```

- `maxChars` must be between 1,000 and 1,000,000.
- `maxFiles` defaults to 100 retained artifacts.
- `maxAgeMs` defaults to 7 days.
- `call_tool.maxOutput` overrides `maxChars` for one call and is not passed to the MCP server.
- Spill directories and files are created with private permissions. Retention cleanup is best-effort and runs after a spill.

## Permission behavior

The mod registers a permission overlay when Letta Code exposes the permissions API. `call_tool` and direct tools declare `requiresApproval: true`; the overlay supplies more precise allow/ask/deny decisions. `search_tools` is read-only from the model's perspective and does not require approval.

Default behavior:

- Tool search is allowed.
- Known tool calls are allowed unless they look risky.
- Tools marked `readOnlyHint: true` by the MCP server are allowed without the name heuristic, subject to the independent path-boundary check.
- Tools marked `destructiveHint: true` ask.
- Tools matched by `approveTools` ask even if the server marks them read-only.
- An uncached call attributable to a configured server asks before lazy connection; an ambiguous unknown target is denied.
- Tool names containing words like `delete`, `write`, `update`, `exec`, `run`, `shell`, or `browser` ask by default.
- Tool arguments with path-like keys (`path`, `file`, `dir`, `cwd`, `target`, `destination`, etc.) ask if they resolve outside the current working directory.
- Direct tools use the same risk checks as `call_tool`.
- A human approval authorizes one execution with that tool-call ID and exact argument payload. Reuse or changed arguments are denied.

Require approval for selected tools globally or per server:

```json
{
  "settings": {
    "approveTools": ["mcp/github.create_*", "filesystem__write_*"],
    "approval": {
      "dangerousTools": "ask",
      "unknownServers": "deny",
      "configWrites": "alwaysAsk"
    }
  },
  "mcpServers": {
    "database": {
      "command": "database-mcp",
      "approveTools": true
    },
    "readonly": {
      "command": "readonly-mcp",
      "approveTools": []
    }
  }
}
```

Per-server `approveTools` overrides the global value. `true` matches every tool;
`false` or an empty array matches none. String selectors support `*` and `?`
and can use original names (`create_issue`), exposed names
(`github_create_issue`), the `server__tool` form from the issue, or canonical
keys such as `mcp/github.create_issue`.

Valid decisions are `allow`, `ask`, `alwaysAsk`, and `deny`.

Notes:

- `dangerousTools` controls dangerous-looking tool names and path arguments outside the working directory.
- `unknownServers` controls model calls that cannot be attributed safely to configured metadata.
- `configWrites` is reserved for future model-callable config-write operations; the current `/lmcp setup create` command is human-invoked.

Letta Code 0.31.5 does not expose the approval UI's selected persistence scope
to permission mods and does not expose custom mod event emission. The adapter
therefore enforces exact-argument, once-only approvals. Session grants and a
claimable cross-mod approval-broker event require a future public Letta host API;
the adapter does not broaden a one-time approval implicitly.

## UI and resources

When Letta Code exposes status values, the mod registers a compact `mcp` status value that summarizes configured servers, cached tools, stale/missing cache, and warnings. Set `settings.ui.status` to `false` to disable this status value.

MCP tool titles, annotations, output schemas, icons, and UI resource hints such as `_meta["openai/outputTemplate"]` / `_meta.uiResourceUri` are preserved in cached metadata. Titles, safety hints, and UI resources are surfaced by `search_tools` and `/lmcp tools`. Text resources returned from MCP calls are rendered in output; binary/blob resources are summarized rather than dumped.

## Safety and limitations

- Activation does not eagerly connect to MCP servers.
- `search_tools` may start configured stdio processes or make configured network requests when metadata is missing or stale; these connections are opened only on demand.
- Search results are bounded to 50 and default to 10.
- Tool and resource results are bounded to 40,000 characters by default; complete oversized results are retained under `~/.letta/mcp-adapter/results/`.
- OAuth authorization and token requests are bound to the MCP resource, callback issuers are validated, and discovered clients/tokens are isolated by authorization-server issuer. Authorization-code HTTP transports support the SDK's one-retry scope step-up; client-credentials transports fail instead of opening an interactive flow.
- OAuth state and credentials currently remain in mode-0600 files under `~/.letta/mcp-adapter/auth/`. The adapter's supported installation is one `.mjs` mod file, while OS keychain packages require native companion binaries and Letta Code 0.31.5 does not expose a shared persistent secret API to mod commands/background connections. Use environment interpolation for configured client secrets and `bearerTokenEnv` for static bearer tokens. Native keychain storage requires a supported package-based mod deployment or host secret API.
- Sampling and elicitation settings are reserved but not advertised to MCP servers yet. The current Letta mod API does not provide a safe scoped conversation/form-input mechanism inside manager-owned MCP request handlers. If a server returns `input_required` without the necessary advertised capability, the adapter reports the unsupported flow without retaining its opaque state.
- The adapter does not advertise the modern `io.modelcontextprotocol/tasks` extension. `@modelcontextprotocol/client@2.0.0` rejects task-discriminated `tools/call` results and does not expose the extension's `tasks/get`, `tasks/update`, and `tasks/cancel` flow ([upstream tracker](https://github.com/modelcontextprotocol/typescript-sdk/issues/2189)). A nonconforming server that returns a task without opt-in receives a task-specific compatibility error; no task ID is exposed or polled.
- Secrets should be provided via environment variables. Do not commit `.env`, bearer tokens, OAuth client secrets, or generated auth stores.
