# 🗜️ pi-compaction-prompt — Your Own Rules for Context Compaction

[![npm](https://img.shields.io/npm/v/@chrisptang/pi-compaction-prompt)](https://www.npmjs.com/package/@chrisptang/pi-compaction-prompt) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Write a Markdown file saying what a compaction summary must keep, and Pi applies it every time context is compacted.

Pi's built-in summary asks for goals, progress, decisions, and next steps, and asks for all of it concisely. That is a reasonable default, but it leaves out things you may depend on after a compaction: the user's original wording, the code you were midway through changing, or an error message quoted exactly. This extension lets you add those requirements once, in a file, instead of retyping them as `/compact` arguments.

## ✨ Features

- Adds your Markdown prompt to every compaction: automatic, threshold, overflow recovery, and manual `/compact`.
- Reads the prompt from `<workspace>/.pi/compaction.md` when the project is trusted, otherwise from `~/.pi/agent/compaction.md`.
- Keeps your prompt additive, so Pi's section format and its `<read-files>`/`<modified-files>` path lists still apply.
- Appends a `/compact <instructions>` argument after the file prompt, so a one-off focus narrows the standing policy instead of replacing it.
- Falls back to Pi's default compaction whenever the file is absent or summarization cannot run, so a configuration mistake never costs you a compaction.

## 📦 Install

```bash
pi install npm:@chrisptang/pi-compaction-prompt
```

Try without installing permanently:

```bash
pi -e npm:@chrisptang/pi-compaction-prompt
```

Try this package locally from the repository root:

```bash
pi -e ./packages/pi-compaction-prompt
```

Pi extensions run with the Pi process's user permissions, so install only trusted packages.

## 🚀 Quick start

Create `~/.pi/agent/compaction.md`:

```markdown
Also keep, in addition to the sections above:

## Original Request (verbatim)
Quote the user's own words for each outstanding request. Do not paraphrase.

## Code In Flight
For every file still being changed, show the current state of the changed
function or block, not only its path.

## Verbatim Errors
Copy failing commands, error messages, and stack traces exactly as they appeared.
```

Then compact as usual. `/compact` and automatic compaction both apply the file.

To override the prompt for one repository, put a `compaction.md` in that workspace's `.pi/` directory and trust the project.

## ⚙️ Settings

This extension has no JSON settings. The Markdown prompt file is the only configuration, and the first readable one wins:

| Scope | Path | Condition |
| --- | --- | --- |
| Project | `<workspace>/.pi/compaction.md` | Project is trusted |
| User | `~/.pi/agent/compaction.md` | Always considered |

The user path follows Pi's agent directory, so `PI_CODING_AGENT_DIR` moves it. A file that is missing, or that holds only whitespace, is treated as absent and the next scope applies; when neither scope yields text, Pi's default compaction runs untouched. Files are read at each compaction, so an edit takes effect on the next one without a restart.

## 🔍 Behavior

The extension handles Pi's `session_before_compact` event. When a prompt is configured it generates the summary through Pi's own summarization path, passing your prompt where Pi puts `/compact` instructions, then returns that summary as the compaction result.

Two consequences are worth knowing before you rely on it:

Your prompt is **additive**, not a replacement. Pi's own instructions — its six-section format and its closing "Keep each section concise" — still precede yours. Ask for what you want kept; an instruction that contradicts Pi's format competes with it rather than overriding it.

For a **split turn** (Pi cutting inside one turn because it was too large to keep whole), Pi normally makes a second, separately prompted call to summarize the turn prefix. The extension API cannot reach that second prompt, so this extension summarizes the prefix together with the earlier history in one call under your prompt. The prefix is still covered, but it is not labeled as a separate `Turn Context` section the way Pi's default output labels it.

On any failure — no active model, unresolved credentials, a provider error, or an empty summary — the extension notifies and returns nothing, which makes Pi run its default compaction instead. Cancelling a compaction stays silent.

## 🗂️ Package layout

| Path | Purpose |
| --- | --- |
| `src/index.ts` | Extension entrypoint forwarder |
| `src/compaction-prompt.ts` | `session_before_compact` handler and summarization |
| `src/prompt-file.ts` | Project and user prompt-file resolution |
| `src/instructions.ts` | Composition of the file prompt with `/compact` instructions |
| `src/file-lists.ts` | The `<read-files>`/`<modified-files>` tail |

## 🔎 Keywords

pi-package, pi-extension, pi, compaction, context, summarization, prompt

## 📄 License

[MIT](./LICENSE)
