# Milestone 5: Registry approval policy

## Objective

Implement the registry-owned approval policy from
[issue #11](https://github.com/klittle32/letta-mcp-mod/issues/11) for both
`call_tool` and cache-backed direct tools, using only Letta Code's public mod
APIs.

This milestone adds:

- global and per-server `approveTools` selectors;
- glob matching against original, exposed, and canonical MCP tool names;
- exact-argument approval tracking from Letta's approval phase to execution;
- annotation-aware defaults;
- `includeTools` with the same selector behavior as `excludeTools`;
- consistent filtering in search, describe, proxy calls, and direct tools.

## Repository evidence

- `src/features/permissions.ts` already owns policy for both `call_tool` and
  direct tools. Its `ApprovalTracker` binds an approval to the Letta tool-call
  ID and a stable fingerprint of the arguments, then consumes that approval
  once during execution.
- `src/core/tool-names.ts` centralizes exposed-name formatting and exact
  `excludeTools` matching. It is the appropriate source of truth for selector
  candidates and glob behavior.
- `src/core/cache.ts` reconstructs the catalog used by search, calls, and
  direct-tool registration. Applying include/exclude there gives every surface
  the same visible tool set.
- Milestone 4 preserved MCP `readOnlyHint` and `destructiveHint` in cached tool
  metadata, so policy no longer needs to infer every risk from a tool name.
- The reference `pi-mcp-adapter` uses server-level `approveTools` in preference
  to its global setting, applies `excludeTools` after `includeTools`, and matches
  selectors against original and exposed names.

## Letta host boundary

The installed Letta Code 0.31.5 public API was checked against:

- `skills/creating-mods/references/permissions.md`;
- `skills/creating-mods/references/events.md`;
- `dist/types/mods/types.d.ts`.

Facts from that API:

1. A permission overlay can return `allow`, `ask`, `alwaysAsk`, or `deny`.
2. It runs once for approval classification and again before execution.
3. An execution-phase `ask` cannot reopen the approval UI.
4. The permission event does not report whether the human selected a one-time
   or persisted approval.
5. Mods can subscribe to a fixed set of lifecycle/tool/turn events, but cannot
   emit a custom approval event.
6. The mod UI API has panels and status values, but no prompt/select API.

Consequently, this repository can safely enforce **allow once**: Letta asks the
human, and the overlay allows exactly one execution only when its tool-call ID
and complete argument payload match. It cannot distinguish “once” from
“session” or expose a claimable approval-broker event through a public Letta
API. Treating every approval as a session grant would silently broaden user
consent, so this plan does not do that.

Session grants and cross-mod approval brokering remain explicit upstream host
dependencies. They are done only when Letta exposes either:

- the selected approval scope plus a safe tool/argument grant key; or
- a public interactive approval/broker API with `once | session | deny`
  results.

## Decisions

### Selector semantics

- `approveTools` accepts `true` or a string array globally under `settings` and
  per server.
- A per-server value overrides the global value, including `false` or `[]`.
- `includeTools` and `excludeTools` are per-server string arrays.
- Selectors support `*` and `?`; all other characters are literal.
- Selectors match:
  - the original MCP name;
  - the configured exposed name;
  - full and short prefixed names;
  - the issue's `server__tool` form;
  - the canonical `mcp/server.tool` key.
- Hyphens and underscores remain equivalent, matching existing lookup behavior.
- `includeTools` is applied first. `excludeTools` is applied second and wins.

### Approval precedence

For a resolved tool:

1. Path-boundary policy still applies; metadata cannot weaken it.
2. An explicit `approveTools` match asks.
3. `destructiveHint: true` asks.
4. `readOnlyHint: true` allows.
5. The existing dangerous-name fallback follows `approval.dangerousTools`.
6. Other tools allow.

An unresolved but attributable tool still asks for metadata refresh. An
unattributable tool still follows the existing fail-closed behavior.

`ask`, rather than `alwaysAsk`, is the annotation default required by issue
#11. A user-configured `alwaysAsk` remains available through
`settings.approval.dangerousTools`.

## Implementation steps

1. Extend config types with global/per-server `approveTools` and per-server
   `includeTools`.
2. Replace exact exclusion matching with one centralized selector matcher and
   add `isToolAllowed`.
3. Apply inclusion followed by exclusion during cache reconstruction and add
   `includeTools` to the metadata cache identity.
4. Resolve effective approval selectors in the permission overlay and apply the
   same policy function to proxy and direct calls.
5. Keep the existing tool-call/argument fingerprint as the secure once-only
   bridge between Letta's approval and execution phases.
6. Update configuration and permission documentation, including the current
   host limitation.

## Focused completion evidence

- Selector tests cover exact names, globs, canonical names, normalization,
  include-before-exclude, and exclusion precedence.
- Cache tests prove filtered tools/resources are absent and filter changes
  invalidate metadata reconstruction.
- Permission tests cover global and server override patterns, proxy/direct
  parity, destructive/read-only defaults, deny policy, once-only consumption,
  and argument mutation denial.
- Existing config, cache, direct-tool, proxy, command, transport, OAuth, build,
  and type-check suites remain green.

## Files expected to change

- `src/core/config.ts`
- `src/core/tool-names.ts`
- `src/core/cache.ts`
- `src/features/permissions.ts`
- `tests/tool-names.test.ts`
- `tests/cache.test.ts`
- `tests/permissions.test.ts`
- `README.md`

