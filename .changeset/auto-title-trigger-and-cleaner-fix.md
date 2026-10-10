---
"@chrisptang/pi-auto-title": patch
---

Fix two auto-titling defects: the trigger now counts real user turns from session entries instead of `agent_start` events, so injected turns (queued messages, subagent completions) can neither satisfy the trigger early nor push the counter past `triggerTurn` and permanently skip naming; and `cleanTitle` now strips ASCII and CJK brackets (`【】「」《》()` etc.) leaked at title edges in addition to quotes.
