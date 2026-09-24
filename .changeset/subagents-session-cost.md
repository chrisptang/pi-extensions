---
"@chrisptang/pi-subagents": minor
---

Report subagent spend to the main session. Every subagent tool result carries the tokens and cost the session's jobs spent since the previous one in Pi's tool-result `usage`, so footers include subagents in the session totals exactly once without counting them as main-agent context. Collapsed completion messages show the job's time, turns, tokens, and cost without adding them to model-visible content, and the widget shows each active job's cost and their total.
