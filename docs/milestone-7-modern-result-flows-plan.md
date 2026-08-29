# Milestone 7: Modern result flows

## Objective

Implement the safe, currently supportable portion of
[issue #6](https://github.com/klittle32/letta-mcp-mod/issues/6):

- distinguish ordinary completed tool results from `input_required` before
  rendering;
- prevent unresolved input requests and opaque continuation state from being
  rendered, spilled, or persisted as tool output;
- return actionable failures when Letta Code cannot collect the requested
  input;
- recognize task-result failures without advertising an extension that the
  installed MCP SDK cannot consume.

Task polling remains an explicit upstream gate rather than a private protocol
implementation.

## Repository, host, and protocol evidence

- `src/runtime.ts` currently sends every `tools/call` result directly to
  `renderCallToolResult()`. It does not inspect `resultType`.
- `src/mcp/manager.ts` creates SDK clients without `inputRequired` options or
  request handlers. SDK 2 defaults to automatically fulfilling MRTR requests
  through registered handlers, but this mod has no such handlers.
- The adapter persists metadata and negotiated protocol information, not tool
  call results. Oversized completed output may be retained by the output guard.
  Branching before that guard is therefore the rule that keeps
  `input_required` state out of both model output and spill files.
- MCP 2026-07-28 defines an absent discriminator as `complete` for
  compatibility and `resultType: "input_required"` for MRTR. SDK 2 provides
  `allowInputRequired` and `isInputRequiredResult()` specifically for callers
  that need to handle that result manually.
- Letta Code 0.31.5's public mod tool context exposes arguments, workspace,
  cancellation, conversation access, and approval metadata. Its public UI API
  exposes panels and notifications, not a prompt/form/select API. Approval
  dialogs return a decision, not arbitrary form values. A mod therefore cannot
  safely implement an MCP elicitation handler today.
- The official Tasks extension requires explicit per-request negotiation,
  polymorphic `tools/call` results, `tasks/get`, `tasks/update`, and
  `tasks/cancel`.
- `@modelcontextprotocol/client@2.0.0` does not implement that extension. Its
  exported task schemas are marked as deprecated 2025-era vocabulary with no
  SDK runtime, and its modern wire codec rejects `resultType: "task"` with
  `SdkErrorCode.UnsupportedResultType`.
- Upstream tracks implementation in
  [typescript-sdk#2189](https://github.com/modelcontextprotocol/typescript-sdk/issues/2189).
  The exact 2.0.0 result rejection is reproduced in
  [typescript-sdk#2637](https://github.com/modelcontextprotocol/typescript-sdk/issues/2637).

## Decisions

### Completed results

Continue accepting both:

- modern `{ resultType: "complete", ... }`; and
- compatibility results with no `resultType`.

Both use the existing renderer and output guard. Unknown non-complete result
types never reach the renderer.

### Input-required results

Configure the client for manual MRTR handling and call tools with
`allowInputRequired: true`. `runtime.callTool()` will inspect the returned value
with the SDK type guard before rendering.

When additional input is required:

- return a concise failure naming the server and the kinds of requests it
  needs;
- explain that the installed Letta public mod API cannot collect interactive
  input for a running tool call;
- do not expose or transform opaque `requestState`;
- do not call the output guard, retry the request, or persist continuation
  data.

The existing `settings.elicitation` fields remain reserved. Enabling them
cannot create a host interaction API, so the adapter will not claim otherwise.
When Letta exposes a scoped prompt API, a later change can register SDK request
handlers and let SDK 2 drive the MRTR loop.

### Task results

Do not advertise `io.modelcontextprotocol/tasks` and do not add a nonfunctional
`tasks: true` setting or `get_result` tool. Conforming servers cannot return a
task unless the client opts in.

If a server nevertheless returns `resultType: "task"`, classify the SDK's
`UnsupportedResultType` error and return a specific compatibility message
instead of a generic call failure.

Task support resumes when the public MCP client package can:

1. negotiate `io.modelcontextprotocol/tasks`;
2. return `CreateTaskResult` from `callTool()` without bypassing SDK validation
   and HTTP header behavior; and
3. issue modern `tasks/get`, `tasks/update`, and `tasks/cancel`.

At that point the adapter should add per-server opt-in and a non-blocking
`get_result` model tool. It must poll once per invocation rather than occupying
the original call until `timeoutMs`.

### Rejected alternatives

- **Vendor the draft/private Tasks schemas and send raw requests.** This would
  fork capability negotiation, wire validation, MCP HTTP headers, and future
  SDK behavior inside the adapter.
- **Treat Letta approval as elicitation.** Approval conveys allow/deny only and
  cannot return schema-shaped input.
- **Render the unresolved result for the model to interpret.** This leaks opaque
  continuation state, invites fabricated user answers, and can persist the
  unresolved result through output spilling.
- **Poll tasks inside `call_tool`.** This defeats the extension's durable,
  reconnectable design and couples long-running work to the normal call
  timeout.

## Implementation steps

1. Set SDK input-required handling to manual mode in `src/mcp/manager.ts`.
2. Request unresolved input results explicitly in `runtime.callTool()`.
3. Add a focused result classifier that:
   - sends complete/absent results through the existing renderer;
   - turns `input_required` into an actionable, non-persisted failure; and
   - gives unsupported task results a specific upstream-gate message.
4. Add focused runtime and manager tests for complete/absent, input-required,
   task rejection, request options, and no spill/cache write.
5. Update the README, project specification, and roadmap status with the
   supported behavior and explicit host/SDK gates.

## Focused completion evidence

- Existing legacy and modern completed results render unchanged.
- A synthetic `input_required` result is intercepted before the renderer and
  output guard.
- The returned message does not contain `requestState` or raw input payload
  JSON.
- No result artifact or metadata mutation is produced by the unresolved
  result.
- An SDK `UnsupportedResultType` error carrying `resultType: "task"` returns a
  task-specific compatibility message.
- Client construction and `callTool()` options select manual input handling.
- Full tests, typecheck, bundle build, and bundle-import smoke checks pass.

## Files expected to change

- `src/mcp/manager.ts`
- `src/runtime.ts`
- `tests/manager-stdio.test.ts`
- `tests/runtime-call.test.ts`
- `README.md`
- `docs/letta-mcp-adapter-mod-spec.md`
- `docs/v0.2-roadmap-and-split-tools-plan.md`
