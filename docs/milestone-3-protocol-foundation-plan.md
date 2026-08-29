# Milestone 3: Protocol Foundation Plan

Status: approved for implementation

This plan implements:

- [Issue #4](https://github.com/klittle32/letta-mcp-mod/issues/4): migrate
  to the stable modular MCP SDK 2 packages and add protocol-version
  negotiation.
- [Issue #7](https://github.com/klittle32/letta-mcp-mod/issues/7): make
  Streamable HTTP the only HTTP transport and remove SSE fallback behavior.

The project permits breaking changes. This milestone therefore replaces the
old SDK and transport contract directly rather than carrying compatibility
modes.

## Repository Baseline

- `package.json` currently depends on the monolithic
  `@modelcontextprotocol/sdk` 1.x package.
- `src/mcp/manager.ts` constructs the 1.x client and implements its own
  Streamable HTTP to SSE fallback.
- `src/mcp/metadata.ts` manually follows pagination cursors.
- `src/core/config.ts` and `src/mcp/http.ts` accept `transport: "sse"`.
- `src/core/cache.ts` caches server metadata by configuration hash, but not
  negotiated protocol information.
- HTTP, OAuth, and stdio test fixtures use the 1.x server SDK.

## Verified SDK 2 Contract

The stable modular packages are available at version 2.0.0:

- `@modelcontextprotocol/client`
- `@modelcontextprotocol/core`
- `@modelcontextprotocol/server`

SDK 2 requires Node 20 or newer and Zod 4.2 or newer. Its client supports:

- `versionNegotiation.mode` values of `legacy`, `auto`, or a pinned version;
- passing cached `PriorDiscovery` to `Client.connect`;
- reading the negotiated protocol era, version, and discovery result after
  connection;
- automatic list pagination; and
- corrective continuation after an `UnsupportedProtocolVersion` response.

Issue #4 described an automatic pagination default of 10 pages. The released
SDK 2 default is 64 pages, so this adapter will set `listMaxPages: 10`
explicitly to preserve the issue's intended bound.

The SDK, rather than adapter-owned retry code, will own protocol probing and
the corrective `-32022` negotiation exchange. Adapter tests will verify the
observable result.

## Product and Configuration Contract

### Protocol version

Each server may specify:

```json
{
  "protocolVersion": "legacy"
}
```

Allowed values are:

- `legacy` — use the established MCP protocol directly;
- `auto` — let SDK 2 discover whether the server supports the modern
  protocol; or
- `2026-07-28` — pin the modern protocol version.

The default is `legacy`. This preserves interoperability without adding a
network probe to every existing server. It is an SDK/protocol default, not a
v0.1 compatibility promise.

Invalid values produce a configuration warning and fall back to `legacy`.

### HTTP transport

- `streamable-http` is the only HTTP transport.
- `auto` remains accepted as a convenience spelling for Streamable HTTP; it
  no longer means transport fallback.
- A configured `sse` value produces a deprecation warning and is normalized
  to `streamable-http`.
- The adapter will not construct an SSE transport or make an SSE fallback
  attempt.
- Authentication and custom headers remain supported through the Streamable
  HTTP transport.

## Implementation

### 1. Adopt the modular SDK

- Replace `@modelcontextprotocol/sdk` with
  `@modelcontextprotocol/client` and `@modelcontextprotocol/core`.
- Add `@modelcontextprotocol/server` for test fixtures.
- Add Zod 4.2 and declare Node 20 as the minimum runtime.
- Update client, transport, OAuth, and protocol type imports.
- Update changed request signatures and server-fixture APIs.

The production bundle remains a single `.mjs` file.

### 2. Centralize negotiation in the connection manager

`McpConnectionManager` will:

- map each server's `protocolVersion` setting to SDK 2
  `versionNegotiation`;
- set the adapter's list-page bound;
- pass valid cached discovery to `Client.connect`;
- expose the successful connection's negotiated era, version, and discovery
  data; and
- rely on SDK 2 for probing, fallback to legacy, and corrective protocol
  negotiation.

Stdio and Streamable HTTP will use the same version-negotiation rule.

### 3. Cache negotiation results

The per-server cache entry will optionally store:

- negotiated era (`legacy` or `modern`);
- negotiated protocol version; and
- the modern discovery response when applicable.

The runtime will supply this data as `PriorDiscovery` only when the existing
cache freshness and configuration-hash checks pass. Changing
`protocolVersion`, transport details, credentials, command, arguments, or
other hashed connection settings invalidates the cached negotiation result.

Successful connections update the negotiation record without discarding
cached tools and resources. Existing cache files without the optional record
remain readable.

### 4. Remove adapter-owned SSE behavior

- Remove the SSE client import and construction path.
- Remove Streamable HTTP to SSE fallback.
- Remove SSE-only header merging code and fixtures.
- Normalize deprecated `sse` configuration during validation.
- Update status and documentation to describe only stdio and Streamable HTTP.

### 5. Use SDK-owned pagination and modern request signatures

- Replace manual list cursor loops with SDK 2's aggregated `listTools` and
  `listResources` results.
- Preserve cancellation and timeouts.
- Adapt `callTool` to the SDK 2 request signature.

### 6. Handle dropped connections safely

Read-only metadata discovery may be retried once after a transport-level
disconnect, using a newly issued request. Mutating `tools/call` operations
will not be replayed automatically because the server may have completed the
side effect before the connection dropped.

When a call loses its connection, the stale manager entry will be closed so a
later call reconnects and receives a new request ID. The original call still
returns a concise failure instead of risking duplicate execution.

## Focused Verification

Tests will demonstrate:

1. Legacy is the default negotiation mode.
2. `auto` performs discovery on a cold cache and reuses valid cached discovery
   on a later connection.
3. A configuration change invalidates cached discovery.
4. A pinned modern connection completes the SDK's corrective version exchange
   after `-32022`.
5. Streamable HTTP and stdio both list and call tools through SDK 2.
6. `auto` makes no SSE fallback attempt.
7. Deprecated `sse` configuration warns and runs as Streamable HTTP.
8. Custom and authorization headers reach a modern HTTP server.
9. Read-only discovery can recover from a dropped response with a new request.
10. A dropped tool call is not transparently duplicated, and the following
    call reconnects.
11. OAuth compiles and its existing focused tests still pass with SDK 2.
12. The complete test suite, TypeScript check, and production bundle build
    pass on the declared Node runtime.

## Done Conditions

Milestone 3 is complete when:

- no source or fixture imports the monolithic SDK package or SSE transport;
- the adapter negotiates according to the documented per-server setting;
- valid negotiation results bypass redundant probing and invalid results do
  not;
- HTTP uses Streamable HTTP exclusively;
- SDK 2 pagination and request APIs are in use;
- focused negotiation, cache, transport, reconnect, and header tests pass; and
- full tests, typecheck, and build pass.
