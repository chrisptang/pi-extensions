---
"@chrisptang/pi-subagents": minor
---

Replace the granted tool list in the `/subagents` detail view with what the child is spending: the model it runs, its context size against that model's window, its cache hit rate, prompt and output token totals, and its cost so far. Counts come from the child's own responses, with context size following Pi core's own gauge, and the model's context window resolved by the parent at spawn.
