# Slice 9 Plan: Milestone C Parity, UI, and Hardening

## Objective

Finish the remaining Milestone C/parity work for the Letta MCP adapter while preserving the core design already proven in Slices 1-8:

- proxy-first `mcp` tool;
- optional cache-backed direct tools;
- lazy MCP connections only from explicit tool/command calls;
- no activation-time MCP network/process work;
- strict TDD, with each behavior grounded in the actual Letta Code mod API and the installed MCP SDK API.

This slice should close the known gaps:

1. Add explicit tests and hardening for paginated MCP metadata list calls.
2. Add safe regex search support.
3. Add Letta UI status/panel integration.
4. Add MCP UI resource handling that is useful without recreating full Pi/Glimpse parity.
5. Add `auth-clear`.
6. Add optional OAuth `client_credentials` support if the installed SDK and servers support it cleanly.
7. Investigate and, only if grounded in available APIs, add sampling and elicitation support.
8. Update docs/spec/readme-ready notes so Milestone C is accurately represented.

## Required grounding before implementation

Before coding this slice, load/use the `creating-mods` skill and its references for any Letta Code mod API work. In particular:

- `creating-mods/SKILL.md`
- `creating-mods/references/ui.md` for panels/status values
- `creating-mods/references/architecture.md` for multi-capability state/cleanup
- `creating-mods/references/permissions.md` for any new model-callable or risky action policy
- `creating-mods/references/commands.md` if adding or changing slash command behavior
- `creating-mods/references/tools.md` if adding model-callable tools or changing tool metadata

Also inspect the current local Letta Code runtime API in the installed package before relying on an API shape. Do **not** import Letta Code internals; use only mod APIs exposed on `letta` and callback `ctx`.

Grounding facts already verified from the current Letta Code mod API:

- Optional capabilities are exposed under:
  - `letta.capabilities.tools`
  - `letta.capabilities.commands`
  - `letta.capabilities.permissions`
  - `letta.capabilities.events.lifecycle/tools/turns`
  - `letta.capabilities.ui.panels`
  - `letta.capabilities.ui.statusValues`
  - `letta.capabilities.ui.customStatuslineRenderer`
- Panels:
  - register with `letta.ui.openPanel({ id, content, order })`;
  - content is plain text (`string` or `string[]`);
  - handle supports `update({ content?, order? })` and `close()`;
  - panels are app/TUI-global today, so keep them short/transient and close them in disposers.
- Status values:
  - set with `letta.ui.setStatus(key, value)`;
  - clear with `letta.ui.clearStatus(key)`;
  - values may be static or functions evaluated with current context;
  - clear owned values in the activation disposer.
- Permission overlays:
  - register with `letta.permissions.register({ id, description, check(event) })`;
  - event has `toolName`, `args`, `cwd`, `workingDirectory`, `phase`, `toolCallId`, `agentId`, `conversationId`, `permissionMode`;
  - return `{ decision: "allow" | "ask" | "deny", reason? }` or `undefined`;
  - `ask` cannot reopen UI during execution phase, so execution-time blocking must use `deny`.
- Commands/tools must remain capability-guarded and return disposers.
- `runWhenBusy: true` commands must return `{ type: "handled" }` quickly and own their background/panel workflow; do not return `prompt` from busy commands.

Grounding facts already verified from the installed MCP SDK:

- Metadata list results expose `nextCursor` for tools/resources/resource templates.
- `Client` supports client capabilities including:
  - `sampling: { context?, tools? }`;
  - `elicitation: { form?: { applyDefaults? }, url?: {} }`;
  - task request support for `sampling/createMessage` and `elicitation/create`.
- Sampling server-to-client requests use `CreateMessageRequestSchema` / method `sampling/createMessage`.
- Elicitation server-to-client requests use `ElicitRequestSchema` / method `elicitation/create`.
- The SDK examples register request handlers through `client.setRequestHandler(...)` before connecting.

## Current state before Slice 9

Implemented and verified before this plan:

- Slices 1-8 complete.
- 370 tests passing.
- Typecheck/build passing.
- `src/mcp/metadata.ts` already loops over `nextCursor` for `listTools` and `listResources`, but there are no focused pagination tests yet.
- `regex: true` search currently returns a deferred/not-implemented message.
- `uiResourceUri` is preserved in cached tool metadata, but no UI/panel/resource-viewing UX is implemented.
- `auth-clear` is typed/routed but returns “not implemented”.
- `OAuthConfig.grantType` includes `client_credentials`, but the current provider is authorization-code oriented and requires `redirectUri`.
- No Letta UI status/panel integration is registered from `src/mod.ts`.
- No MCP sampling/elicitation client handlers are registered on MCP clients.

## Implementation outcome notes

Slice 9 implementation kept the proxy-first/lazy-connection design and added:

- explicit metadata pagination tests plus repeated-cursor/max-page guards;
- bounded `regex: true` cache search;
- `auth-clear` through proxy and `/mcp` command routing;
- guarded Letta UI status values and short-lived command panels;
- visible MCP UI resource URIs in list/search/describe and `/mcp tools`;
- OAuth `client_credentials` token fetching via `auth-start` when `oauth.grantType: "client_credentials"`, `clientId`, `clientSecret`, and `tokenUrl` are configured;
- permission coverage for `auth-clear`.

Sampling and elicitation remain intentionally deferred. The installed SDK exposes request-handler APIs for `sampling/createMessage` and `elicitation/create`, but this adapter's MCP clients are owned/reused by `McpServerManager`; request handlers installed there do not have a safe per-call Letta `ctx.conversation`/fork or structured form-input API. Advertising those capabilities without such scoped context would either require unsafe global app internals or fake user input. The config types reserve `settings.sampling` and `settings.elicitation`, but the adapter does not advertise those MCP client capabilities yet.

## Non-goals for Slice 9

Do **not** do these unless a focused plan update explicitly adds them:

- Do not connect to every configured MCP server during mod activation.
- Do not add a long-running keep-alive/eager lifecycle loop.
- Do not recreate full Pi/Glimpse/browser interactive panel parity.
- Do not use `letta.ui.customStatuslineRenderer`; status values are enough for this slice.
- Do not import Letta Code internals from this project.
- Do not persist user secrets outside the existing OAuth/token store pattern.
- Do not invent a fake Letta approval/prompt UI for elicitation. If the actual mod API cannot safely collect human input, return a clear unsupported/declined result.
- Do not expose sampling to MCP servers without an explicit config opt-in and permission/safety story.

## Slice 9 config additions

Add typed settings only as needed by implemented features. Proposed shape:

```ts
interface McpSettings {
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
}

interface OAuthConfig {
  grantType?: "authorization_code" | "client_credentials";
  tokenUrl?: string;
  audience?: string;
}
```

Use conservative defaults:

- regex search available but bounded;
- UI status/panels enabled only when Letta capabilities exist and not disabled in config;
- sampling disabled unless explicitly enabled;
- elicitation disabled unless explicitly enabled;
- client credentials disabled unless configured with `grantType: "client_credentials"`.

## Implementation steps

### Step 0: Baseline and API audit

1. Confirm worktree is clean.
2. Run baseline commands:

```bash
bun test
bun run typecheck
bun run build
```

3. Re-read actual API references before coding:

```bash
sed -n '1,240p' "$LETTA_CODE_SKILLS/creating-mods/references/ui.md"
sed -n '1,240p' "$LETTA_CODE_SKILLS/creating-mods/references/architecture.md"
sed -n '1,220p' "$LETTA_CODE_SKILLS/creating-mods/references/permissions.md"
```

If `$LETTA_CODE_SKILLS` is not set, use the installed skill path shown by the current Letta Code environment.

4. Inspect current mod API around UI/capabilities from the installed Letta Code package if behavior is unclear. Record any discovered API constraints in this plan or in a follow-up implementation note.

Acceptance:

- No code changes yet.
- Any API uncertainty is resolved by local source/docs inspection, not assumption.

---

### Step 1: Add explicit pagination tests and hardening

Current implementation already loops on `nextCursor`; this step makes that behavior intentional and regression-tested.

Tests first:

1. Add pure/fake-client tests for `discoverServerMetadata`:
   - `listTools` returns page 1 with `nextCursor`, then page 2 with no cursor.
   - calls include `{ cursor: "..." }` on later pages.
   - tools from all pages are normalized and returned in order.
   - `listResources` paginates similarly.
   - `listResources` failure still degrades to `[]` as current behavior expects.
2. Add a loop guard test:
   - if a server repeats the same `nextCursor` indefinitely or exceeds a reasonable maximum, metadata discovery fails with a concise error instead of hanging.

Implementation:

1. Keep the current cursor loop if correct.
2. Add a shared pagination helper if useful:
   - tracks seen cursors;
   - enforces a max page count such as 1,000;
   - throws a concise metadata pagination error on repeated cursors/max pages.
3. Do not change cache schema.

Verification:

```bash
bun test tests/manager-stdio.test.ts tests/runtime.test.ts # or the new focused metadata test
bun run typecheck
```

Acceptance:

- Pagination is covered by tests.
- No infinite loop is possible on bad cursor behavior.

---

### Step 2: Implement safe regex search

Goal: support `mcp({ search: "...", regex: true })` without introducing ReDoS risk or confusing errors.

Tests first:

1. Plain search behavior remains unchanged.
2. Regex search matches tool names and descriptions.
3. Regex search supports common JS regex syntax and optional flags only if explicitly designed.
4. Invalid regex returns a concise actionable error.
5. Empty regex is rejected.
6. Overlong regex is rejected with the configured/max default length.
7. Results still honor server filters, exclusions, and `includeSchemas`.
8. No regex search should run against live MCP servers; it remains cache-backed.

Implementation options:

- Prefer using built-in `RegExp` with guardrails:
  - max pattern length, e.g. 200 chars;
  - no user-controlled flags initially, or only parse `/pattern/i` if tests cover it;
  - catch constructor errors;
  - cap searchable text length per tool/resource if needed.
- Avoid adding dependencies unless a real ReDoS-safe regex package is already available and justified.
- Update `MCP_PROXY_PARAMETERS.regex.description` from deferred wording to supported guarded regex wording.
- Update `/mcp tools` only if command-level regex UX is added; otherwise keep regex support model-facing through the proxy tool.

Verification:

```bash
bun test tests/proxy-tool.test.ts tests/proxy-tool-call.test.ts
bun run typecheck
```

Acceptance:

- `regex: true` works predictably against cached metadata.
- Invalid/unsafe patterns fail closed with useful text.

---

### Step 3: Implement `auth-clear`

Goal: let a user/agent clear OAuth material for a configured server safely.

Tests first:

1. `mcp({ action: "auth-clear", server: "remote" })` clears stored tokens/client info/pending auth/discovery state for that server.
2. `/mcp auth-clear remote` parses and routes if we choose to expose the command alias.
3. Missing server returns the existing OAuth server-required error style.
4. Unknown server is rejected.
5. Non-OAuth server returns a concise not-configured-for-OAuth message.
6. Permission behavior asks/always-asks for `auth-clear`, consistent with existing OAuth mutating actions.
7. Redaction still prevents tokens/secrets in output.

Implementation:

1. Reuse `clearOAuthCredentials(...)` from `src/mcp/oauth-store.ts`.
2. Decide clear scope:
   - for user-facing `auth-clear`, default to all OAuth credential material for that server URL;
   - if SDK scope enum/type requires scoped clearing, call appropriate scopes in sequence or add a store-level clear helper.
3. Add parser support in `src/features/mcp-command.ts` if adding `/mcp auth-clear <server>`.
4. Update help text and proxy action description.
5. Update permissions tests if needed.

Verification:

```bash
bun test tests/oauth-actions.test.ts tests/oauth-store.test.ts tests/mcp-command.test.ts tests/permissions.test.ts
bun run typecheck
```

Acceptance:

- No more “auth-clear is not implemented” path.
- Cleared state is observable through `auth-status`.

---

### Step 4: Add Letta UI status values

Goal: expose compact MCP adapter state through actual Letta status values when available.

Grounded API:

- Guard with `letta.capabilities?.ui?.statusValues`.
- Use `letta.ui.setStatus(key, value)`.
- Clear on dispose with `letta.ui.clearStatus(key)`.
- Values may be functions evaluated against current context; use this if status depends on `ctx.cwd`.

Tests first:

1. Activation registers no UI status when `capabilities.ui.statusValues` is false/missing.
2. Activation sets/registers an MCP status value when status values are available.
3. Status function/value summarizes current project state without connecting to MCP servers:
   - configured server count;
   - cached tool count;
   - warning count if config load has warnings;
   - possibly connected count only from existing runtime manager state.
4. Dispose clears the status key.
5. Status evaluation errors are not thrown from activation; use short fallback text if needed.

Implementation:

1. Add `src/features/ui.ts` or similar with `registerMcpUi({ letta, runtime, activationCwd })`.
2. Register a status key such as `mcp`.
3. Prefer a lazy status function receiving `ctx` so it can use `ctx.cwd`; fallback to `activationCwd`.
4. Status must not connect to MCP servers or write cache.
5. Integrate from `src/mod.ts` after permissions/tools/commands, behind capability guards.

Suggested status text examples:

```text
MCP 2 servers / 14 tools
MCP 0 servers
MCP config warning
```

Verification:

```bash
bun test tests/mod.test.ts
bun run typecheck
```

Acceptance:

- UI status works when available and is invisible/no-op otherwise.
- Activation remains side-effect-light.

---

### Step 5: Add short-lived UI panels for human-invoked commands

Goal: use panels for concise transient status around user commands, without dumping long command output into panels.

Grounded API:

- Guard with `letta.capabilities?.ui?.panels`.
- Use `letta.ui.openPanel({ id, content, order })`.
- Update with `panel.update({ content })`.
- Close with `panel.close()` and clean up on dispose.
- Panels are global today; do not create many per-conversation panels.

Tests first:

1. No panel is opened if panels capability is absent.
2. `/mcp reconnect <server>` opens/updates/closes a short panel when panels are available.
3. `/mcp auth-start <server>` can show “OAuth URL generated” panel, but long URL remains in command output.
4. Panel handles are closed on dispose or after TTL.
5. Panel failures do not break command output.

Implementation:

1. Extend command context type minimally to include optional `ui` only if actual command ctx exposes it. If command ctx does not expose `letta.ui`, use a local UI service registered at activation time and passed into command creation.
2. Keep panels short:
   - “MCP reconnect: filesystem…”
   - “MCP reconnect: filesystem connected (5 tools)”
   - “MCP reconnect failed: see command output”
3. Add a configurable TTL default, e.g. 5 seconds.
4. Track panel/timer disposers in `registerMcpUi` or command UI helper.
5. Do not make commands `runWhenBusy: true` unless specifically needed and tested.

Verification:

```bash
bun test tests/mcp-command.test.ts tests/mod.test.ts
bun run typecheck
```

Acceptance:

- Panels enhance human UX without becoming the primary output channel.
- Cleanup is deterministic.

---

### Step 6: Improve MCP UI resource handling

Goal: make cached MCP UI resource hints useful in Letta Code’s text-first environment.

Current state:

- `normalizeTools` preserves `_meta["openai/outputTemplate"]` or `_meta.uiResourceUri` as `CachedTool.uiResourceUri`.

Tests first:

1. `describe` output includes UI resource URI when present.
2. Search/list output marks tools with UI resources compactly.
3. Tool call results containing `resource_link` or embedded `resource` content are rendered clearly.
4. A new action or command can read/display UI resource text when the resource is available and text-like.
5. Binary/blob UI resources are not dumped; output includes URI, mime type, and a concise unsupported/binary note.

Implementation options:

- Minimal first pass:
  - show `uiResourceUri` in `describe`;
  - update result renderer for MCP `resource_link` / `resource` content blocks;
  - add `/mcp resource <server> <uri>` or proxy action only if it fits existing mode precedence cleanly.
- If adding resource reading:
  - use existing manager/client `readResource` path or add a focused method;
  - require explicit server/URI;
  - render only text resources in command/tool output;
  - do not open browser/UI panel automatically.

Verification:

```bash
bun test tests/result-renderer.test.ts tests/proxy-tool-call.test.ts tests/mcp-command.test.ts
bun run typecheck
```

Acceptance:

- UI resource metadata is visible and actionable.
- Text resources can be inspected without full browser panel parity.

---

### Step 7: Investigate and implement client credentials OAuth only if clean

Goal: support `oauth.grantType: "client_credentials"` for servers that use OAuth machine credentials, without compromising authorization-code flow.

Research first:

1. Inspect installed MCP SDK auth APIs for client-credentials support.
2. Inspect whether `auth(provider, ...)` supports client credentials directly or whether token fetching must be implemented locally.
3. Confirm token response format and storage compatibility with existing `OAuthTokens` store.
4. Check whether server discovery metadata exposes token endpoint reliably; if not, require `oauth.tokenUrl`.

Tests first:

1. Config with `oauth.grantType: "client_credentials"` does not require `redirectUri`.
2. Missing `clientId`, `clientSecret`, or `tokenUrl` returns concise config errors.
3. Token request uses form-encoded OAuth fields and optional scope/audience.
4. Tokens are stored in the existing OAuth store format.
5. HTTP MCP connection uses the stored access token after client credentials auth.
6. Authorization-code tests remain green.
7. Secret redaction covers client secret and returned access token.

Implementation:

1. Add `tokenUrl` and optional `audience` to `OAuthConfig` if needed.
2. Split provider/config validation by grant type:
   - `authorization_code` requires `redirectUri`;
   - `client_credentials` requires `clientId`, `clientSecret`, and token endpoint strategy.
3. Implement an explicit `auth-client-credentials` action only if `auth-start` semantics would be confusing. Preferred user-facing options:
   - `mcp({ action: "auth-start", server: "x" })` detects grant type and fetches token; or
   - `mcp({ action: "auth-client-credentials", server: "x" })` if tests show clearer UX.
4. Do not log token payloads.

Verification:

```bash
bun test tests/oauth-provider.test.ts tests/oauth-actions.test.ts tests/http-transport.test.ts tests/oauth-redaction.test.ts
bun run typecheck
```

Acceptance:

- Client credentials works for a fixture server.
- Authorization-code OAuth behavior is unchanged.

If SDK support is not clean, explicitly document deferral with exact blocker and do not ship a half-implementation.

---

### Step 8: Investigate sampling support with strict opt-in

Goal: if possible, allow an MCP server to request client-side LLM sampling through Letta in a controlled way.

Grounding constraints:

- MCP SDK request handler: `client.setRequestHandler(CreateMessageRequestSchema, handler)`.
- Client capability: `sampling: {}` or more specific `sampling: { context?, tools? }`.
- Letta mod tool callbacks may have `ctx.conversation.getHistory()` but not necessarily fork/send helpers.
- Letta mod command callbacks may have `ctx.conversation.fork()` / `sendMessageStream(...)`, but MCP client request handlers are inside adapter runtime/manager, not command callbacks.
- Therefore sampling may not have safe access to scoped conversation APIs unless the adapter can pass current command/tool `ctx` into the MCP call path and install per-call handlers.

Investigation tasks:

1. Inspect how `McpServerManager` constructs `Client` instances.
2. Determine whether request handlers can be installed per connection and access a current `RuntimeToolContext` safely.
3. Determine what conversation APIs are actually present in tool `ctx` vs command `ctx` in current Letta Code.
4. Decide one of these designs:
   - **Disabled with clear message**: advertise no sampling capability unless a safe scoped handler exists.
   - **Summary-only handler**: returns a bounded refusal/summary and never calls the model.
   - **Conversation-fork handler**: only for command contexts where `ctx.conversation.fork()` exists, with config opt-in and permission ask.

Tests first if implementation is possible:

1. By default, client capabilities do not advertise sampling.
2. With `settings.sampling.enabled: true`, client advertises sampling only for explicit calls/servers.
3. Sampling request handler receives `sampling/createMessage` and returns a valid MCP `CreateMessageResult`.
4. Sampling prompt content is bounded/redacted in logs/output.
5. If no safe Letta conversation API exists, handler returns an MCP error or refusal result, not a crash.
6. Permission overlay asks for sampling-enabled MCP calls or denies when configured.

Implementation:

1. Add config normalization for sampling settings.
2. Add MCP client creation options to include sampling capabilities and handlers only when enabled.
3. Keep default off.
4. If using conversation forks, require current `ctx.conversation.fork`; do not use global app internals.
5. Do not allow sampling tools (`sampling.tools`) until separately planned/test-covered.

Verification:

```bash
bun test tests/manager-stdio.test.ts tests/runtime-call.test.ts tests/permissions.test.ts
bun run typecheck
```

Acceptance:

- Either sampling is implemented with actual Letta scoped APIs and strict opt-in, or the deferral is documented with exact API blocker.

---

### Step 9: Investigate elicitation support with safe UX boundaries

Goal: support MCP server elicitation only where it maps safely to Letta Code mod APIs.

Grounding constraints:

- MCP SDK request handler: `client.setRequestHandler(ElicitRequestSchema, handler)`.
- Client capability: `elicitation: { form?: { applyDefaults? }, url?: {} }`.
- Letta panel API displays plain text only; it is not a form input mechanism.
- Commands can return output/prompt/handled, but MCP elicitation requests can occur during a tool call and need an immediate async result.
- Permission overlays can ask/deny before MCP tool calls, but cannot collect arbitrary structured form input mid-call.

Recommended design:

1. Default: do not advertise elicitation.
2. URL elicitation may be feasible as a text-first acknowledgement:
   - show URL/message in command/tool output or transient panel;
   - return `decline` by default unless explicit config says auto-accept URL display is allowed;
   - never open a browser automatically.
3. Form elicitation likely requires a human input API that current panels do not provide. Unless actual Letta mod APIs expose a prompt/form mechanism, return a clear unsupported result.

Tests first if implementing URL/form support:

1. Default client capabilities do not advertise elicitation.
2. With `settings.elicitation.url: true`, client advertises URL elicitation.
3. URL request validates URL and domain before display.
4. URL request returns `decline` or `accept` according to explicit config, never silently opens browser.
5. Form request is unsupported unless a real input API is found.
6. Elicitation output is concise and does not leak sensitive query values beyond the URL the server supplied.
7. Permission overlay asks for elicitation-enabled MCP calls or denies when configured.

Implementation:

1. Add config settings for elicitation.
2. Add client capabilities/handlers only when enabled.
3. For URL elicitation, use panel only for short “server requests URL action” notice; return full details in tool/command output where possible.
4. For form elicitation, either implement with a real Letta API if found or keep disabled with documented blocker.

Verification:

```bash
bun test tests/manager-stdio.test.ts tests/runtime-call.test.ts tests/permissions.test.ts tests/mod.test.ts
bun run typecheck
```

Acceptance:

- No fake form UI.
- Elicitation support is honest about what Letta mod APIs can do today.

---

### Step 10: Update permissions for new risky flows

New flows may include regex, auth-clear, client credentials, sampling, and elicitation.

Tests first:

1. Regex search remains read-only and allowed unless pattern is invalid/unsafe.
2. `auth-clear` asks/always-asks like other OAuth mutating actions.
3. Client credentials token fetch asks/always-asks if implemented as an action.
4. Sampling-enabled tool calls ask or deny according to config.
5. Elicitation-enabled tool calls ask or deny according to config.
6. Execution-phase ask bridging still denies safely if approval was not tracked.

Implementation:

1. Extend approval settings only if needed:

```ts
approval?: {
  dangerousTools?: ApprovalDecision;
  unknownServers?: ApprovalDecision;
  configWrites?: ApprovalDecision;
  oauth?: ApprovalDecision;
  sampling?: ApprovalDecision;
  elicitation?: ApprovalDecision;
}
```

2. Preserve defaults that are safe and not annoying:
   - read-only search/describe/status allow;
   - risky/mutating flows ask/alwaysAsk;
   - unknown/unconfigured servers deny.
3. Keep permission checks deterministic and side-effect-free.

Verification:

```bash
bun test tests/permissions.test.ts tests/mod.test.ts
bun run typecheck
```

Acceptance:

- New capabilities cannot silently bypass permission policy.

---

### Step 11: Documentation and spec alignment

Tests are not required for docs, but docs must reflect reality.

Update:

1. `docs/letta-mcp-adapter-mod-spec.md`
   - mark Milestone C details as implemented/deferred accurately;
   - update proxy action list if `auth-clear` or resource action is added;
   - update UI/status activation conceptual shape if implementation differs.
2. Add or update README if present/created:
   - install/build instructions;
   - config examples for regex, UI, auth-clear, client credentials if implemented, sampling/elicitation if implemented;
   - safety notes.
3. Add a completion note to this file or a separate `docs/slice-9-completion.md` with exact unsupported/deferred items.

Verification:

```bash
rg -n "not implemented|deferred|Slice 6|Slice 9|auth-clear|regex|sampling|elicitation|client_credentials" docs src tests
bun run typecheck
bun test
bun run build
```

Acceptance:

- Docs do not overclaim.
- Any remaining deferrals include exact API/product blockers.

---

### Step 12: Final verification and non-goal audit

Run:

```bash
bun test
bun run typecheck
bun run build
node -e 'import("./dist/letta-mcp-adapter.mjs").then(() => console.log("slice 9 bundle smoke ok"))'
```

Audit:

1. No Letta internals imports.
2. No activation-time MCP connects.
3. All UI capabilities are guarded.
4. All panels/status values/timers are cleaned up on dispose.
5. Permission checks remain side-effect-free.
6. No secrets in output/tests/snapshots.
7. Sampling/elicitation are default-off or honestly deferred.
8. Regex guardrails are tested.
9. Metadata pagination cannot hang.
10. `auth-clear` and client credentials do not break existing OAuth authorization-code flow.

Definition of done:

- Full test suite passes.
- Typecheck passes.
- Build passes.
- Bundle smoke passes.
- Milestone C status is documented accurately.

## Suggested implementation order

Recommended order for the actual coding pass:

1. Pagination tests/hardening.
2. Regex search.
3. `auth-clear`.
4. UI status values.
5. UI command panels.
6. MCP UI resource handling.
7. Client credentials OAuth.
8. Sampling investigation/implementation or documented deferral.
9. Elicitation investigation/implementation or documented deferral.
10. Permission updates for new risky flows.
11. Docs/spec alignment.
12. Final verification/audit.

This order front-loads small deterministic work, then UI grounded in Letta mod APIs, then protocol/auth complexity, then docs and final verification.
