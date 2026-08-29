# Milestone 4: metadata and cache semantics

Status: approved for implementation by the Milestone 4 request.

## Objective

Bring the adapter's persisted metadata cache up to the MCP 2026-07-28
semantics introduced by the SDK 2 foundation, while preserving the lazy,
context-efficient behavior established in Milestone 1.

This milestone implements:

- [Issue #5](https://github.com/klittle32/letta-mcp-mod/issues/5):
  `ttlMs`, `cacheScope`, authenticated-principal isolation, and stale-catalog
  invalidation.
- [Issue #9](https://github.com/klittle32/letta-mcp-mod/issues/9): richer tool
  metadata and annotation-aware discovery and approvals.

The roadmap intentionally combines these issues because both replace the
persisted cache format. Existing version 1 cache files will be rejected and
rebuilt lazily; backward compatibility is not a project constraint.

## Repository and SDK evidence

- `src/core/cache.ts` currently stores one version 1 entry per server and
  applies the same seven-day age limit to every entry.
- `src/mcp/metadata.ts` currently discards list-level `ttlMs` and
  `cacheScope`, and retains only tool name, description, input schema, and UI
  resource metadata.
- `src/features/tool-catalog.ts` searches names and descriptions but not
  titles.
- `src/features/permissions.ts` infers risk only from names and paths.
- SDK 2 already:
  - exposes list freshness and scope;
  - supports `notifications/tools/list_changed` callbacks;
  - supports `cacheMode: "refresh"` for explicit list refreshes; and
  - mirrors `x-mcp-header` arguments when `Client.callTool` receives the
    cached tool definition.

Therefore the adapter should persist and select its own cross-session cache,
while delegating wire-level schema/header behavior to SDK 2 rather than
reimplementing it.

## Design

### 1. Replace cache version 1 with scoped version 2

Each configured server will have a bucket containing:

- at most one `public` entry, reusable across authenticated principals; and
- zero or more `private` entries keyed by a one-way auth-identity hash.

Every cache entry retains `configHash`, `cachedAt`, tools, resources, and
protocol negotiation, and adds `ttlMs` and `cacheScope`.

The config hash will continue to cover connection and catalog-shaping
configuration, but authentication secrets will move out of it. Private cache
selection will use a separate SHA-256 identity:

- bearer authentication: the effective bearer token;
- an explicit `Authorization` header: the effective header value;
- OAuth: issuer plus JWT subject when available, with a token fingerprint as
  the safe fallback for opaque tokens; and
- unauthenticated access: an anonymous identity.

Raw credentials will never be written to the metadata cache.

The selected tool/resource lists share one entry. Their cache policy is merged
conservatively: `private` wins over `public`, and the shortest reported TTL
wins. Missing legacy hints retain the existing seven-day fallback. A reported
zero TTL means immediately stale.

### 2. Make cache selection one coherent operation

Callers will stop indexing `cache.servers[name]` directly. Cache helpers will
select the public or current-principal private entry, validate its config hash
and TTL, update the matching scope, and invalidate that exact entry.

This keeps identity and scope rules in the cache module rather than
duplicating them in the catalog and runtime.

### 3. Refresh only at lazy boundaries

No polling or timers will be added.

- Search and target resolution already refresh servers whose selected cache
  is missing or stale; TTL expiry will feed that existing path.
- Explicit metadata refreshes will use SDK `cacheMode: "refresh"` so the
  adapter does not accidentally re-persist a stale in-memory SDK result.
- A live `tools/list_changed` notification will invalidate the selected disk
  entry. The next lazy operation will repopulate it.
- An invalid-params/unknown-tool protocol error from `tools/call` will trigger
  one metadata refresh before returning the original call error. The tool call
  will not be replayed.

The no-replay rule preserves the existing safety invariant that only
read-only metadata operations are retried.

### 4. Preserve richer tool definitions

`CachedTool` and `ToolMetadata` will retain:

- `title`;
- `annotations`;
- `outputSchema`; and
- `icons`.

Annotation objects will be validated during ingestion. A tool with a
non-object annotation set, unknown annotation keys, or non-boolean hint values
will be dropped and reported through the existing warning/diagnostic path.
Input and output schemas will be preserved as opaque JSON Schema values; the
adapter will not impose draft-07 validation.

Titles will participate in search ranking and appear in search/list output.
Search output will include concise read-only/destructive labels when those
hints are present. Output schemas and icons are persisted for calls and future
rendering, but this milestone will not introduce a new result-rendering format.

### 5. Apply annotation-aware approval defaults

For both proxy and direct calls:

1. `destructiveHint: true` requires `alwaysAsk`;
2. paths outside the working directory retain the existing dangerous-tool
   policy;
3. `readOnlyHint: true` is allowed without the name heuristic; and
4. unannotated tools retain the current dangerous-name fallback.

This makes trusted server metadata more precise without allowing a read-only
hint to bypass the adapter's independent path-boundary guard.

### 6. Use SDK 2 for `x-mcp-header`

Calls will pass the selected cached tool definition to SDK 2's
`toolDefinition` request option. This enables SDK-managed `Mcp-Param-*`
mirroring even on a new connection restored from the adapter's disk cache,
and also enables SDK output-schema validation. The adapter will not maintain a
second header/schema implementation.

## Expected file scope

- `src/core/cache.ts`: version 2 model, scoped selection, TTL, writes, and
  invalidation.
- `src/core/tool-names.ts`: richer tool metadata.
- `src/mcp/cache-identity.ts`: credential fingerprint derivation.
- `src/mcp/metadata.ts`: list policy capture and metadata validation.
- `src/mcp/manager.ts`: SDK list-change callback wiring.
- `src/runtime.ts`: identity-aware cache use, explicit refresh, invalidation,
  stale-call refresh, and `toolDefinition`.
- `src/features/tool-catalog.ts`: scoped entry selection, title search, and
  richer display.
- `src/features/direct-tools.ts` and `src/features/permissions.ts`:
  annotation propagation and policy.
- Focused tests under `tests/`, fixture updates where protocol metadata or
  notifications are needed, and user-facing documentation describing cache
  freshness and metadata behavior.

## Alternatives not chosen

- **Keep one entry per server and include the token in `configHash`:** prevents
  accidental reuse but cannot share public entries and does not represent the
  protocol's scope rule.
- **Separate tool and resource cache files:** more precise, but unnecessary
  complexity while the adapter consumes both lists as one catalog snapshot.
  Conservative policy merging is safe and simpler.
- **Refresh immediately inside the list-change callback:** adds background
  network work and races disk writes. Invalidation followed by the existing
  lazy refresh is aligned with the product.
- **Replay a failed tool call after refreshing metadata:** risks duplicate
  side effects. Refreshing the catalog without replay is the safe recovery.
- **Implement `x-mcp-header` locally:** duplicates SDK 2 protocol code and
  would drift from its validation and retry behavior.

## Verification and done conditions

Milestone 4 is done when:

1. Version 1 cache files fail closed and rebuild lazily as version 2.
2. TTL expiry marks entries stale, including `ttlMs: 0`; missing legacy TTLs
   retain the fallback age.
3. A private entry written under one bearer/OAuth identity is not visible to
   another, while a public entry is reusable.
4. A tools-list change invalidates the active persisted entry.
5. Invalid-params/unknown-tool call failures refresh metadata without
   replaying the call.
6. Valid richer metadata round-trips through discovery, disk, state, search,
   direct tools, and calls; invalid annotations drop the affected tool and
   produce a warning.
7. Titles affect search/list output, and annotations drive proxy and direct
   approval defaults.
8. A modern Streamable HTTP call mirrors an `x-mcp-header` value through SDK
   2 when starting from disk-cached metadata.
9. Focused cache, metadata, catalog, permissions, runtime, and HTTP tests
   pass, followed by the full test suite, typecheck, and production build.
