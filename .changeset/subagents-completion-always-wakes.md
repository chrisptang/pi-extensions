---
"@chrisptang/pi-subagents": minor
---

Wake the main agent on every job completion: a completion delivered while the session is streaming still steers the running turn, and at an idle session it now starts a new turn so results are never left uncollected. The `background` spawn and `skill_run` parameter is removed because it no longer changes behavior.
