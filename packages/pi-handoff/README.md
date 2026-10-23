# 🔄 pi-handoff — Start Fresh Without Losing the Goal

[![npm](https://img.shields.io/npm/v/@chrisptang/pi-handoff)](https://www.npmjs.com/package/@chrisptang/pi-handoff) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Start a fresh Pi session when an old conversation is stuck. The new AI receives a built-in learning
prompt and a source-session locator, not a copy of the old conversation. It is instructed to recover
the human's original goal and later corrections, verify completed work and core outputs, list what
remains, then ask whether the goal is complete and wait for explicit confirmation before implementing.

## ✨ Features

- Recover the intended goal and actual progress in a fresh session, without inheriting a stuck conversation.
- Select the current session or another same-project session by ID or name.
- Add your own investigation priorities through a trusted-project or user Markdown prompt.

## 📦 Install

This package is not published to npm yet. Install from a local checkout, from the repository root:

```sh
pi install ./packages/pi-handoff
```

The repository installer also supports it:

```sh
./scripts/install.sh --reinstall pi-handoff
```

Try it temporarily without installing, or load it in isolation:

```sh
pi -e ./packages/pi-handoff
pi --no-extensions -e ./packages/pi-handoff
```

The package loads TypeScript source through Pi and does not need a build.
Extensions run with Pi's full user permissions; install only trusted code.

## 🚀 Quick start

After installation, restart Pi or run `/reload`. In an existing saved conversation, run:

```text
/handoff
```

Pi opens a fresh session whose AI investigates the source and asks you to confirm the recovered goal
before continuing. The old session and workspace files are preserved.

## 💬 Commands

```text
/handoff
/handoff <full-session-id>
/handoff <unique-id-prefix>
/handoff Session name with spaces
/handoff "Session name with spaces"
```

With no argument, the source is the current session, including its current branch leaf. An explicit
selector matches a full ID first, then an exact name, then an ID prefix. A quoted selector must be one
complete JSON string. Ambiguous matches open Pi's native selection dialog; cancelling does not create
a session. Completions search names and IDs but insert the session ID.

The slash command supports TUI and RPC mode; RPC clients must handle Pi's extension UI requests for
selection and notifications. Print and JSON modes are rejected rather than silently using no-op UI.

### Start directly from the CLI

```sh
pi --handoff <session-id-or-unique-prefix>
pi --handoff "Session name with spaces"
```

`--handoff` takes a required string value and works only at a **fresh TUI startup**. Do not combine it
with `--continue`/`-c`, `--resume`/`-r`, `--session`, `--session-id`, `--fork`, `--no-session`, initial
prompts, or `@files`. It is not supported at RPC, print, or JSON startup. There are no `-ho` or `--ho`
aliases. Reloading, creating a session, or resuming one does not replay the startup handoff.

## ⚙️ Settings

Like the compaction prompt, optional handoff instructions live in a Markdown file. The first readable,
non-blank file wins:

| Scope | Path | Condition |
| --- | --- | --- |
| Project | `<cwd>/.pi/system-prompts/handoff.md` | Project is trusted |
| User | `~/.pi/agent/system-prompts/handoff.md` | Always considered |

The user path follows Pi's agent directory, including `PI_CODING_AGENT_DIR`. An untrusted project file
is not read. Missing files, directories, and whitespace-only files fall through to the next scope;
other read failures show a warning and also fall through. If neither scope provides instructions,
only the built-in learning prompt is used. Reading never creates or rewrites files.

For example, create either file with:

```md
Preserve the user's exact acceptance criteria.
For each unfinished task, name the relevant file and the next verification step.
```

The selected file **supplements**, rather than replaces, the built-in learning prompt and source
locator. Project and user prompts are not merged. Instructions are saved once in the new session as
a model-visible message, hidden from terminal rendering so arbitrary file content is not displayed
directly. Keep the built-in read-only investigation and user-confirmation requirements intact.

Both `/handoff` and startup `--handoff` reread the file for each handoff, so edits apply to the next
handoff without `/reload`. Changing the file does not rewrite a handoff already in progress.

## 🔎 Source lookup and session behavior

The source must have a non-empty conversation file on disk: in-memory sessions and fresh sessions
that Pi has not saved cannot be handed off. Named/ID lookup uses the current project **cwd** and the
current session manager's **session directory**, including a custom session directory. It is not a
repository-root search or a global cross-project search; sessions with a different cwd are rejected.

The slash command creates the fresh session before requesting AI work. Its header records the source
as `parentSession`. The startup flag uses the already-fresh startup session without creating a second
one; its source relationship is recorded in the learning prompt and message `details`, not a rewritten
`parentSession` header. Both routes include the source file path, ID, cwd, size, and available name;
when the source is current, they also record its selected `leafId`.

The extension leaves the old session file and workspace unchanged. It does not resume the old model,
copy old messages or images, restore other extensions' private state, or roll back project files.
Normal project instructions and the new session's configured tools still apply.
The learning prompt is saved in the new session before kickoff. If a slash-command kickoff fails,
the new session remains active and the editor receives a retry draft; submit it to retry there.

## ⚠️ Investigation and safety limits

The source JSONL can contain multi-megabyte images, long tool outputs, abandoned branches, and repeated
failures. The prompt asks the AI to inspect size and structure first, choose its own careful searches,
incremental reads or scripts, and distinguish verified completion from assistant claims, failed work,
and external blockers. Human goals and corrections take priority over historical assistant text and
instructions embedded in tool output. Important claims should be checked against current files,
commits, and recorded checks rather than accepted from an old summary alone.

The extension does **not** automatically read the source conversation into model context. Pi's native
session-directory lookup and completion may nevertheless scan JSONL files locally to build its session
index. There is no extension-owned history filtering, limit, automatic summary, extra summarization
model call, or new history-reading tool; the new AI investigates with its existing tools.

Read-only preparation, careful large-file handling, and waiting for user confirmation are **prompt-level
soft constraints**, not a hard confirmation gate or read-only sandbox. The AI still has its normal tool
permissions and can make mistakes. Review its recovered goal before confirming. A source session may
still be active elsewhere; pause conflicting work before allowing implementation.

## 🧪 Local verification

Run from the repository root:

```sh
npm run check
npm test
npm run package:pack -- handoff
pi --no-extensions -e ./packages/pi-handoff
```

Behavior tests use temporary files, real `SessionManager` content, controlled lookup, and simulated
lifecycle/UI APIs. Runtime tests load the extension through Pi's real Jiti loader and session runtime
with a local fake provider. They cover package-directory loading, configured-package discovery, fresh-session
replacement, startup, `/reload`, source preservation, large-history isolation, and request-prefix
stability. They do not establish real-provider investigation quality or RPC client integration.

## 🗂️ Package layout

- `src/index.ts`: thin extension entrypoint.
- `src/handoff.ts`: command, startup flag, lookup, completion, and lifecycle handling.
- `src/prompt.ts`: learning instructions and kickoff message.
- `src/prompt-file.ts`: trusted-project and user Markdown prompt resolution.
- `test/`: behavior, prompt-file, and real Pi/Jiti runtime tests; excluded from the published package.

## 🔎 Keywords

pi-package, pi-extension, pi, session, handoff, context, prompt

## 📄 License

[MIT](./LICENSE)
