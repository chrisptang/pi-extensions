# 🎯 pi-gpt-discipline — Target GPT Models with Strict Behavioral Discipline

[![npm](https://img.shields.io/npm/v/@chrisptang/pi-gpt-discipline)](https://www.npmjs.com/package/@chrisptang/pi-gpt-discipline) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Targets GPT-series models with strict behavioral discipline while keeping `AGENTS.md` clean and preventing prompt pollution on other models (Claude Opus, Sonnet, DeepSeek, etc.).

Based on clinical auditing of 525 local Pi sessions (17,600+ turns), GPT models frequently exhibit:
- **Defensive Disclaimers / Hedge Padding** (22.1% rate, e.g. "不代表...不等于...尚未...")
- **Action Announcements** (16.6% rate, e.g. "我会先...再...重点核对...")
- **Over-engineering & Hallucinated Scenarios** (unprompted caching, requestId, retry loops)
- **Hardcoding Dynamic Parameters** (fixing example test emails into reusable tools)
- **Robotic, Bureaucratic UI Copy** (cramming disclaimer paragraphs into button microcopy)

This extension hooks into Pi's native `before_agent_start` lifecycle event and dynamically mounts a structured system prompt section (`<gpt_discipline>`) **only** when a GPT-family model is active.

## ✨ Features

- **Zero AGENTS.md Pollution**: Global `AGENTS.md` remains 100% clean and pristine.
- **Dynamic Model-Aware Injection**: Automatically injects rules for models matching `gpt-*` or `omen-*`.
- **Automatic Section Cleanup**: Switching to a non-GPT model removes the active discipline section before the next run.
- **Full-Prompt Compatibility**: Keeps the rules effective when an earlier hook has replaced the complete system prompt.

## 📦 Install

Add to your `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "../../Documents/github/pi-extensions/packages/pi-gpt-discipline"
  ]
}
```

Or install from npm once published:

```bash
pi install npm:@chrisptang/pi-gpt-discipline
```

Try it directly without installing:

```bash
pi -e ./packages/pi-gpt-discipline
```

## 🚀 Quick start

Select a GPT-family model and send a prompt; the built-in rules apply automatically. To use your own policy, create a Markdown file as described below and run `/reload`. There are no extension commands.

## ⚙️ Settings

The first non-empty, readable `gpt-discipline.md` wins; files replace one another rather than being combined. User policy deliberately takes precedence over project policy.

| Priority | File | Condition |
|---|---|---|
| 1 | `~/.pi/agent/system-prompts/gpt-discipline.md` | Always considered; respects Pi's agent-directory override |
| 2 | `<workspace>/.pi/system-prompts/gpt-discipline.md` | Project is trusted |
| 3 | `<extension>/system-prompts/gpt-discipline.md` | Bundled eight-rule default |

Write plain UTF-8 Markdown without a `<gpt_discipline>` wrapper. Missing files, directories, and whitespace-only files fall through to the next source; other read errors produce a warning and also fall through. Files outside `system-prompts/` are ignored. The extension never creates or rewrites your files, and has no JSON settings.

The policy is read on session start, including `/reload`, resume, and session replacement. Edits do not change an ongoing session until one of those boundaries, keeping ordinary request prefixes stable.

## 🔄 Prompt compatibility

The extension updates the structured `gpt_discipline` section. When an earlier `before_agent_start` hook has set `forceSystemPrompt` (directly or by returning `systemPrompt`), it also appends the same XML-wrapped rules to that forced text. Repeated injection keeps one copy, and switching to a non-GPT model removes only this extension's block. Other prompt content is preserved.

Ordinary runs with the same model family keep the effective prompt stable. Loading the extension, reloading a changed policy, or switching between GPT and non-GPT models intentionally changes the active prompt; this can start a new cache prefix. Historical conversation entries are not rewritten.

Later hooks that extend `event.systemPrompt` retain the rules. A later hook that replaces the prompt without retaining its current content can still override them.

## 📋 The 8 Behavioral Discipline Rules

The default [eight behavioral rules](./system-prompts/gpt-discipline.md) are maintained in the bundled Markdown file and injected under `<gpt_discipline>`.

## 🗂️ Package layout

- `src/index.ts`: Pi entrypoint.
- `src/gpt-discipline.ts`: Model detection, session policy loading, and prompt injection.
- `src/prompt-file.ts`: User, trusted-project, and built-in prompt resolution.
- `system-prompts/gpt-discipline.md`: The built-in eight rules.
- `test/*.test.ts`: Prompt resolution, injection, model-switching, and stability tests.

## 🔎 Keywords

Pi extension, GPT, behavioral discipline, system prompt.

## 📄 License

[MIT](./LICENSE).
