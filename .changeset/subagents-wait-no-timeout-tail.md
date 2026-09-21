---
"@chrisptang/pi-subagents": major
---

Remove the `timeout` parameter from `subagent_wait`, and add `subagent_tail` for checking on a running job.

A wait timeout bought nothing: the job's turn and context budgets already bound it, and a wait that returned early with `timedOut: true` only cost the main agent another turn to wait again. Models that saw the parameter in the schema reached for it anyway, then re-waited in a loop. `subagent_wait` now returns only when the job ends or the caller cancels the wait, and its result no longer carries `timedOut`. The legacy `timeoutMs` alias is gone with it.

`subagent_tail(jobId, lines?)` returns at once with the job's state, elapsed time, turns against budget, time since its newest event, and the newest activity lines — the same redacted, 512-byte-bounded lines the `/subagents` panel shows: tool calls with summarized arguments and outcomes, visible assistant text, and lifecycle notes. It defaults to 10 lines and accepts up to 50, so the main agent can confirm a job is alive and roughly where it is without waiting for it. The tool is overridable through `~/.pi/agent/subagent_instruction.md` like the others.
