# Subagent transient LLM retry

## Requirements

- A subagent must not become terminal after one transient LLM transport failure such as `stream disconnected before completion: stream closed before response.completed`.
- Retry at most three times and keep the same child process so its in-memory conversation, completed tool results, and workspace changes remain available.
- Reuse Pi's native retry behavior where it applies; do not restart completed work in a fresh child.
- Do not retry cancellation, turn-budget exhaustion, authentication, quota, configuration, tool, or other deterministic failures.
- Cancellation and session shutdown must interrupt retry waiting and release the child process.
- Keep the public subagent tool schemas unchanged.

## Design

`packages/pi-subagents/src/process.ts` remains the sole owner of the child RPC process. It will observe the final assistant error at `agent_settled`. When the error is transient and Pi has not already consumed the three-attempt budget, it sends a new `prompt` to the same idle RPC process telling the child to continue from its existing conversation and workspace state. Retries use bounded backoff and the existing parent `AbortSignal`.

The transient classifier will reuse Pi AI's public `isRetryableAssistantError()` and narrowly add the premature-stream phrases omitted by Pi 0.86. Native `auto_retry_start` events count toward the same three-retry budget, preventing the extension from stacking three more attempts after Pi already exhausted its own retries.

Every finalized non-error assistant message clears stale failure state. This also fixes successful Pi-native recovery being misreported as `partial` because an earlier failed message remained latched.

Rejected options:

- Respawn the job up to three times: loses the in-memory child conversation and repeats work.
- Persist a temporary session and restart Pi: more lifecycle and cleanup machinery than same-process RPC continuation requires.
- Retry every failed job: repeats deterministic failures and can duplicate unsafe work.

## Tasks

- [x] T1. Add same-process transient retry and stale-error reset — files: `packages/pi-subagents/src/process.ts`, `packages/pi-subagents/test/process.test.ts` — verify: `npx vitest run packages/pi-subagents/test/process.test.ts`
- [x] T2. Document retry behavior and release impact — files: `packages/pi-subagents/README.md`, `packages/pi-subagents/docs/tools.md`, `.changeset/subagents-transient-llm-retry.md` — verify: `npm run check`
- [x] T3. Integrate and verify the package/repository — files: generated `packages/pi-subagents/dist/*`, this plan — verify: `npm run check && npm test`, then `pi --no-extensions -e ./packages/pi-subagents`

`npm test` ran 4,488 tests: 4,487 passed and the unrelated `packages/pi-starship/test/skill.test.ts` failed because the user environment exposed two `pptx` skills with the same name. The focused subagent suite, repository checks, package pack inspection, and isolated RPC load smoke passed.
