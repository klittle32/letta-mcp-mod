# Letta MCP Adapter Mod

A Letta Code mod that exposes MCP servers through one compact `mcp` proxy tool, with optional cache-backed direct tools. The adapter is designed to avoid dumping every MCP tool schema into the model context while still letting agents connect to servers, refresh metadata, search tools, describe schemas, and call MCP tools on demand.

## What this mod provides

- A compact model-callable `mcp` tool for status, search, describe, connect, OAuth, and tool calls.
- A human `/lmcp` slash command for setup, status, cached tool listing, reconnects, and OAuth actions.
- Lazy MCP connections: activation reads local config/cache but does not start MCP server processes or perform HTTP MCP network work.
- Metadata caching under `~/.letta/mcp-adapter/cache.json`.
- Stdio, streamable HTTP, and SSE MCP transports.
- HTTP bearer auth and OAuth authorization-code / client-credentials flows.
- Optional direct tool registration from cache only.
- Guarded Letta permission overlay plus status/panel UI integration when the host supports it.

## Requirements

- Letta Code with local mod support.
- Bun for local development/builds.
- Node.js available for stdio MCP servers that use Node commands.

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

You can force SSE instead with `"transport": "sse"`. If omitted or set to `"auto"`, the adapter tries streamable HTTP and falls back to SSE.

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
        "tokenUrl": "https://auth.example.com/oauth/token",
        "audience": "https://mcp.example.com",
        "scope": "read"
      }
    }
  }
}
```

Fetch and store a token:

```text
/lmcp auth-start machine
```

Then refresh metadata:

```text
/lmcp reconnect machine
```

### Optional direct tools

By default, only the compact `mcp` proxy tool is registered. Direct MCP tools are opt-in and are registered from the local metadata cache during mod activation.

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

Direct-tool workflow:

1. Configure the server.
2. Run `/lmcp reconnect <server>` to cache metadata.
3. Run `/reload` so Letta Code reactivates the mod and registers direct tools from the cache.

`toolPrefix` controls direct/proxy exposed names:

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

## Model-facing `mcp` proxy quick reference

The agent-facing proxy accepts a small object:

```ts
mcp({
  search?: string,
  regex?: boolean,
  includeSchemas?: boolean,
  describe?: string,
  server?: string,
  connect?: string,
  tool?: string,
  args?: string,
  action?: "auth-start" | "auth-complete" | "auth-status" | "auth-clear"
})
```

Examples:

```ts
// Status from local config/cache only
mcp({})

// Refresh metadata for one server
mcp({ connect: "filesystem" })

// Search cached metadata
mcp({ search: "read file", includeSchemas: false })

// Bounded regex search against cached names/descriptions
mcp({ search: "/read|list/i", regex: true, includeSchemas: false })

// Describe a cached tool schema
mcp({ describe: "filesystem_read_file" })

// Call an MCP tool. args must be a JSON string.
mcp({ tool: "filesystem_read_file", args: "{\"path\":\"README.md\"}" })

// OAuth actions
mcp({ action: "auth-status", server: "linear" })
mcp({ action: "auth-clear", server: "linear" })
```

Mode precedence is:

```text
action > tool > connect > describe > search > server > status
```

## Permission behavior

The mod registers a permission overlay when Letta Code exposes the permissions API. The compact `mcp` tool and direct tools also declare `requiresApproval: true`; the overlay supplies more precise allow/ask/deny decisions.

Default behavior:

- Read-only status, search, describe, cached server listing, and `/lmcp tools` are allowed.
- Connecting or reconnecting a configured server asks, because it may start a process or make network requests.
- Unknown live targets are denied by default.
- `auth-status` is allowed because it only reports local state.
- `auth-start`, `auth-complete`, and `auth-clear` ask because they change authentication state or stored credentials.
- Cached tool calls are allowed unless they look risky.
- Tool names containing words like `delete`, `write`, `update`, `exec`, `run`, `shell`, or `browser` ask by default.
- Tool arguments with path-like keys (`path`, `file`, `dir`, `cwd`, `target`, `destination`, etc.) ask if they resolve outside the current working directory.
- Direct tools use the same risk checks as proxy tool calls.
- If a risky call was approved in the approval phase but reaches execution with changed args, it is denied.

Tune permission defaults with `settings.approval`:

```json
{
  "settings": {
    "approval": {
      "dangerousTools": "ask",
      "unknownServers": "deny",
      "configWrites": "alwaysAsk"
    }
  },
  "mcpServers": {}
}
```

Valid decisions are `allow`, `ask`, `alwaysAsk`, and `deny`.

Notes:

- `dangerousTools` controls dangerous-looking tool names and path arguments outside the working directory.
- `unknownServers` controls attempts to connect/list/call unknown servers.
- `configWrites` is reserved for future model-callable config-write operations; the current `/lmcp setup create` command is human-invoked.

## UI and resources

When Letta Code exposes status values, the mod registers a compact `mcp` status value that summarizes configured servers, cached tools, stale/missing cache, and warnings. Set `settings.ui.status` to `false` to disable this status value.

MCP UI resource hints such as `_meta["openai/outputTemplate"]` / `_meta.uiResourceUri` are preserved in cached metadata and surfaced in list/search/describe output. Text resources returned from MCP calls are rendered in output; binary/blob resources are summarized rather than dumped.

## Safety and limitations

- Activation does not eagerly connect to MCP servers.
- Search/list/describe operate from local cache only.
- Regex search is bounded by pattern length and defaults to a 200-character maximum. Override with `settings.regexSearch.maxPatternLength` if needed.
- Sampling and elicitation settings are reserved but not advertised to MCP servers yet. The current Letta mod API does not provide a safe scoped conversation/form-input mechanism inside manager-owned MCP request handlers.
- Secrets should be provided via environment variables. Do not commit `.env`, bearer tokens, OAuth client secrets, or generated auth stores.
