# Pi Subagents tools

## `subagent_spawn`

| Parameter | Type | Required | Constraint / default |
| --- | --- | --- | --- |
| `task` | `string` | Yes | Self-contained task, up to 50 KiB of UTF-8 text. |
| `agent` | `string` | No | Agent definition name, case-insensitive; see [agent definitions](../README.md#-agent-definitions). |
| `background` | `boolean` | No | `true` runs without blocking and interrupts the main agent when the job ends; defaults to `false`. |
| `tools` | `string[]` | No | Up to 64 names from `read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, and `ls`; defaults to the agent definition's tools, otherwise `read`, `grep`, `find`, and `ls`. |
| `thinkingLevel` | `string` | No | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; defaults to the agent definition's level, otherwise the main agent's effective thinking level. |
| `timeout` | `number` | No | Seconds; `> 0` through `2,147,483.647`; no default timeout. |

Starts one task-specialized subagent job with the selected tool capabilities and returns its job ID immediately.

The runtime always adds `subagent_send` and `subagent_wait` to the selected tools.

A definition's `model: inherit` keeps the main agent's model without reporting a limitation, the same as omitting the field.

`agent` appends the definition's body to the child's system prompt, so `task` stays free for the caller's own instructions. Explicit `tools`, `thinkingLevel`, and `model` arguments always override the definition's defaults. An unknown name throws before the job is queued.

The `agent` parameter description lists only the definitions in `~/.pi/agent/agents/`. A name that exists only in a fallback directory still resolves, which is how a skill names an agent the session never advertised.

The child inherits the main agent's effective provider and model at spawn time, unless the agent definition names a `model` that resolves to a usable one. An alias that cannot be resolved falls back to the inherited model and is reported as a job limitation.

`background: true` delivers the completion as a steering interrupt that starts a main-agent turn, so the main agent acts on the result without polling. The default blocking mode delivers the same completion without triggering a turn, because `subagent_wait` is already collecting the result.

Providers registered by a parent extension throw before the job is queued because children disable unrelated extensions.

A process-local runtime API key, including a parent-only `--api-key` value, also throws before queuing.

Use Pi's stored credentials or environment credentials that the child process can read.

Unavailable or extension-only tool names throw before the job is queued.

Throws without launching a child when the session broker is unavailable.

## `/agents`

Lists the agent definitions in `~/.pi/agent/agents/` with their descriptions, followed by any parse diagnostics from that directory.

The command deliberately never lists the fallback directories, so it reflects exactly what the session advertises.

## `skill_run`

| Parameter | Type | Required | Constraint / default |
| --- | --- | --- | --- |
| `name` | `string` | Yes | Skill name, case-insensitive. |
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

An unknown name throws before the job is queued. Every spawn-time rule above — extension providers, runtime API keys, unavailable tool names, and broker availability — applies unchanged.

## `/skills`

Lists the skills advertised to `skill_run` with their descriptions, followed by any parse diagnostics from those directories.

Like `/agents`, the command never lists the fallback directories, so it reflects exactly what the model can see.

## `subagent_inspect`

No parameters.

## `subagent_cancel`

| Parameter | Type | Required | Constraint / default |
| --- | --- | --- | --- |
| `jobId` | `string` | Yes | Job ID returned by `subagent_spawn`. |

## `subagent_wait`

### Main agent

| Parameter | Type | Required | Constraint / default |
| --- | --- | --- | --- |
| `jobId` | `string` | Yes | Job ID to wait for. |
| `timeout` | `number` | No | Seconds; `> 0` through `2,147,483.647`; no default and does not cancel the job. |

Returns `{ jobId, state, timedOut: false, interrupted: true, reason: "subagent_message" }` without cancelling the job when a child request or response arrives.

### Subagent

| Parameter | Type | Required | Constraint / default |
| --- | --- | --- | --- |
| `requestId` | `string` | Yes | Request ID returned by a child-originated `subagent_send`. |
| `timeout` | `number` | No | Seconds; `> 0` through `2,147,483.647`; no default and does not cancel the request. |

Returns the main agent's response as plain text.

A timeout, caller cancellation, or incoming main-agent request throws and stops only that wait, so the child may wait for the same request again.

The runtime interrupts an active child wait only after Pi RPC accepts the incoming main request for steering.

## `subagent_send`

Main and child processes receive separate provider-visible definitions for their own context.

### Main agent

| Parameter | Type | Required | Constraint / default |
| --- | --- | --- | --- |
| `recipient` | `string` | Conditional | Active job ID for a new request. |
| `requestId` | `string` | Conditional | Pending child request to answer. |
| `message` | `string` | Yes | Plain-text request or response, up to 48 KiB of UTF-8 text and 1,992 lines. |

Provide exactly one of `recipient` or `requestId`.

A new request provides an active queued or running job ID as `recipient` and omits `requestId`.

A response provides `requestId` and omits `recipient`.

### Subagent

| Parameter | Type | Required | Constraint / default |
| --- | --- | --- | --- |
| `requestId` | `string` | No | Pending main-agent request to answer; omit to start a new request to main. |
| `message` | `string` | Yes | Plain-text request or response, up to 48 KiB of UTF-8 text and 1,992 lines. |

A new request omits `requestId` and returns a request ID immediately for an optional `subagent_wait` call.

A response provides the pending main-agent `requestId`.

A main-originated request waits for the child RPC prompt to be accepted and then uses Pi steering to reach the running child.

After steering is queued, the runtime interrupts active child response waits without consuming their original requests.

Caller cancellation before RPC delivery starts rolls the request back.

Once RPC delivery starts, cancellation stops only the caller's wait; the request may still arrive and remains answerable until delivery fails or the job terminates.

A child response arrives asynchronously in the main session and interrupts the next active main-agent `subagent_wait`, including when the response arrived immediately before the wait started.

The first accepted response wins, and repeated responses acknowledge the existing response without replacing it.

Each job may have up to four unresolved or answered-but-not-consumed requests across both directions.

Requests and responses are limited to 1,992 lines so their protocol envelopes fit Pi's 2,000-line model-text bound.

Terminal jobs, unknown requests, cross-job responses, responses from the request originator, and stale session credentials throw.

A successful call returns `{ requestId, accepted, duplicate }`.
