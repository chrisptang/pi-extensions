---
"@narumitw/pi-subagents": minor
---

Run the main session as an agent definition, and ship `architect` as the third built-in.

A definition with `role: main` now describes this session rather than a child: its body is appended to the system prompt on every turn, and its `model` and `thinkingLevel` are applied when a fresh session starts. Select it with `pi --agent <name>`, or set `"mainAgent"` in `~/.pi/agent/subagents.json` as the default for every session; `--agent none` starts plain. `/agents` marks main-role definitions and reports which one the session runs as.

A main-role definition is left out of the `subagent_spawn` roster and refused by name, since a persona that delegates cannot run in a child that cannot.

The new built-in `architect` is such a definition. It answers the user directly, designs down to file boundaries and signatures, keeps a `docs/specs/<feature>.md` spec with a task list, sends `explorer` and `builder` the wide or heavy work, and verifies every report against the diff and a real check before ticking a task. Like the other built-ins it is seeded into `~/.pi/agent/agents/` and kept current on every load.
