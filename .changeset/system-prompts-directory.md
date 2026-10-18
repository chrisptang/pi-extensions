---
"@chrisptang/pi-auto-title": minor
"@chrisptang/pi-compaction-prompt": patch
"@chrisptang/pi-subagents": patch
---

Support user and trusted-project `system-prompts/auto-title.md` overrides with a built-in fallback, and use a uniform 500-character context limit per role per turn.

Read compaction prompts and subagent tool-instruction overrides from `system-prompts/`, retaining read-only compatibility with their legacy paths.
