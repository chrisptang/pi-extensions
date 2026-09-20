---
"@chrisptang/pi-subagents": patch
---

Treat `model: inherit` as inheritance rather than a failed alias lookup.

An agent definition declaring `model: inherit` already ran on the main agent's model, because an unresolvable alias falls back to it. It also reported a job limitation saying the alias `inherit` was not defined in `model-alias.json`, which described a lookup failure rather than the requested behaviour. `resolveAgentModel` now recognises `inherit`, case-insensitively, as the explicit spelling of what omitting the field does, so the job inherits the model and reports nothing. A genuinely undefined alias still falls back and still reports.

`skill_run` already normalised `inherit` away at read time and is unaffected; it now shares the same helper so both paths agree on the meaning.
