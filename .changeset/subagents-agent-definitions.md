---
"@narumitw/pi-subagents": minor
---

Add agent definitions, two built-in agents, and background jobs to pi-subagents.

`subagent_spawn` gains an `agent` parameter naming a Markdown definition whose frontmatter supplies the child's model, tools, and thinking level, and whose body becomes the child's system prompt through `--append-system-prompt`. This leaves `task` free for the caller's own instructions. Explicit `tools` and `thinkingLevel` arguments still override the definition. Two built-ins, `explorer` (read-only exploration reported as `path:line` citations, `haiku`) and `builder` (implements and verifies one specified change, `sonnet`), are seeded into `~/.pi/agent/agents/` and refreshed on every load, so an upgrade always delivers the current prompt; customization belongs in a differently named definition, which seeding never touches. `explorer` carries `bash` so the full read-only shell toolbox is available to it, and its body rather than its tool list is what keeps it read-only.

Only `~/.pi/agent/agents/` is loaded into the main session, and only as names and descriptions rather than bodies, which keeps the roster at roughly two lines of context per agent. A name that is not there is resolved on demand across `~/.pi/agent/agents/`, `~/.claude/agents/`, and `~/.agents/agents/`, first directory wins, case-insensitive, so a skill can name an agent the session never advertised. The new `/agents` command lists the Pi directory alone, matching exactly what the session advertises.

`subagent_spawn` also gains `background`. A background job's completion is delivered as a steering interrupt that starts a main-agent turn, so the result is acted on without polling; the default blocking mode delivers the same completion without triggering a turn, because `subagent_wait` is already collecting it.

An agent's `model` is resolved by the parent against `model-alias.json`, since children run with `--no-extensions` and cannot resolve aliases themselves. An alias that does not resolve to a usable model falls back to the main agent's model and is reported as a job limitation rather than failing the spawn.
