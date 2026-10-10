# Model alias compaction

## Requirements

Use the user-configured `aliases.compact` model for context compaction; when absent, use Pi's current-model path unchanged. Implementation was authorized after review of this simplified design.

- Cover manual `/compact`, automatic threshold compaction, and overflow recovery through the same hook.
- Change only the summary model, not the main session model or thinking level.
- Reuse existing alias configuration, resolution, candidate selection, sticky state, and reload behavior.
- Preserve Pi's preparation, retained boundary, previous summary, split-turn handling, file tracking, usage, and custom instructions.
- Do not add settings, commands, another extension, candidate retry loops, tracking metadata, or unrelated configuration lifecycle changes.
- Cancellation must stop work without triggering a fallback request.

Failure behavior: warn once when a configured alias is unusable or its request fails, then let Pi use the current model. Missing `compact` is a silent default-path pass-through.

## Design

### Configuration

Continue using `<getAgentDir()>/model-alias.json` with its existing schema:

```json
{
  "aliases": {
    "compact": {
      "models": ["provider/model-id"],
      "thinkingLevel": "off"
    }
  }
}
```

`compact` is an exact, case-sensitive alias name. Existing string, array, and object forms remain valid, including ordinary `/ma compact` use. No filename migration or new settings scope is needed.

An explicit alias thinking level applies only to the summary request; otherwise use the session thinking level captured at the start of compaction. Use `/model-alias-reload` as already implemented.

### Implementation

Add one `session_before_compact` handler in `packages/pi-model-alias/src/model-alias.ts`:

1. Look up `aliases.compact`. If absent, return `undefined` without making a request.
2. Resolve it with the existing `resolveAlias()` and registry lookup, including the existing sticky and cooldown semantics.
3. Resolve the selected model's credentials and call Pi's public `compact()` with the original preparation and custom instructions. Preserve auth base URL, headers, and environment overrides, and dispatch through the configured provider.
4. Pass `event.signal` to the summary request. Before publishing any result or falling back after an await, verify that the operation is still valid.
5. Return `{ compaction: result }` on success, rejecting a blank summary. Record the successful sticky pick without updating the main-session `inFlight` attribution.
6. On failure, warn only when UI is available and return `undefined` so Pi executes its default path. On cancellation or stale ownership, return `{ cancel: true }`, never fall through to another request.

Do not call `pi.setModel()` or `pi.setThinkingLevel()`. Do not recalculate the retained boundary or truncate history to fit the summary model. Keep trigger and retention budgets tied to the active conversation model.

Keep the implementation in the existing module unless its actual size warrants extracting a helper; do not introduce a new module or abstraction in advance.

### Necessary compatibility checks

- The repository's `ModelRegistry` does not expose the installed runtime's newer `streamSimple()` facade. Use the existing `getApiKeyAndHeaders()` and `getProvider()` APIs with a provider-owned `streamSimple` adapter for `compact()`, and verify this against repository types and installed Pi.
- Native preparation does not automatically carry file-list details from hook-generated compactions. Preserve validated cumulative file lists as a compatibility fix, using the existing native details shape and cloned file-operation sets; do not add source markers or model audit metadata. Verify repeated compaction rather than assuming native helper reuse preserves this behavior.
- Pi aborts the operation signal on cancellation, dispose, and session replacement. Reload emits shutdown without first aborting compaction, so keep one pending-operation AbortController, combine it with `event.signal`, and abort it on shutdown or a reused instance's session start. Clear it when the request settles; no generation or session-ID framework is needed.
- Returning a custom result bypasses the session's default summarization retry wrapper. Do not create another settings manager or retry policy to imitate it. Pi retains its own retry behavior on the fallback path.
- Other custom compaction handlers can replace this result: Pi uses the last non-empty handler result, not a merged result. Document that limitation; do not detect other extensions, integrate their settings, or design a coordination protocol.

Using a different provider sends the summarized history to that provider. The compact model must have sufficient context capacity and summary quality; a cheaper model is not automatically suitable.

Temporary session-model switching is rejected because it changes unrelated session state. Virtual-model conversion and upstream API work are outside this feature.

### Applicable rules and verification

Follow `docs/extension-conventions.md` for cancellation, stale continuations, standalone behavior, and unchanged ordinary request prefixes: verify with focused lifecycle tests, assertions that no model/thinking changes occur, semantic diff review, and a Pi smoke.

Follow `docs/extension-settings.md` for existing configuration consumption: keep reads side-effect free and preserve validation and reload behavior. This feature adds no settings writes, UI, migration, or configuration lifecycle changes.

Test the extension's selection, forwarding, fallback, and cancellation behavior, plus split-turn and repeated-compaction compatibility. Do not duplicate Pi's internal summary-algorithm test suite.

## Tasks

- [x] T1. Confirm configured-alias failure behavior before implementation — files: this spec — verified: implementation authorized with the stated recommended failure behavior.
- [x] T2. Add the handler and focused tests after T1; audit existing Pi lifecycle behavior and preserve native file tracking without extra metadata — files: `packages/pi-model-alias/src/model-alias.ts`, `packages/pi-model-alias/test/compaction.test.ts` — verified: 44 new tests, 122 package tests, package typecheck, root check, and isolated full suite passed. Tests live separately to keep the existing test file below 1,000 lines.
- [x] T3. Document configuration, data disclosure, fallback and competing-handler limits, and record release intent after T2 — files: `packages/pi-model-alias/README.md`, `.changeset/model-alias-compaction.md`, this spec — verified: guide/diff audit, README heading audit, root gates, package build, and isolated generated-package RPC compaction smokes on repository and installed Pi. No publication performed.

### Verification evidence

- `npm run check`: passed build, Biome, package boundaries, and workspace typechecks.
- `npm exec vitest -- run packages/pi-model-alias/test`: 122 passed; 44 cover the new compaction behavior.
- `npm --workspace @chrisptang/pi-model-alias run typecheck` and `run build`: passed.
- `npm test` with the normal HOME: 4566 passed, one unrelated failure caused by duplicate user `pptx` skills in the starship loader test. User files were not modified.
- `HOME=<temporary empty directory> npm test`: final run passed all 4567 tests across 407 files. An earlier isolated run hit an unrelated plan-mode watcher timeout; focused rerun and the final full rerun passed. The root runner canonicalizes the macOS temporary path; a direct focused run without that normalization also exposed an unrelated starship path assertion.
- Generated package loaded in isolated RPC mode with `--no-extensions -e ./packages/pi-model-alias` plus a local fake provider. Both Pi 0.85.0 and installed Pi 1.1.0 passed alias summary generation, repeated compaction, unavailable-alias fallback, absent-alias pass-through, and unchanged main model/thinking assertions. Temporary harness only; no online requests.
- README fenced-code-aware heading audit passed for all 33 active extensions; `git diff --check` passed.
- Active LSP probe returned no diagnostics but could not confirm clean (push-only server); TypeScript checks provide the confirmed typecheck evidence.
- Semantic audit against both extension guides: no configuration writes, new settings scope, commands, tracking metadata, prompt/tool rewrites, or extension dependencies. The pending controller covers reload/shutdown; native signal covers ordinary abort/dispose/replacement. Context values are captured before awaits and signals checked before publication. Provider callbacks for the summary do not use the main agent's response instrumentation, so summary failures do not rotate the main alias.
- Unverified: real-provider authentication refresh and summary quality, interactive TUI cancellation, and simultaneous custom compaction handlers. The auth facade cannot interrupt an in-progress refresh; cancellation discards its result when it settles. Competing handlers and retry differences remain documented limitations.
