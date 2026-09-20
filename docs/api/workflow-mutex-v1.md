# Workflow Mutex Protocol v1

- **Status:** Implemented protocol with release-ready Plan and Goal conformance evidence.
- **Transport:** Pi's process-local `pi.events` bus.
- **Purpose:** Ensure at most one participating agent workflow is active in the same Pi session.

## Scope

This protocol is an anonymous cooperative mutex.

It coordinates only whether a workflow group is busy in one session.

It does not identify the holder, control another workflow, transfer state, or compose tool policies.

The words **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are normative.

## Contract

The v1 channel is:

```text
workflow:mutex:v1
```

The channel identifies the version, so the payload does not repeat it.

The v1 payload is:

```ts
interface WorkflowMutexAttemptV1 {
	session: object;
	group: string;
	busy: boolean;
}
```

A conforming requester MUST create a fresh mutable object with exactly these values:

```ts
const attempt: WorkflowMutexAttemptV1 = {
	session: ctx.sessionManager,
	group: "agent-workflow",
	busy: false,
};
```

| Field | Meaning |
| --- | --- |
| `session` | The current `ctx.sessionManager` object, compared by JavaScript identity. |
| `group` | An opaque exclusion group compared by exact string equality. |
| `busy` | A monotonic result that starts as `false` and may only change to `true`. |

The only group defined by this specification is `agent-workflow`.

Unknown groups do not conflict with `agent-workflow`.

Unknown properties have no protocol meaning, and conforming participants MUST NOT add identity or control data to the payload.

## Participant state

Each participant owns only local, session-bound state:

```ts
type LocalWorkflowMutexOwner = symbol;

interface LocalWorkflowMutexState {
	session?: object;
	heldGroups: Map<string, LocalWorkflowMutexOwner>;
	generation: number;
}
```

`heldGroups` is the authoritative in-memory ownership record for this protocol.

Each successful acquisition receives a new local owner symbol so stale cleanup cannot release a newer workflow.

The owner symbol is never emitted, persisted, or shared.

A workflow's persisted state does not itself hold the mutex.

The participant MUST bind the current `ctx.sessionManager` to local `session` before attempting acquisition or answering requests for that session.

The participant MUST invalidate the binding and stop owned work during `session_shutdown`.

Pi automatically removes tracked `pi.events` subscriptions when an extension runtime becomes stale, but participants MUST still clear their session-bound state explicitly.

## Listener behavior

Every participant MUST register one v1 listener during extension factory registration so it exists before `session_start` restoration.

The listener MUST be synchronous, return `void`, perform no asynchronous work, and contain no `await`.

The listener MUST ignore malformed payloads without throwing.

A request is relevant only when all of these conditions hold:

1. The payload is a non-null, non-array object.
2. `session === localState.session`.
3. `group` is a string recognized by the participant.
4. `busy` is a boolean.

For a relevant request, the listener MUST set `busy = true` when `heldGroups` has the requested group.

Otherwise, the listener MUST leave the payload unchanged.

The listener MUST NOT set `busy` to `false`.

The listener MUST NOT emit another event, start or stop work, change tools, persist state, show UI, or inspect another participant.

A listener failure is not reported to the requester by `pi.events`, so a conforming listener MUST not throw.

A minimal listener has this shape:

```ts
pi.events.on("workflow:mutex:v1", (data) => {
	if (!data || typeof data !== "object" || Array.isArray(data)) return;

	const attempt = data as Partial<WorkflowMutexAttemptV1>;
	if (attempt.session !== localState.session) return;
	if (attempt.group !== "agent-workflow") return;
	if (typeof attempt.busy !== "boolean") return;
	if (!localState.heldGroups.has(attempt.group)) return;

	attempt.busy = true;
});
```

Production parsing SHOULD use guarded property reads so an unusual object cannot make the listener throw.

## Acquisition

A participant MUST finish every asynchronous preflight before the final acquisition attempt.

Preflight MUST NOT mutate workflow state, persistent entries, prompts, active tools, or work queues.

Immediately before emitting, the requester MUST capture the current session binding, generation, and product-specific workflow candidate.

The requester then MUST perform this sequence without an `await`:

1. Create a fresh v1 attempt with `busy: false`.
2. Emit the v1 channel.
3. Revalidate the captured session, generation, and workflow candidate.
4. Verify that `session` and `group` are unchanged.
5. Accept only when `busy === false`.
6. Create a new local owner symbol and add the group-owner pair to `heldGroups` as the first ownership mutation.
7. Return the local owner symbol to the activating workflow.

The acquisition MUST fail closed if `emit()` throws, the attempt is mutated unexpectedly, or local ownership becomes stale during synchronous event re-entry.

No workflow, persistence, prompt, tool, or queue mutation may occur when acquisition fails.

User-facing failure SHOULD say only that another workflow is active in the session.

A requester MUST NOT use this channel as a read-only holder query and then delay its ownership commit.

The critical section is the synchronous interval from `emit()` through `heldGroups.set(group, owner)`.

JavaScript run-to-completion prevents two conforming top-level attempts from interleaving inside that interval.

Protocol listener purity prevents a nested acquisition from being started while another attempt is being dispatched.

## Activation after acquisition

After adding the group-owner pair to `heldGroups`, the participant MAY perform the product-specific state, persistence, prompt, tool, and queue changes required to activate its workflow.

The participant MUST continue reporting `busy: true` for matching attempts while activation is pending.

If activation fails, the participant MUST roll back its partial activation before releasing the group.

Every callback that may outlive activation MUST carry the participant's existing session, generation, and workflow ownership guards.

Every path that emits another `pi.events` event MUST revalidate those guards afterward because sibling listeners can synchronously re-enter the extension.

## Release

There is no release channel and no wire-level or transferable lock token.

A participant releases a group only when its supplied local owner symbol still equals `heldGroups.get(group)`.

A stale or repeated release is a no-op.

Before release, the participant MUST:

1. Prevent new owned work from being scheduled.
2. Cancel or stale-guard every owned task that could resume the workflow.
3. Complete the product-specific transition out of the mutex-holding state.
4. Restore or clear the workflow's owned prompt and tool policy as required by that product.

Removing the matching group-owner pair MUST be the final synchronous ownership step.

A workflow that remains automatically executable or resumable MUST continue holding the group.

A workflow that requires a new explicit user admission MAY release it after all automatic work is disabled.

## Restoration and replacement

A restored workflow MUST acquire the group before reapplying its active prompt or tool policy and before scheduling any automatic work.

If the mutex is busy during restoration, the workflow MUST enter an existing safe non-running state and MUST NOT alter the active workflow's tools or prompt.

When unsupported historical state contains multiple active workflows, synchronous acquisition order selects at most one protocol holder.

Product-specific restrictive-tool fail-safes remain required for mixed versions and historical collisions.

A session switch, fork, reload, or shutdown releases only the old runtime's in-memory ownership.

The replacement runtime reconstructs product state and performs a new attempt with the replacement session's `ctx.sessionManager` object.

## Guarantees

When every contender conforms to v1 within one Pi process and one shared event bus:

- At most one participant holds `agent-workflow` for the same `ctx.sessionManager` object.
- Different sessions and different groups do not block one another.
- A rejected attempt has no workflow or tool-policy side effects.
- The decision exposes no holder identity.
- Installing a participant alone preserves standalone behavior because no listener reports the mutex as busy.

## Non-guarantees

The protocol does not provide:

- Exclusion against non-participating or pre-v1 extensions.
- Exclusion across processes or separate Pi event buses.
- Fairness, queuing, priority, timeout, expiry, dead-holder recovery, or distributed locking.
- A security boundary between trusted extensions.
- Tool-policy composition or protection from unrelated `setActiveTools()` calls.
- Workflow start, stop, resume, cancellation, handoff, status, or completion RPC.

This is a cooperative mutex, not a lease, because it has no deadline, renewal, or expiry.

The local owner symbol is only a stale-cleanup guard and is not a protocol token.

## Versioning

The versioned channel MUST change for a breaking change.

Changing field meaning, listener timing, session identity, busy-result semantics, or release semantics is breaking.

V1 participants MUST NOT infer compatibility with an unknown channel version.

A dual-version migration requires a separate specification because emitting multiple acquisition channels can violate atomicity.

Packages MUST document the minimum counterpart versions required for guaranteed coexistence.

The first release-intent versions derived from the repository Changesets are `@narumitw/pi-plan-mode@0.52.0` and `@chrisptang/pi-goal@0.53.0`.
These are compatibility floors, not evidence that either package has been published.
A v1 participant operating beside a pre-v1 extension remains standalone-compatible but cannot claim mutual exclusion.

## Required Pi behavior

The deterministic characterization in [`test/workflow-mutex-runtime.test.ts`](../../test/workflow-mutex-runtime.test.ts) covers the repository's exact installed Pi version, `@earendil-works/pi-coding-agent@0.84.2`.
The root `package.json` and `package-lock.json` pin that version, and the test imports only public package-root APIs.
V1 coexistence is supported only on this characterized version.
Earlier releases, later releases, forks, and separately loaded Pi runtimes are uncharacterized and cannot receive the v1 coexistence guarantee until the same evidence passes for them.

V1 depends on these Pi runtime properties:

1. Loaded extensions share one process-local event bus.
2. `pi.events.emit()` begins every registered listener synchronously before returning.
3. All extension contexts for one active session expose the same `sessionManager` object identity.
4. Stale extension runtimes unsubscribe their tracked event-bus listeners.

The characterized Pi runtime uses Node's synchronous `EventEmitter` dispatch behind an async error-catching wrapper.

Only mutations performed before a listener first yields are visible to the requester before `emit()` returns.
The characterization proves shared delivery across inline extension factories, synchronous listener start and mutation, exact `sessionManager` identity across runner contexts, and tracked-listener cleanup after runtime invalidation.

These properties MUST have deterministic characterization tests before a package claims v1 support.

If a supported Pi version stops satisfying any property, participants MUST fail safe and withdraw the coexistence claim until the protocol is revised.

## Product conformance

`@narumitw/pi-plan-mode` and `@chrisptang/pi-goal` each implement v1 in a package-local module without importing, identifying, or depending on the other extension.
[`test/plan-goal-coexistence.test.ts`](../../test/plan-goal-coexistence.test.ts) covers both source load orders, both acquisition orders, restoration, tool-write rejection, release and reacquisition, standalone parity, and built generated entries on one public Pi event bus.
Package-focused mutex suites cover each participant's activation, rollback, waiting, continuation, settings, managed-run, and lifecycle boundaries.
The coexistence claim applies only at or above both documented package floors on the characterized Pi runtime.
No publication, tag, visibility change, or release workflow is implied by this conformance status.

## Conformance tests

A v1 implementation MUST cover:

- No holder allows acquisition.
- A holder reports busy for the same session and group.
- A holder does not report busy for another session or group.
- Later listeners cannot clear an earlier `busy: true` result.
- Malformed payloads do not throw or change local state.
- Unexpected payload mutation and `emit()` failure reject the attempt.
- Two contenders in either load and attempt order produce exactly one holder.
- Synchronous event re-entry makes a stale requester fail before ownership commit.
- A rejected attempt changes no workflow state, persistence, prompt, active tools, or queue.
- Activation failure rolls back before release.
- Restored state acquires before tools, prompt, or automatic work.
- A stale release cannot clear a newer local owner for the same group.
- Session replacement and shutdown leave no stale holder or listener.
- A non-v1 participant is described as unsupported rather than falsely detected.

The transport characterization and product conformance tests are both required because product tests alone must not silently depend on undocumented `pi.events` timing.
