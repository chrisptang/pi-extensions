---
"@chrisptang/pi-subagents": minor
---

Bound subagent exploration with a turn budget.

A child that cannot converge kept running until the caller noticed, because a timeout is the only bound and a timeout depends on how fast the model answers rather than on whether the work is progressing. `subagent_spawn` and `skill_run` now take `maxTurns`, a budget of model responses that defaults to 100. The child is told its budget in its system prompt, so it can pace the work from the start, and once 90% of the budget is used it is reminded how many turns remain.

Reaching the budget does not kill the child. It is steered to stop using tools and report what it found, so the knowledge it gathered comes back as a normal result carrying a limitation that names the budget. A child that keeps working three turns past the budget is stopped with the new `budget_exhausted` terminal state and whatever it last said. A report that happens to land on the budget turn completes untouched.

The active-jobs widget, the `/subagents` panel, and `subagent_inspect` show each job's turns used against its budget.
