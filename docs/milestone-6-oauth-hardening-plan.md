# Milestone 6: OAuth hardening

## Objective

Implement the adapter-owned OAuth protections from
[issue #8](https://github.com/klittle32/letta-mcp-mod/issues/8) on top of the
MCP SDK 2 protocol foundation:

- bind authorization and token requests to the MCP resource;
- validate authorization-response issuers;
- isolate discovered clients and tokens by authorization-server issuer;
- prefer configured clients, then Client ID Metadata Documents (CIMD), then
  Dynamic Client Registration (DCR);
- enable bounded authorization-code scope step-up;
- verify protected-resource and authorization-server discovery behavior.

The existing v0.1 OAuth storage format is not a compatibility constraint.

## Repository and SDK evidence

- `src/mcp/oauth-provider.ts` already implements the SDK 2
  `OAuthClientProvider`, including discovery-state persistence, but its client
  and token methods ignore the SDK's issuer context.
- `src/features/oauth-actions.ts` receives the full copied callback URL, but
  discards its `iss` parameter before calling `auth()`. Its client-credentials
  path manually posts to a configured token URL, bypassing current SDK
  discovery and resource handling.
- `src/mcp/oauth-store.ts` stores one unqualified client and token set in a
  version 1 JSON document.
- `src/mcp/manager.ts` uses SDK 2's `StreamableHTTPClientTransport`. SDK 2
  already implements RFC 8707 resource parameters, RFC 9728 protected-resource
  discovery, OIDC/RFC 8414 authorization-server discovery, issuer validation,
  CIMD, DCR, and one-retry insufficient-scope reauthorization.
- `tests/fixtures/http-oauth-fixture.mjs` publishes protected-resource metadata
  and RFC 8414 metadata, but does not currently require resource parameters or
  return `iss`, so the important SDK integration is not proven.
- The adapter is built and documented as one regular
  `dist/letta-mcp-adapter.mjs` copied into `~/.letta/mods/`.

## Deployment and secure-storage boundary

Issue #8 names `@napi-rs/keyring`. That package requires a platform-specific
native `.node` binary and cannot be embedded in the adapter's single JavaScript
bundle. The installed Letta Code 0.31.5 mod documentation supports direct mod
files and advises them not to assume third-party packages; it does not document
a package-based mod installation format. Its command API also does not expose a
host secret resolver that `/lmcp auth-*` and background HTTP connections can
share.

Therefore this milestone will not pretend that a mode-0600 JSON file is an OS
keychain. OAuth data remains in the existing private directory while the store
is made issuer-safe. Static bearer configuration continues to prefer
`bearerTokenEnv`. Native keychain storage and one-way secret import remain
blocked on one of these explicit deployment capabilities:

1. Letta documents package-based mods that can ship native dependencies; or
2. Letta exposes a persistent host secret API to commands and background mod
   code.

When either exists, the issuer-keyed credential records introduced here form
the boundary to move behind a credential-store interface. Until then the README
must state the storage limitation plainly.

## Decisions

### Authorization completion

- `/lmcp auth-complete` requires the complete redirected URL.
- Parse and pass both `code` and `iss` to SDK 2 `auth()`.
- Preserve the adapter's state check and let the SDK validate `iss` against
  discovered authorization-server metadata.
- Report an issuer mismatch as a safe, actionable failure without echoing the
  attacker-controlled received issuer.

Raw code/state completion is removed. Breaking changes are allowed, and keeping
that alternate input would make RFC 9207 validation optional.

### Issuer-keyed persistence

Replace the version 1 document with a version 2 document containing:

- pending flow state, authorization URL, verifier, and discovery state;
- the active issuer;
- a map of client/token records keyed by normalized issuer.

SDK context or a stamped value supplies the issuer for every client/token
write. Context-qualified reads return only the matching record. Context-free
token reads return the active issuer's record, as required by the transport.

On first load, a version 1 store is migrated once:

- if its discovery state identifies an issuer, existing client/tokens are
  stamped and moved under that issuer;
- if no issuer can be established, unbound client/tokens are discarded rather
  than guessed, requiring reauthorization;
- pending non-credential flow state is retained.

Changing authorization servers can therefore never reuse another issuer's
credentials.

### Client identity and grant behavior

- A configured `oauth.clientId` always wins and is stamped for the issuer
  requested by the SDK.
- Add `oauth.clientMetadataUrl`; when no configured client exists, expose it to
  SDK 2 for CIMD.
- DCR remains the final SDK fallback and client metadata explicitly declares
  `application_type: "native"`.
- Replace the manual client-credentials token POST with SDK 2 `auth()`, so it
  uses the same discovery, issuer, resource, and storage rules. The existing
  `oauth.audience` is added through the provider's token-request hook.
- `oauth.tokenUrl` is no longer required; discovered token metadata is the
  source of truth.

### Resource binding, discovery, and scope step-up

- The test authorization server rejects authorization and token requests that
  omit or misstate the MCP resource URL.
- The fixture returns `iss` and exposes observations that prove RFC 9728
  protected-resource metadata and authorization-server metadata were used.
- Authorization-code transports explicitly use SDK 2's `reauthorize`
  insufficient-scope mode, which unions challenge and prior scopes and retries
  once.
- Client-credentials transports use `throw`; an unattended credential flow
  cannot complete an interactive step-up.

The adapter delegates protocol mechanics to SDK 2 instead of duplicating them.
Focused tests verify that the adapter supplies the provider data and transport
mode needed to activate those mechanics.

## Implementation steps

1. Add `oauth.clientMetadataUrl` normalization and validation.
2. Introduce the version 2 issuer-keyed store and one-way version 1 migration.
3. Make provider client/token methods issuer-aware; add CIMD, native DCR
   metadata, client-credentials metadata, and audience preparation.
4. Require a full redirect URL, pass `iss` to SDK auth, safely classify issuer
   mismatch, and move client credentials onto SDK auth/discovery.
5. Set grant-appropriate insufficient-scope behavior on HTTP transports.
6. Harden the OAuth fixture and add issuer mismatch, issuer rekey, migration,
   resource, CIMD, discovery, client-credentials, and scope-mode tests.
7. Update the public configuration and security documentation.

## Focused completion evidence

- Authorization and token exchange fail in the fixture without the exact MCP
  resource and succeed through adapter actions with it.
- A matching callback `iss` completes; a mismatched `iss` does not exchange a
  code or reveal the received issuer.
- Two issuers for one configured server cannot read or overwrite each other's
  clients/tokens.
- Version 1 state migrates only when it has a trustworthy issuer.
- Configured client ID wins over CIMD; CIMD avoids DCR; DCR metadata is native.
- Client credentials work through discovered metadata without `oauth.tokenUrl`.
- Authorization-code and client-credentials transports select the intended
  insufficient-scope modes.
- The fixture proves protected-resource-only discovery works.
- Full tests, typecheck, bundle build, and bundle-import smoke checks pass.

## Files expected to change

- `src/core/config.ts`
- `src/mcp/oauth-store.ts`
- `src/mcp/oauth-provider.ts`
- `src/mcp/manager.ts`
- `src/features/oauth-actions.ts`
- `tests/fixtures/http-oauth-fixture.mjs`
- `tests/helpers/oauth-fixture.ts`
- `tests/oauth-store.test.ts`
- `tests/oauth-provider.test.ts`
- `tests/oauth-actions.test.ts`
- `tests/runtime-oauth.test.ts`
- `README.md`
