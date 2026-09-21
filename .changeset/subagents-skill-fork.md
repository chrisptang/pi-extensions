---
"@chrisptang/pi-subagents": minor
---

Run a user's `/skill:<name>` in a subagent when the skill declares `content: fork`.

A skill typed as `/skill:<name>` expanded into the main session, so a skill that exists to keep its work out of that context — a commit helper, for example — added its every step to it. Skills whose frontmatter declares Claude Code's `content: fork` now start as a subagent job instead, through the same path as `skill_run`: the body is the child's system prompt, text after the name is its request, and the skill's `model`, `allowed-tools`, and `thinkingLevel` apply. The completion interrupts the main agent so it reports the result. Skills without `content: fork`, and skills the model runs itself, behave as before.
