# 🧩 Pi Subagents — One-Way Subagent Jobs

[![npm](https://img.shields.io/npm/v/@narumitw/pi-subagents)](https://www.npmjs.com/package/@narumitw/pi-subagents) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Pi Subagents runs Pi jobs in separate child processes. A job is one-way by design: the main session starts it, watches it, and reads its final result. A child has no channel back to the parent — when it hits a decision it cannot make, it returns the decision instead of asking.

## 🎯 What this is for

**The main session does the work. A subagent is the exception, not the default.**

Subagents are expensive in ways a model cannot see: a child starts cold and re-reads files this session already has, its result still has to be verified here, and every job is one more thing for you to track. Delegating a task that one tool call would finish is strictly worse than doing it.

There are three cases where a job earns its cost:

1. **The user asked for one.**
2. **Several genuinely independent tasks can run at once** — none needs another's result, and parallel writers own disjoint files.
3. **A wide search or file survey would flood the main context** — the child reads twenty files and returns the three-line answer.

Everything else belongs in the main session: planning, the critical path, integration, running tests, authorization decisions, and the final answer to the user.

This shapes the design rather than just the documentation. Jobs are one-way so there is no conversation to manage. A child holds only the work tools you name and no `subagent_*` tool at all, so it cannot spawn or coordinate anything. The tool contract states the restraint rule to the model as a system-prompt guideline, and [`subagent_instruction.md`](#-customizing-the-tool-instructions) lets you tighten it further for a model that over-delegates.

## ✨ Features

- Runs each job in an isolated Pi child process and returns its job ID immediately.
- Tells the model to do the work itself by default, and names the three cases where a job is worth its cost.
- Uses the task to define the child's specialization and the tool list to limit its capabilities.
- Ships two built-in agent definitions, `explorer` and `builder`, seeded into `~/.pi/agent/agents/` and kept current on every load.
- Runs a skill inside a subagent through `skill_run`, keeping its instructions and intermediate work out of the main session.
- Advertises only that directory's definitions, and resolves any other name on demand from `~/.claude/agents/` and `~/.agents/agents/`.
- Runs a job blocking or in the background, where a background completion interrupts the main agent with the result.
- Defaults work tools to `read`, `grep`, `find`, and `ls`.
- Inherits the main session's effective model and thinking level, so a job needs neither argument unless you deliberately want a different one.
- Publishes one asynchronous terminal completion and shows active-job progress above the editor.
- Opens `/subagents` so you can watch a job's tool activity and visible output live, and terminate one after confirming.
- Redacts credential-shaped text and reports file writes by size, so an inspected job never puts a secret on screen.
- Lets `~/.pi/agent/subagent_instruction.md` replace the tool instructions the main session reads, for a model that ignores the built-in wording.
- Gives a child no tool to reach the parent at all: it loads no extensions and holds only its selected work tools, so it cannot spawn a grandchild or message anyone.
- Starts independent jobs concurrently, up to eight active children.
- Exposes privacy-filtered metadata without task text, output, prompts, or selected tools.
- Cancels session-owned work during replacement, reload, or shutdown.

## 📦 Install

The version 3 runtime documented here is not yet published to npm.
The npm package still contains the legacy 2.x runtime and does not provide the tools below.

Install the repository source as one Pi package:

```bash
pi install git:github.com/narumiruna/pi-extensions
```

This Git installation enables every extension listed in the repository root manifest, including Pi Subagents.

To install only Pi Subagents, clone the repository, install dependencies, build its generated runtime, and install its package directory:

```bash
git clone https://github.com/narumiruna/pi-extensions.git
cd pi-extensions
npm install
npm --workspace @narumitw/pi-subagents run build
pi install ./packages/pi-subagents
```

Build before trying the extension from a local checkout:

```bash
npm --workspace @narumitw/pi-subagents run build
pi --no-extensions -e ./packages/pi-subagents
```

The package entry is generated at `dist/index.ts` and loaded through Pi's Jiti runtime.
An unbuilt local package directory cannot load its declared extension entry.

Pi extensions and children with `bash`, `powershell`, `edit`, or `write` execute with your user permissions.
Review the source before installing or invoking the extension.

## 🚀 Quick start

First decide whether you need a subagent at all — see [What this is for](#-what-this-is-for). Most tasks are finished faster in the main session.

When a job does earn its cost, call `subagent_spawn` with a self-contained task and only the work tools that task needs.

The call returns a `jobId` immediately, and the job continues in the background.
Continue useful main-agent work until the result is required or a completion arrives.

Collect the result with `subagent_wait`, or let a `background: true` job interrupt you with its completion.

While a job runs you can watch it and stop it, but you cannot talk to it. If a child needs a decision, it ends and reports what it needs; you then decide and, if useful, start a fresh job with the answer written into its task.

Completion messages follow Pi's global tool-output expansion state and the `app.tools.expand` binding (`Ctrl+O` by default).

In TUI mode, the above-editor widget shows each queued or running job's ID, state, elapsed time, timeout, selected work tools, and its most recent activity line.
The widget disappears when no jobs remain active, and clears when the session ends.

Run `/subagents` for the full inspection panel. See [Inspecting and terminating jobs](#-inspecting-and-terminating-jobs).

## 🛠️ Tools

The main Pi session exposes five fixed tools and the `/agents`, `/skills`, and `/subagents` commands:

| Tool | Parameters | Purpose |
| --- | --- | --- |
| `subagent_spawn` | `task`, `description`, optional `agent`, `background`, `tools`, `thinkingLevel`, `timeout` | Start one subagent job and return its `jobId`. |
| `skill_run` | `name`, `description`, optional `args`, `background`, `tools`, `thinkingLevel`, `timeout` | Run one skill inside a subagent and return its `jobId`. |
| `subagent_inspect` | none | List privacy-filtered retained-job metadata. |
| `subagent_cancel` | `jobId` | Idempotently cancel one queued or running job. |
| `subagent_wait` | `jobId`, optional `timeout` | Wait for one job to reach a terminal state. |

A child receives **only** its selected work tools. No `subagent_*` tool is added to a child, so it cannot spawn, cancel, inspect, wait on, or message anything: its final message is its only output.

Execution and wait timeouts use seconds, accept finite numbers greater than zero through 2,147,483.647, and have no default.
Omitting a job execution timeout lets the child run until it exits, is cancelled, the session shuts down, or the Pi process exits.
A wait timeout or caller cancellation stops only that wait and does not cancel its job.

Tasks are limited to 50 KiB of UTF-8 text.
The terminal states are `completed`, `partial`, `failed`, `timed_out`, and `cancelled`.
`subagent_inspect` never returns complete task text, child output, prompts, selected tools, context, credentials, environment variables, or secrets.

See [`docs/tools.md`](./docs/tools.md) for the concise schema reference.

## ⚙️ Job configuration

The task should state the child's role, objective, scope, constraints, and expected result.
For reusable delegation policy, you can create your own project skill under `.pi/skills/<your-skill>/SKILL.md` or global skill under `~/.pi/agent/skills/<your-skill>/SKILL.md`.
Choose its name, trigger, tool policy, task format, and verification workflow for your use case.
The package intentionally registers and publishes no skill; the repository-only [`using-pi-subagents` example](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-subagents/skills/using-pi-subagents) is an optional starting point.

Installing is deliberately left to you, and the example is not copied into `~/.pi/agent/skills/` on install, for two reasons.
A skill in that directory joins the `skill_run` roster, so the example — whose body is guidance about *when to delegate* — would become something the model can hand to a child to "execute", which is meaningless work.
And unlike the built-in agent definitions, which are argument values `subagent_spawn` cannot work without, a delegation skill is policy text the extension is complete without.

If you do want it installed, copy it under a name of your own and hide it from the roster:

```bash
mkdir -p ~/.pi/agent/skills/my-delegation-policy
cp packages/pi-subagents/skills/using-pi-subagents/SKILL.md \
   ~/.pi/agent/skills/my-delegation-policy/SKILL.md
```

Then set `name: my-delegation-policy` in its frontmatter and add `disable-model-invocation: true`, which keeps it callable by name while leaving it out of what the model is offered.

For delegation rules you want the main session to follow on *every* turn rather than only when a skill is loaded, prefer [`subagent_instruction.md`](#-customizing-the-tool-instructions): its guidelines are rendered into the system prompt each turn.

The optional `tools` list limits what the child can do:

- Accepted names are `read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, and `ls`.
- Unavailable or extension-only tool names are rejected before a job is queued.
- Omitting `tools` selects `read`, `grep`, `find`, and `ls`.
- Passing an empty list gives the child no work tools.
- Duplicate names are removed. Nothing else is added: a child gets exactly the work tools you select.

Adding `edit` or `write` lets the child modify files.
Adding `bash` or `powershell` grants unrestricted command execution and can also modify the workspace.

The optional `thinkingLevel` accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.
Omitting `thinkingLevel` captures the main agent's effective level when `subagent_spawn` executes.
The child inherits the main agent's effective provider and model when `subagent_spawn` executes, unless an agent definition names a model.

Spawn rejects providers registered by a parent extension because child processes disable unrelated extensions.
Spawn also rejects process-local runtime API keys, including a parent-only `--api-key` value.
Use stored or environment credentials that child processes can read.

### Blocking and background jobs

Both modes start the same way and return a `jobId` immediately.

- The default blocking mode expects the caller to collect the result with `subagent_wait`.
- `background: true` interrupts the main agent with the completion and starts a turn, so the result is acted on without polling.

Use background for work whose result is not needed to continue the current step, and blocking when the next step depends on the answer.

## 🧬 Agent definitions

An agent definition is a Markdown file with YAML frontmatter that names a reusable child specialization:

```markdown
---
name: explorer
description: Read-only codebase exploration. Searches, reads, and reports findings as a structured summary with path:line citations.
model: haiku
tools: read, grep, find, ls, bash
---

You are a read-only codebase explorer.
```

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | No | Lookup name; defaults to the filename. Lower-cased, `[a-z0-9][a-z0-9_-]*`. |
| `description` | Yes | One line, up to 200 characters, shown in `/agents` and in the `agent` parameter. |
| `model` | No | Alias or `provider/modelId`, resolved by the parent at spawn time. |
| `tools` | No | Default work tools for this agent. |
| `thinkingLevel` | No | Default thinking level for this agent. |

The body, up to 50 KiB, becomes the child's system prompt, so `task` stays free for the caller's own instructions.

### Where definitions are loaded from

Only `~/.pi/agent/agents/` is loaded into the main session, and only its names and descriptions, not the bodies.
That keeps the context cost at roughly two lines per agent, which matters for models that struggle to drive a large subagent roster.

When a spawn names an agent that is not there, the extension scans, in order:

1. `~/.pi/agent/agents/`
2. `~/.claude/agents/`
3. `~/.agents/agents/`

The first directory defining a name wins, and matching is case-insensitive.
So a skill can name an agent the session never advertised, without every definition on the machine costing main-session context.
`PI_CODING_AGENT_DIR` overrides the Pi directory's location.

### Built-in agents

The extension writes `explorer.md` and `builder.md` into `~/.pi/agent/agents/`, keeping them current on every load.

| Agent | Model | Tools | Purpose |
| --- | --- | --- | --- |
| `explorer` | `haiku` | `read`, `grep`, `find`, `ls`, `bash` | Read-only exploration that reports findings with `path:line` citations. |
| `builder` | `sonnet` | `read`, `grep`, `find`, `ls`, `edit`, `write`, `bash` | Implements one specified change and verifies it before reporting. |

`explorer` holds `bash` so the full read-only shell toolbox — `rg`, `sed -n`, `tree`, `git log` — is available to it; its body, not the tool list, is what keeps it read-only.

The built-ins are owned by the extension, so every load rewrites a file whose contents differ from the shipped definition and an upgrade always delivers the current prompt.
A file that already matches is left alone, so repeated loads do not churn it.

That means edits to `explorer.md` and `builder.md` are replaced on the next upgrade.
The replacement is not silent: the previous contents are copied to `explorer.md.bak` next to the file, and `/agents` reports what was replaced and where the backup went.
The backup is a single stable path holding the most recently displaced version, so it does not accumulate a file per load, and a `.bak` is never loaded as a definition.
If the backup cannot be written, the file is left untouched rather than clobbered.

To customize, copy one to a new name — `my-explorer.md` — and spawn that instead; seeding only ever touches its own two filenames.

The `model` field is resolved against `~/.pi/agent/model-alias.json` when present, and otherwise treated as `provider/modelId`.
An alias that does not resolve to a usable model falls back to the main agent's model and is reported as a job limitation rather than failing the spawn.
`model: inherit` is not such a case: it states explicitly what omitting the field does, so it keeps the main agent's model and reports nothing.

### `/agents`

`/agents` lists the definitions in `~/.pi/agent/agents/` with their descriptions and any parse diagnostics.
It never lists the fallback directories, so it reflects exactly what the session advertises.
It also reports whether `~/.pi/agent/subagent_instruction.md` replaced any tool instructions, along with any diagnostics from parsing it.

## 📝 Customizing the tool instructions

The main session decides when and how to delegate from the `subagent_*` tool descriptions and their prompt guidelines.
That wording is written for the general case, and some models follow parts of it loosely.

Create `~/.pi/agent/subagent_instruction.md` to replace it with your own.
The file is optional; without it every tool keeps its built-in text.

A `##` heading names one tool and opens its section.
Prose becomes that tool's description, and a `### Guidelines` block's list items become its prompt guidelines, which Pi renders as bullets in the system prompt.
Anything before the first heading is a preamble for you, and never reaches the model.

```markdown
Notes to myself about how this session should delegate.

## subagent_spawn

Start one subagent job and return its jobId. Collect the result with subagent_wait.

### Guidelines

- Never start more than two jobs at once.
- State each job's owning files in its task.
```

You can override `subagent_spawn`, `subagent_wait`, `subagent_cancel`, `subagent_inspect`, and `skill_run`.
A heading naming anything else is reported through `/agents` rather than silently ignored.

Each field is replaced only where your file defines it.
A section with prose but no `### Guidelines` block keeps the shipped guidelines, and an empty `### Guidelines` block drops them — which is how you remove a built-in bullet instead of arguing with it.

Replacement is whole-field, so a description that leaves out the parameter contract leaves it out of what the model reads.
Keep the parts that say how the tool is called, such as collecting a `jobId` with `subagent_wait`, and rewrite the parts that say when to use it.

The file is read once at session start, so an edit applies to the next session.
It is bounded to 64 KiB and 32 guidelines per tool, and a file that cannot be read or parsed leaves every tool on its built-in text, so a broken override never disarms the tools.

This file changes only what the **main session** reads.
A subagent's own system prompt comes from its agent definition in `~/.pi/agent/agents/`, which you can already edit directly.

### A stricter preset for models that over-delegate

The shipped guidelines already tell the model to do the work itself by default.
Some models still reach for a subagent on anything that sounds like more than one step, which costs you latency and a verification pass for nothing.

If that is happening, tighten the rule rather than arguing with the model turn by turn.
Write this to `~/.pi/agent/subagent_instruction.md`:

```markdown
My delegation policy. Everything above the first heading is for me, not the model.

## subagent_spawn

Start one subagent job and return its jobId immediately. Collect the result with
subagent_wait. A job cannot ask you anything, so the task must contain every
decision the child needs.

### Guidelines

- Do the work yourself. Do not start a subagent unless one of these is true, and say which one: (1) the user asked for it, (2) three or more genuinely independent tasks can run at the same time, (3) a search or survey would read more than ten files you do not otherwise need.
- One step, one file, or one question is never a reason to delegate. Neither is a task that merely sounds long.
- Never delegate planning, the critical path, integration, running tests, authorization decisions, or the final answer to the user.
- A subagent's report is a claim, not proof. Verify file changes against the diff and behaviour against a real check before you rely on it.
```

The first bullet is the one that does the work: it makes the model **name** its justification, which is much harder to do spuriously than to skip a soft "prefer not to".

Drop the whole `### Guidelines` block instead if you want no delegation guidance at all, and keep the prose so the calling contract survives.

## 🧩 Running skills in a subagent

A skill invoked the usual way is expanded into the main session, so its instructions, its intermediate file reads, and every step of its work accumulate there.
`skill_run` runs the skill in a child instead, and only the final result comes back.

```text
skill_run(name: "xm-cr-universal", args: "Review the current branch against main.")
```

The skill's `SKILL.md` body becomes the child's system prompt, and `args` carries the caller's request.
Keeping them apart preserves the instruction/request boundary the skill was written against.
Because the body travels through `--append-system-prompt` rather than the 50 KiB `task`, a skill far larger than that bound runs unchanged.

Children run with `--no-skills`, so a child cannot load the skill itself.
Its system prompt therefore names the skill's directory and requires relative paths to resolve against it, which keeps `references/` and `scripts/` reachable for multi-file skills.
A child needs a read tool to follow those references; the default tool set provides one.

### Skills written for Claude Code

Such skills are read as-is.
`allowed-tools` is translated into Pi's child work tools, accepting list and comma-separated forms and the scoped `Bash(git:*)` spelling, with `Glob` mapping to `find`.

Names with no Pi equivalent — `Task(...)`, `Skill(...)`, `AskUserQuestion`, and MCP tools — cannot grant a child any capability.
They are dropped and reported as job limitations rather than failing the run, because a skill written for another harness routinely names them while the rest of it still runs.
A skill left with no usable tool falls back to the read-only default so it can still read its own references.

A skill that delegates its real work through `Task(...)` is the one case to check before relying on it: the child cannot spawn nested subagents, so only the parts the skill performs directly will run.

`model: inherit` keeps the main agent's model, exactly as omitting the field does, and is not reported as a limitation. Any other `model` resolves like an agent definition's.

### Discovery

Skills are scanned in `.pi/skills/` in the project, then `~/.pi/agent/skills/`, `~/.claude/skills/`, and `~/.agents/skills/`.
The first directory to define a name wins, names are matched case-insensitively, and symlinked skill directories are followed.

Only the project and Pi directories are advertised in the `name` parameter, as names and descriptions rather than bodies, which keeps the roster at roughly two lines of context per skill.
A skill that exists only in `~/.claude/skills/` or `~/.agents/skills/` still resolves when named directly.
`disable-model-invocation: true` hides a skill from the roster while leaving it runnable by explicit name.

### `/skills`

`/skills` lists what `skill_run` advertises, with descriptions and any parse diagnostics.
Like `/agents`, it never lists the fallback directories.

## 👁️ Inspecting and terminating jobs

Run `/subagents` in TUI mode to open the inspection panel.

The panel lists every retained job, active and terminal, with its agent, description, state, and elapsed time.
Selecting a job shows its `jobId`, selected work tools, timeout, and its activity as the child produces it:

```
── Subagents · 2 active · 3 retained ───────────────────────────────
❯ ▶ explorer      review auth middleware    running    42s
  ○ builder       add cooldown tests        queued      0s
  ✓ skill:xmind   parse the test cases      completed  3m1s
── explorer · job_m2x1_3 · tools: read,grep · 120s timeout ─────────
  12:04:31 read  ✓ src/auth/middleware.ts → 80 lines
  12:04:33 grep  ✓ "verifyToken" src/ → 7 matches
  12:04:35 say     The middleware verifies exp before refresh.
───────────────────────────────────────────────────────────────────
  ↑↓ select   k terminate   esc close
```

`↑↓` selects a job, `k` starts termination, and `esc` closes the panel.

Terminating asks for confirmation first, then cancels the job through the same path as `subagent_cancel`:
its child process and timer are released, and other jobs keep running.
File changes the child already made are kept and are never rolled back, and its activity record stays readable in the panel.
A job terminated this way reports `Subagent execution was cancelled by the user.`, which is how the main agent can tell a deliberate stop from its own cancellation.

### What the panel shows, and what it does not

The activity record holds tool calls with a summary of their arguments, their outcome and result summary, the child's visible assistant text, and lifecycle notices.

It never holds the child's thinking: reasoning content is not forwarded out of the child process at all, so no display path can reach it.

Arguments are summarized rather than reproduced.
A `write` or `edit` reports its path and a byte count instead of the content, so a child writing a `.env` or a key file does not put that content on screen.
Credential-shaped text is redacted to `***` in everything the panel displays, covering named assignments such as `API_KEY=…` and well-known shapes such as `sk-…`, `ghp_…`, `AKIA…`, JWTs, bearer headers, long hex digests, and private-key blocks.
Redaction is a display safeguard rather than a security boundary; it cannot recognize every secret, which is why argument summarization does the heavier lifting.

Each job retains its most recent 200 events, and each event's display text is bounded to 512 bytes.
Older events are dropped and the panel says how many.
A job's record is released when the job itself is pruned, under the same 24-hour and 32-job terminal retention limits as the rest of its metadata.

The panel is a human surface. Nothing it displays enters the main agent's context, and `subagent_inspect` remains privacy-filtered as before.

## 🧵 Running jobs in parallel

`subagent_spawn` returns its `jobId` without waiting for its child, and each job owns its own Pi child process.
Calling it several times, whether in one parallel tool batch or one after another, therefore runs those children concurrently rather than in sequence.
All jobs share a maximum of eight active children; a ninth spawn is rejected until one finishes.

Start jobs in one batch only when they are mutually independent: every task must be completable without any other task in the batch, and none may consume another's result, file output, or conclusion.
When one task needs another's result, spawn the first, collect its result with `subagent_wait` or its background completion, and only then spawn the second with that result written into its task text.
Children cannot see each other, exchange results, or observe each other's progress, so splitting a sequential task into a parallel batch does not make it parallel — it makes the later jobs work from missing information.

Give each parallel writer disjoint file or responsibility ownership, or isolate their workspaces outside this extension.
Concurrent writes to the same file are not serialized or merged.

The tool contract states this rule to the model, and `/subagents` shows the resulting jobs running side by side so the overlap is visible.

## 🔄 Lifecycle and retention

Each child runs in Pi RPC mode, and the parent reads its event stream on stdout.
That stream is the only channel between them, and it runs one way: the parent learns what the child is doing and what it finally said, and has nothing to send back after the initial task.

A new job starts as `queued`, transitions to `running`, and reaches exactly one terminal state.
The runtime retains up to 32 recent terminal records for up to 24 hours within the current extension session.
Inspection reports older records removed by retention bounds through `omitted.jobs`.
Cancelling or terminalizing a job stops its child before stale output can replace the terminal state.
Session replacement and shutdown cancel active work and suppress stale completion delivery.

Because a job cannot be steered once started, the way to redirect one is to stop it and start another:
watch it in `/subagents`, terminate it if it is going the wrong way, and spawn a fresh job whose task carries what you learned.
Its file changes are kept rather than rolled back, and its activity record stays readable after termination.

## 🔀 Migrating from 3.x

Version 4.0 removes messaging in both directions. A job is now one-way: start it, watch it, read its result.

| Removed in 4.0 | What to do instead |
| --- | --- |
| Main `subagent_send` | Nothing to send. Decide from the child's result, then spawn a new job with the answer in its task. |
| Child `subagent_send` / `subagent_wait` | A child has no tool to reach you. It ends and states what it needs. |
| `subagent_wait` returning `reason: "subagent_message"` | `subagent_wait` now returns only on a terminal state, timeout, or cancellation. |

Nothing else changes. `subagent_spawn`, `skill_run`, `subagent_inspect`, `subagent_cancel`, and `subagent_wait` keep their contracts, and `/subagents` keeps the live activity view and termination it had before — those never used the removed channel.

Start a fresh Pi session after upgrading so stored calls do not request `subagent_send`.
If you wrote a skill or agent definition that told a child to ask the main agent, reword it to report the question instead; the built-in `builder` definition was reworded the same way.

## 🔀 Migrating from 2.x

Version 3.0 replaces the previous orchestration runtime.
It does not migrate legacy settings, persisted jobs, retained conversations, or recovery state.
Finish or record any required work before upgrading, then start a fresh Pi session so stored calls do not request removed tool names.
Use these replacements where the new job model supports the previous intent:

| Previous interface | Version 3 interface |
| --- | --- |
| `subagent` or `subagent_spawn` | `subagent_spawn` |
| `subagent_await` | `subagent_wait` |
| `subagent_inspect` | `subagent_inspect` |
| `subagent_manage` cancellation | `subagent_cancel` |
| Child-to-main questions | Removed in 4.0; a child reports the question in its result |
| Running main-to-child questions | Removed in 4.0; terminate and spawn a new job |

The `/subagents` command, extension settings, legacy retained follow-ups, `subagent_mailbox`, `subagent_consult`, advanced orchestration, alternate transports, trust-aware cwd policy, and extension-owned worktrees have no direct replacement.
Version 3.1 reintroduces custom agent catalogs as [agent definitions](#-agent-definitions), which is the replacement for a reusable child specialization.
Describe one-off specializations in `task` and grant only the required work tools through `tools`.

## 🔒 Security and privacy

The selected work tools run in the current working directory.
The default list contains no shell or file-mutation tool.
It is not a filesystem sandbox because its read tools can inspect files available to the user account.
Selecting `bash`, `powershell`, `edit`, or `write` permits workspace mutation with the Pi process environment and user permissions.

Every child disables session persistence, unrelated extensions, skills, and prompt templates.
Provider selection therefore supports Pi's child-visible built-in and configured providers, not providers registered only by a parent extension.
Credentials must be available independently to the child through Pi's stored credentials or its inherited environment.

### A child holds no subagent tool at all

Only the main session can create jobs, and a child cannot reach the parent. Both follow from the same fact, enforced structurally rather than by instruction.

Children are launched with `--no-extensions`, and no extension is injected in its place, so the extension defining `subagent_spawn`, `skill_run`, `subagent_cancel`, `subagent_inspect`, and `subagent_wait` is never loaded in a child process.

The `tools` list is an allowlist of the eight core work tools — `read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, and `ls`.
No `subagent_*` name is among them, so none can be requested for a child, and an agent definition that names one has it dropped with a diagnostic rather than honoured.
Nothing is added on the child's behalf: an empty `tools` list really does produce a child with no tools.

A child therefore cannot spawn a grandchild, cancel or inspect a sibling, or send anything anywhere. Its final message is its only output.

As defence in depth, each child also inherits `PI_SUBAGENT_DEPTH` incremented by one, and both `subagent_spawn` and `skill_run` refuse to run when it is above zero.
This layer is the weaker of the two: a child holding `bash` could unset the variable, but it would still face a process with no subagent tool and no loaded runtime to call, so the guarantee rests on the tool set rather than on the environment.

There is no listening socket, no per-job token, and no credential pipe. Removing the message broker in 4.0 removed that surface entirely.

Terminal and bidirectional controls are stripped before untrusted child text is displayed.
The `/subagents` panel additionally summarizes tool arguments instead of reproducing them and redacts credential-shaped text, which bounds what an inspected job can put on screen without being a guarantee that no secret is ever displayed.
Tasks, repository context, requests, responses, and inspected file content may be sent to the selected model provider.
Parallel writers require disjoint ownership or workspace isolation outside this extension.

## 🚧 Limitations

- The extension does not load arbitrary extension tools or parent-registered model providers in child processes.
- Process-local runtime API keys are not forwarded to children.
- Agent definitions provide a per-job model, tool set, thinking level, and system prompt; there is no per-job model override outside a definition.
- The extension provides no messaging in either direction, and no peer-to-peer child messaging, retained conversations, user-directed follow-up work, mailboxes, Agent Teams, chains, fan-in aggregators, workflow DAGs, dynamic scheduling, verification orchestration, nested subagents, or extension-owned semantic memory.
- The `/subagents` panel inspects and terminates jobs for a human. It is not an aggregator: nothing it shows enters the main agent's context, and fan-in synthesis stays with the main agent.
- The panel requires TUI mode; in RPC, JSON, and print modes `/subagents` reports that and does nothing.
- `subagent_instruction.md` replaces the instruction text the main session reads; it cannot make a model obey, and a description that drops the parameter contract drops it from what the model sees.
- Instruction overrides are read once at session start, so an edit applies to the next session.
- A running job cannot be steered, questioned, or answered. To redirect one, terminate it and spawn another; a task that needs a mid-flight decision should be split so the decision lands between jobs.
- A child cannot report a blocking question until it ends, so a child that hits one spends the rest of its turn budget stopping cleanly rather than waiting.
- The main agent must verify child claims against the actual diff and deterministic checks.
- A blocking job's completion does not wake an idle turn, because its caller is waiting; a `background: true` job's completion does.
- Jobs and retained results do not survive extension reload, session replacement, or process exit.

## 🗂️ Package layout

```text
packages/pi-subagents/
├── src/                               # Authoritative implementation and helpers
│   ├── index.ts                       # Thin Pi entrypoint
│   └── subagents.ts                   # Job and child lifecycle
├── dist/                              # Generated Jiti runtime (single entry)
├── scripts/build-runtime.mjs          # Runtime builder
├── docs/                              # Published reference documentation
├── skills/using-pi-subagents/         # Repository-only example; not published
└── test/                              # Behavior and lifecycle coverage
```

The generated runtime is built from `src/index.ts` and does not import back into `src`.

## 🔎 Keywords

Pi, subagents, delegation, subagent jobs, least privilege, one-way jobs, cancellation, job lifecycle.

## 📄 License

[MIT](./LICENSE)
