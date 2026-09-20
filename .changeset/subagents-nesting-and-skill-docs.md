---
"@chrisptang/pi-subagents": patch
---

Document that only the main session can create jobs, and why the example skill is not installed for you.

Nesting was listed as an unsupported feature but never described as an enforced one. The guarantee is structural: a child is launched with `--no-extensions`, so the extension defining `subagent_spawn` and `skill_run` is never loaded in a child process, and the only extension injected is the communication bridge, which registers `subagent_send` and `subagent_wait` and nothing else. The `tools` allowlist holds the eight core work tools, so a spawn tool cannot be requested for a child, and an agent definition naming one has it dropped with a diagnostic. The inherited `PI_SUBAGENT_DEPTH` guard is defence in depth rather than the guarantee, since a child holding `bash` could unset it; two tests now pin the structural layer, including that the bridge registers exactly two tools.

The `using-pi-subagents` example stays repository-only and is still not copied into `~/.pi/agent/skills/` on install. That directory feeds the `skill_run` roster, so the example — whose body is guidance about when to delegate — would become something the model can hand to a child to "execute". The README now explains this, and shows how to install it under your own name with `disable-model-invocation: true` for anyone who wants it, while pointing delegation rules that should apply every turn at `subagent_instruction.md` instead.
