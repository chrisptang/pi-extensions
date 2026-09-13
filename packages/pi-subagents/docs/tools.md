# Pi Subagents tools

## When to use a subagent at all

The main session does the work; a subagent is the exception. A child starts cold, re-reads files this session already has, and its result must still be verified here, so delegating a task one tool call would finish is strictly worse than doing it.

A job earns its cost in three cases: the user asked for one, several genuinely independent tasks can run at once, or a wide search would flood the main context with files the session does not otherwise need.

Planning, the critical path, integration, deterministic checks, authorization decisions, and the final answer stay in the main session.

`subagent_spawn` states this to the model through its prompt guidelines. `~/.pi/agent/subagent_instruction.md` replaces them when a model needs a stricter rule.

## `subagent_spawn`

| Parameter | Type | Required | Constraint / default |
| --- | --- | --- | --- |
| `task` | `string` | Yes | Self-contained task, up to 50 KiB of UTF-8 text. |
| `description` | `string` | Yes | Short label shown in the active-jobs widget; truncated to 60 characters for display. |
| `agent` | `string` | No | Agent definition name, case-insensitive; see [agent definitions](../README.md#-agent-definitions). |
| `background` | `boolean` | No | `true` runs without blocking and interrupts the main agent when the job ends; defaults to `false`. |
| `tools` | `string[]` | No | Up to 64 names from `read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, and `ls`; defaults to the agent definition's tools, otherwise `read`, `grep`, `find`, and `ls`. |
| `thinkingLevel` | `string` | No | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; defaults to the agent definition's level, otherwise the main agent's effective thinking level. |
| `timeout` | `number` | No | Seconds; `> 0` through `2,147,483.647`; no default timeout. |

Starts one task-specialized subagent job with the selected tool capabilities and returns its job ID immediately.

The call does not wait for its child, and each job owns its own child process, so several spawns run concurrently. Batch them only for mutually independent tasks: every task must be completable without any other task in the batch, and none may consume another's result. When one task needs another's, spawn the first, collect its result, and only then spawn the second with that result in its task text. Parallel writers need disjoint file ownership; concurrent writes are not serialized or merged. All jobs share a maximum of eight active children.

The active-jobs widget labels the job with its `agent` name, or its job ID when no agent was selected, followed by `description`. That is the only place the job announces what it is doing while it runs, so the description should name the work rather than restate the agent. A description longer than 60 characters is truncated for display rather than rejected, so an over-long label never costs the caller a turn.

The runtime adds nothing to the selected tools. A child receives exactly what `tools` names, and no `subagent_*` tool ever reaches a child.

A definition's `model: inherit` keeps the main agent's model without reporting a limitation, the same as omitting the field.

`agent` appends the definition's body to the child's system prompt, so `task` stays free for the caller's own instructions. Explicit `tools`, `thinkingLevel`, and `model` arguments always override the definition's defaults. An unknown name throws before the job is queued.

The `agent` parameter description lists only the definitions in `~/.pi/agent/agents/`. A name that exists only in a fallback directory still resolves, which is how a skill names an agent the session never advertised.

The child inherits the main agent's effective provider and model at spawn time, unless the agent definition names a `model` that resolves to a usable one. An alias that cannot be resolved falls back to the inherited model and is reported as a job limitation.

`background: true` delivers the completion as a steering interrupt that starts a main-agent turn, so the main agent acts on the result without polling. The default blocking mode delivers the same completion without triggering a turn, because `subagent_wait` is already collecting the result.

Providers registered by a parent extension throw before the job is queued because children disable unrelated extensions.

A process-local runtime API key, including a parent-only `--api-key` value, also throws before queuing.

Use Pi's stored credentials or environment credentials that the child process can read.

Unavailable or extension-only tool names throw before the job is queued.

## `/agents`

Lists the agent definitions in `~/.pi/agent/agents/` with their descriptions, followed by any parse diagnostics from that directory.

The command deliberately never lists the fallback directories, so it reflects exactly what the session advertises.

It also reports whether `~/.pi/agent/subagent_instruction.md` replaced any tool instructions, and any diagnostics from parsing it. A file that failed to parse would otherwise be invisible, because the tools keep working on their built-in text.

## `skill_run`

| Parameter | Type | Required | Constraint / default |
| --- | --- | --- | --- |
| `name` | `string` | Yes | Skill name, case-insensitive. |
| `description` | `string` | Yes | Short label shown in the active-jobs widget; truncated to 60 characters for display. |
| `args` | `string` | No | The caller's request for the skill, up to 50 KiB of UTF-8 text. |
| `background` | `boolean` | No | `true` runs without blocking and interrupts the main agent when the job ends; defaults to `false`. |
| `tools` | `string[]` | No | Up to 64 names from `read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, and `ls`; defaults to the skill's translated `allowed-tools`, otherwise `read`, `grep`, `find`, and `ls`. |
| `thinkingLevel` | `string` | No | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; defaults to the skill's level, otherwise the main agent's effective level. |
| `timeout` | `number` | No | Seconds; `> 0` through `2,147,483.647`; no default timeout. |

Runs one skill inside a subagent and returns its job ID immediately, so the skill's instructions and intermediate work never enter the main session.

The skill's `SKILL.md` body becomes the child's system prompt, and `args` becomes the task. This keeps the skill's instructions separate from the caller's request, matching the boundary the skill was written against.

The body travels through `--append-system-prompt` rather than the 50 KiB `task`, so a skill larger than that bound runs unchanged.

Children run with `--no-skills` and cannot load the skill themselves, so the system prompt states the skill's directory and requires relative paths to be resolved against it. Multi-file skills therefore keep their `references/` and `scripts/` reachable, provided the child holds a read tool.

`allowed-tools` is translated from Claude Code's vocabulary into Pi's child work tools. Both list and comma-separated forms are accepted, the scoped `Bash(git:*)` spelling reduces to its base name, and `Glob` maps to `find`. Names with no Pi equivalent, such as `Task(...)`, `Skill(...)`, and `AskUserQuestion`, grant no child capability; they are dropped and reported as job limitations rather than failing the run. A skill left with no usable tool falls back to the read-only default so it can still read its own references.

`model: inherit` keeps the main agent's model, exactly as omitting the field does, and reports no limitation. Any other `model` resolves like an agent definition's, falling back to the inherited model and reporting a limitation when it cannot be honoured.

The `name` parameter description lists only the skills in `.pi/skills/` and `~/.pi/agent/skills/`. A skill that exists only in `~/.claude/skills/` or `~/.agents/skills/` still resolves when named directly.

`disable-model-invocation: true` removes a skill from that roster while leaving it runnable by explicit name, which is what the flag reserves it for.

An unknown name throws before the job is queued. Every spawn-time rule above — extension providers, runtime API keys, and unavailable tool names — applies unchanged.

## `/skills`

Lists the skills advertised to `skill_run` with their descriptions, followed by any parse diagnostics from those directories.

Like `/agents`, the command never lists the fallback directories, so it reflects exactly what the model can see.

## `subagent_inspect`

No parameters.

## `subagent_cancel`

| Parameter | Type | Required | Constraint / default |
| --- | --- | --- | --- |
| `jobId` | `string` | Yes | Job ID returned by `subagent_spawn`. |

Cancels one queued or running job idempotently and releases its child process, timer, and temporary resources. Other jobs are unaffected.

File changes the child already made are kept and are not rolled back, and the job's activity record stays readable in the `/subagents` panel.

A job a human terminated through `/subagents` reports `Subagent execution was cancelled by the user.` rather than the model-initiated wording, so the main agent can report the deliberate stop instead of restarting the work.

## `subagent_wait`

| Parameter | Type | Required | Constraint / default |
| --- | --- | --- | --- |
| `jobId` | `string` | Yes | Job ID to wait for. |
| `timeout` | `number` | No | Seconds; `> 0` through `2,147,483.647`; no default and does not cancel the job. |

Returns when the job reaches a terminal state. A timeout or caller cancellation stops only that wait and leaves the job running.

There is no early return for an incoming message: a child has no channel to send one. The only outcomes are terminal, timeout, and cancellation.

Subagents do not have this tool, or any other `subagent_*` tool.

## `/subagents`

Opens the inspection panel in TUI mode. Other modes report that the panel is unavailable and do nothing.

The panel lists every retained job with its agent, description, state, and elapsed time, and shows the selected job's `jobId`, work tools, timeout, and live activity. `↑↓` selects, `k` terminates after a confirmation, and `esc` closes.

The activity record holds tool calls with summarized arguments, their outcome and result summary, the child's visible assistant text, and lifecycle notices. It never holds the child's thinking, which is not forwarded out of the child process at all.

`write` and `edit` report a path and a byte count rather than content, and credential-shaped text is redacted to `***` in everything displayed. Redaction is a display safeguard, not a guarantee.

Each job retains its most recent 200 events, each bounded to 512 bytes of display text; older events are dropped and the panel reports how many. A job's record is released when the job is pruned.

The panel is a human surface. Nothing it displays enters the main agent's context.

## Nesting

Only the main session can create jobs. A child cannot spawn a grandchild.

Children are launched with `--no-extensions`, and no extension is injected in its place, so the extension defining every `subagent_*` tool is not loaded in a child process.

The `tools` allowlist holds the eight core work tools — `read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, `ls` — so `subagent_spawn` cannot be requested for a child, and an agent definition naming it has it dropped with a diagnostic.

Each child additionally inherits `PI_SUBAGENT_DEPTH` incremented by one, and `subagent_spawn` and `skill_run` refuse to run above zero. That layer is defence in depth: a child holding `bash` could unset the variable, but the process it runs in still has no spawn tool, so the guarantee rests on the tool set rather than the environment.

## `~/.pi/agent/subagent_instruction.md`

Replaces the instruction text the main session reads for the subagent tools. The file is optional: without it every tool keeps its built-in wording.

Use it when a model ignores a rule that matters to you. The built-in text is written for the general case, and a rule you add elsewhere competes with the shipped sentence it was meant to correct; this file replaces that sentence instead.

A `##` heading names one tool and opens its section. Prose in the section becomes the tool's description, and a `### Guidelines` block's list items become its prompt guidelines, which Pi renders as bullets in the system prompt's Guidelines list. Text before the first heading is a preamble for humans and never reaches the model.

```markdown
Notes to myself about how this session should delegate.

## subagent_spawn

Start one subagent job and return its jobId. Collect the result with subagent_wait.
Name the files each job owns before starting it.

### Guidelines

- Never start more than two jobs at once.
- State each job's owning files in its task.
```

Overridable sections: `subagent_spawn`, `subagent_wait`, `subagent_cancel`, `subagent_inspect`, `skill_run`. A heading naming anything else is reported through `/agents` rather than ignored.

Each field is replaced only where the file defines it. A section with prose but no `### Guidelines` block keeps the shipped guidelines; a `### Guidelines` block with no items drops them, which is how you remove a built-in bullet rather than adding to it.

Replacement is whole-field, so a description that omits the parameter contract omits it from what the model reads. Keep the parts that describe how the tool is called, such as collecting a `jobId` with `subagent_wait`, and rewrite the parts that describe when to use it.

The file is read once when the session starts, so an edit takes effect in the next session. It is bounded to 64 KiB and 32 guidelines per tool; past either bound the excess is dropped and reported. A file that cannot be read or parsed leaves every tool on its built-in text, so a broken override never disarms the tools.

The file changes only what the main session reads. A subagent's own system prompt comes from its agent definition in `~/.pi/agent/agents/`, which is already yours to edit.
