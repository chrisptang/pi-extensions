---
"@narumitw/pi-subagents": major
---

Remove the execution `timeout` parameter from `subagent_spawn` and `skill_run`, and the `timed_out` job state with it.

A wall-clock deadline measures how fast the model answers, not whether the work is progressing, so a slow provider could kill a job that was converging. The turn budget, `maxTurns`, already bounds exploration independently of model speed and remains the only limit on a job. `subagent_wait` keeps its `timeout`, which bounds the caller's wait and never touches the job.
