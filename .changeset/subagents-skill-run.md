---
"@chrisptang/pi-subagents": minor
---

Add `skill_run`, which executes a skill inside a subagent instead of loading it into the main session.

A skill invoked normally is expanded into the main context, so its instructions, intermediate file reads, and step-by-step work all accumulate there. `skill_run` sends the skill's `SKILL.md` body to a child through `--append-system-prompt` and keeps the caller's request in `task`, preserving the instruction/request boundary the skill was written against. Only the child's final result returns, so a long skill costs the main session roughly one tool call instead of its entire transcript.

The child runs with `--no-skills` and cannot load the skill itself, so its system prompt states the skill's directory and instructs it to resolve relative paths against that directory. This keeps `references/` and `scripts/` reachable for multi-file skills. The body travels as an argv entry rather than in the 50 KiB `task`, so skills well past that bound run unchanged.

Skills authored for Claude Code are read as-is. `allowed-tools` is translated into Pi's child work tools, accepting both list and comma-separated forms and the scoped `Bash(git:*)` spelling; `Glob` maps to `find`. Names with no Pi equivalent, such as `Task(...)` or `AskUserQuestion`, carry no capability into a child, so they are dropped and reported as job limitations rather than failing the run. `model: inherit` is treated as no declared model, and a skill granting no usable tool falls back to the read-only default so it can still read its own reference files.

Discovery scans `.pi/skills/` in the project, then `~/.pi/agent/skills/`, `~/.claude/skills/`, and `~/.agents/skills/`, first directory wins, case-insensitive, following symlinked skill directories. Only the project and Pi directories are advertised, as names and descriptions rather than bodies; a skill elsewhere stays reachable by name. `disable-model-invocation` hides a skill from that roster while leaving it runnable when named explicitly. The new `/skills` command lists exactly what is advertised.
