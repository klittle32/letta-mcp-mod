# Milestone 2: Aggregate MCP Output Guard

Status: implemented

Issue: [#10](https://github.com/klittle32/letta-mcp-mod/issues/10)

Roadmap dependency: Milestone 1 established `search_tools` and `call_tool`.
Milestone 2 protects the result returned by `call_tool` and cache-backed direct
tools without changing MCP discovery or transport behavior.

## Repository baseline

- `src/core/result-renderer.ts` currently truncates each text block at 20,000
  characters and each JSON value at 8,000 characters.
- Per-block truncation loses the omitted content and does not bound the
  aggregate result assembled from multiple blocks.
- `src/runtime.ts` is the shared execution path for `call_tool`, direct tools,
  ordinary MCP tools, and synthetic `readResource` calls.
- `createAdapterRuntime` already accepts an injectable home directory and clock,
  which can make artifact and pruning tests deterministic.

## Reference behavior

`pi-mcp-adapter` v2.11.0's `mcp-output-guard.ts`:

- applies a default-on aggregate output bound;
- reserves room for an actionable truncation notice;
- preserves the complete result in a private artifact when possible; and
- reports the original and returned size.

Issue #10 intentionally differs from that version by requiring durable artifacts
under the adapter's Letta data directory and pruning rather than temporary
directories.

## Product contract

### Aggregate limit

- Apply one limit to the complete model-facing result after text blocks,
  structured content, resources, and the call-result heading are combined.
- Default to 40,000 characters.
- Add optional `call_tool.maxOutput` for a one-call override.
- Accept override values from 1,000 through 1,000,000 characters. The lower
  bound leaves room for a useful preview and artifact pointer; the upper bound
  prevents an accidental effectively-unbounded call.
- Configure the normal limit with
  `settings.outputGuard.maxChars`.

### Spill artifacts

- Store artifacts beneath
  `~/.letta/mcp-adapter/results/<server>/`.
- Use private directories and files (`0700` directories, `0600` files).
- Include sanitized tool name, UTC timestamp, and a collision-resistant suffix
  in each filename.
- Store text results as `.txt`.
- Store results containing structured content as complete JSON (`.json`) so no
  structured fields are lost.
- Decode oversized image, audio, and resource blobs and store them with an
  extension derived from their MIME type. Preserve a JSON manifest as well when
  needed to retain the complete mixed result.
- Never place raw base64 data in the model-facing preview.

### Model-facing result

- Results at or below the aggregate limit remain unchanged.
- Oversized results return a bounded head preview followed by:

  `Output truncated (N chars). Full result: <path>. Use the file tools to read more.`

- If an artifact cannot be written, still bound the output and report the write
  failure rather than returning the unbounded result.

### Retention

- Prune after writing an artifact.
- Defaults: retain at most 100 files and delete files older than 7 days.
- Allow `settings.outputGuard.maxFiles` and `maxAgeMs` to tune those limits.
- A pruning failure must not fail an otherwise successful MCP call.

## Implementation plan

1. Replace per-block truncation in `src/core/result-renderer.ts` with lossless,
   synchronous rendering. Keep binary content represented by bounded
   placeholders.
2. Add `src/core/output-guard.ts` for aggregate measurement, private artifact
   writes, MIME-aware binary extraction, preview construction, and pruning.
3. Extend `McpSettings` with typed output-guard settings.
4. Extend `call_tool` with optional `maxOutput`; pass it separately from MCP
   tool arguments.
5. Apply the guard inside `AdapterRuntime.callTool` after the final
   model-facing result has been assembled. This keeps `call_tool`, direct tools,
   normal tools, and `readResource` on one rule.
6. Document configuration, overrides, artifact paths, and retention in
   `README.md`.

## Focused tests

- Under-limit text remains byte-for-byte unchanged.
- Multiple blocks are measured as one aggregate result.
- Oversized text is previewed and the complete text is written privately.
- Small structured content remains inline; oversized structured content spills
  as valid JSON.
- Oversized `readResource` text spills through the same runtime path.
- Oversized resource/image/audio base64 is decoded to a MIME-appropriate file
  and does not enter model context.
- `maxOutput` overrides the configured/default limit without entering MCP args.
- Old and excess artifacts are pruned.
- Write/prune failures remain bounded and actionable.
- Existing stdio, HTTP, OAuth, direct-tool, permission, and command tests remain
  green.

## Done conditions

1. Every runtime tool/resource result is subject to one aggregate bound.
2. The default and configured limits work, and `call_tool.maxOutput` overrides
   them for one call.
3. No oversized content is silently discarded when the artifact can be
   written.
4. Spill files are private, discoverable from the returned notice, and pruned.
5. Structured and binary/resource cases preserve their original forms.
6. Focused tests, the full suite, typechecking, and the bundled build pass.

## Verification

- Aggregate guard tests cover defaults, overrides, unchanged small output,
  multi-block text, structured JSON, `readResource` text, decoded binary
  resources, retention, private permissions, and write failures.
- Runtime integration tests cover configured and per-call limits through a real
  stdio MCP server.
- Full suite: 302 tests passing across 25 files.
- `bun run typecheck` passes.
- `bun run build` produces `dist/letta-mcp-adapter.mjs`.
