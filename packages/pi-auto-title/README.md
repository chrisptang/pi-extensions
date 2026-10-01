# 🏷️ pi-auto-title — Automatically Name Pi Sessions

[![npm](https://img.shields.io/npm/v/@chrisptang/pi-auto-title)](https://www.npmjs.com/package/@chrisptang/pi-auto-title) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Automatically generate concise, descriptive session titles after the second interaction turn, using the fast and lightweight `haiku` model from `model-alias.json`.

Pi defaults to un-named sessions that fall back to raw message previews. `pi-auto-title` waits until Turn 2 settles—when the session's actual intent and scope have converged—and then names the session cleanly in the background without interrupting your workflow.

## ✨ Features

- **Turn 2 Trigger**: Waits until the second user turn settles before naming, avoiding noisy or premature titles from exploratory first prompts.
- **Model Alias Integration**: Defaults to resolving the `haiku` alias from `~/.pi/agent/model-alias.json`, with robust multi-tier fallback (catalog search, fast models, or current model).
- **Silent & Non-intrusive**: Executes asynchronously during idle boundaries (`agent_settled`), updating the UI title bar and session list with zero toast interruptions.
- **Manual Intent Respected**: Never overwrites user-specified names set via `--name`, `/name`, or RPC.
- **Compact & Prompt-Cache Safe**: Bounded context extraction (< 500 tokens) with all tool outputs omitted; does not inject synthetic messages into the conversation history.
- **On-demand Regeneration**: Force generate or manually set titles anytime via `/auto-title`.

## 📦 Install

```bash
pi install npm:@chrisptang/pi-auto-title
```

Try it without installing permanently:

```bash
pi -e npm:@chrisptang/pi-auto-title
```

Try the package from this repository checkout:

```bash
pi -e ./packages/pi-auto-title
```

Restart Pi or run `/reload` after installation. Pi extensions run with your user permissions, so install only trusted packages.

## 🚀 Quick start

1. Ensure you have a `haiku` model alias configured in `~/.pi/agent/model-alias.json` (or any valid Anthropic/OpenRouter credentials):

```json
{
  "aliases": {
    "haiku": "anthropic/claude-3-5-haiku-20241022"
  }
}
```

2. Start a new session in Pi and chat normally:
   - **Turn 1**: You ask an initial question or task.
   - **Turn 2**: You clarify or provide specific requirements.
   - When the agent finishes responding to Turn 2, your session title is automatically generated and updated in the TUI header and `/resume` picker!

## ⚙️ Settings

Configure preferences in `~/.pi/agent/pi-auto-title.json` or project-local `<workspace>/.pi/pi-auto-title.json`:

```json
{
  "enabled": true,
  "model": "haiku",
  "triggerTurn": 2,
  "maxTitleLength": 40,
  "fallbackToCurrentModel": true
}
```

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `true` | Enable or disable automatic session naming. |
| `model` | `string` | `"haiku"` | Model alias or `provider/model-id` used for title generation. |
| `triggerTurn` | `number` | `2` | User interaction round on which to trigger titling (1-indexed). |
| `maxTitleLength` | `number` | `40` | Maximum character length for generated titles. |
| `fallbackToCurrentModel` | `boolean` | `true` | Fallback to active session model if alias resolution fails. |

## 💬 Commands

| Command | Description |
| --- | --- |
| `/auto-title` | Display auto-title status, current session name, and turn count. |
| `/auto-title generate` | Force generate a session title immediately from current conversation context. |
| `/auto-title set <name>` | Manually set the session title. |

## 🗂️ Package layout

```text
packages/pi-auto-title/
├── src/
│   ├── index.ts        # Thin Pi entrypoint forwarder
│   ├── auto-title.ts   # Core lifecycle listeners and command registration
│   ├── alias.ts        # Model alias resolution and fallback ladder
│   ├── context.ts      # Bounded turn extraction and context compaction
│   ├── generator.ts    # Prompt engineering, LLM completion, and title sanitization
│   └── settings.ts     # Settings loading and persistence
└── test/               # Lifecycle, alias, context, and sanitizer tests
```

## 🔎 Keywords

Pi extension, Pi coding agent, session title, auto name, model alias, haiku, session management, productivity.

## 📄 License

MIT. See [`LICENSE`](./LICENSE).
