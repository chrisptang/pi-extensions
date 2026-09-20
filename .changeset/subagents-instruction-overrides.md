---
"@chrisptang/pi-subagents": minor
---

Let `~/.pi/agent/subagent_instruction.md` replace the tool instructions the main session reads.

The `subagent_*` tool descriptions and prompt guidelines are written for the general case, and some models follow parts of them loosely. The wording is now the user's to own: a `##` heading names one tool and opens its section, prose becomes that tool's description, and a `### Guidelines` block's list items become its prompt guidelines. Text before the first heading is a preamble for humans and never reaches the model.

Replacement is whole-field rather than additive, because an appended rule competes with the shipped sentence it was written to correct and the losing half is the one the user cannot edit. A section with prose but no `### Guidelines` block keeps the shipped guidelines, and an empty `### Guidelines` block drops them, which is how a built-in bullet is removed.

`subagent_spawn`, `subagent_wait`, `subagent_cancel`, `subagent_inspect`, `subagent_send`, and `skill_run` are overridable; a heading naming anything else is reported through `/agents` rather than ignored silently. `/agents` also reports which tools were overridden and from where, so a file that failed to parse is visible instead of appearing to have worked.

The file is bounded to 64 KiB and 32 guidelines per tool, and a file that cannot be read or parsed leaves every tool on its built-in text, so a broken override never disarms the tools. It is read once at session start, so an edit applies to the next session.

This changes only what the main session reads. A subagent's own system prompt still comes from its agent definition in `~/.pi/agent/agents/`.
