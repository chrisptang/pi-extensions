---
"@narumitw/pi-subagents": minor
---

Add `/subagents`, an interactive panel for watching and terminating subagent jobs.

The panel lists every retained job, active and terminal, and shows the selected job's live activity: each tool call with a summary of its arguments, its outcome and result summary, the child's visible assistant text, and lifecycle notices. `↑↓` selects a job, `k` terminates it after a confirmation, and `esc` closes. Terminating releases that job's child process, timer, and broker credentials, keeps the file changes the child already made, and leaves other jobs running. A job stopped this way reports `Subagent execution was cancelled by the user.`, so the main agent can report the deliberate stop instead of retrying the work.

The child's tool activity is read from the RPC event stream it already emits; thinking is never forwarded out of the child, so no display path can reach it. Tool arguments are summarized rather than reproduced — `write` and `edit` report a path and a byte count instead of content — and credential-shaped text is redacted to `***` in everything displayed. Each job retains its most recent 200 events, each bounded to 512 bytes of display text. Nothing the panel shows enters the main agent's context.

The above-editor widget now also shows each active job's most recent activity line and points at `/subagents`.

`subagent_spawn` and `skill_run` now state the parallel-batch rule in their own contracts: batch them only for mutually independent tasks, and start a task that needs another's result only after collecting it. Concurrent execution of independent jobs was already the behavior and is now covered by regression tests that observe the overlap rather than only the returned job IDs.
