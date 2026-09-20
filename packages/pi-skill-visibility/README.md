# 👁️ pi-skill-visibility — Reduce Automatic Skill Exposure

[![npm](https://img.shields.io/npm/v/@chrisptang/pi-skill-visibility)](https://www.npmjs.com/package/@chrisptang/pi-skill-visibility) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Hide selected skills from Pi's automatic prompt catalog and TUI completion, while keeping skills available when explicitly requested. The extension can also inspect local Pi and Claude Code session logs for skill-use evidence.

This is exposure control, **not access control**. It never modifies Pi, installed files, or `SKILL.md` files, and it does not block explicit `/skill:<name>` invocations or reads of a skill path.

## ✨ Features

- Removes exact configured skill names from the automatic `<available_skills>` prompt catalog.
- Hides those names from TUI `/skill:` completion without changing Pi's underlying skill registry.
- Preserves manual skill invocation, direct `SKILL.md` reads, RPC command listings, and unrelated prompt changes.
- Provides `/skills-analysis [days]` to analyze local Pi and Claude Code JSONL histories without uploading data or calling a model.
- Reports invocation, skill-load, and ordinary-text mention evidence, data quality warnings, and conservative exclusion candidates.

## 📦 Install

```bash
pi install npm:@chrisptang/pi-skill-visibility
```

Try it without installing permanently:

```bash
pi -e npm:@chrisptang/pi-skill-visibility
```

Try the package from this repository checkout:

```bash
pi -e ./packages/pi-skill-visibility
```

Restart Pi or run `/reload` after installation or a settings change. Pi extensions run with your user permissions, so install only trusted packages.

## 🚀 Quick start

Create `pi-skill-visibility.json` in Pi's agent directory (normally `~/.pi/agent/`):

```json
[
  "example-unused-skill",
  "another-optional-skill"
]
```

Names match exactly and are case-sensitive. Duplicate names are harmless. A missing file means that no skills are hidden. Invalid JSON, non-array values, blank names, and names with surrounding whitespace disable all exclusions for that session and show a warning without overwriting the file.

Older releases used `excluded-skills.json`. When the canonical file is absent, this extension validates the old file, atomically copies its original JSON bytes to `pi-skill-visibility.json`, and removes the old file only when it did not change during migration. If both files exist, the canonical file wins and the legacy file is retained with a warning.

## 💬 Commands

| Command | Description |
| --- | --- |
| `/skills-analysis` | Scan the most recent 60 days of local Pi and Claude Code sessions. |
| `/skills-analysis 7` | Scan a positive whole-day window, up to 100000000 days. |

The command reads Pi sessions from Pi's configured session directory and Claude Code sessions below its configured project-history directory. It recursively reads only JSONL files, does not follow symlinks, and reports unreadable paths, malformed records, or missing sources. It is cancellable during session shutdown and allows only one scan per session.

A report counts three kinds of evidence once per skill and message: an explicit invocation, a read/load request for `SKILL.md`, and an ordinary-text mention. It excludes injected catalogs, tool results, expanded skill bodies, thinking, and the report itself. An unobserved skill is never proof that it is unnecessary; incomplete data produces no automatic exclusion suggestions.

## ⚙️ Settings

The extension reads its settings at session start, including after `/reload`:

```text
<agent directory>/pi-skill-visibility.json
```

The agent directory is resolved through Pi's `getAgentDir()` API, so isolated Pi environments use their own settings automatically. The extension has no extension-specific environment variables and does not honor project-level overrides because hidden-skill preferences are user-local.

## 🗂️ Package layout

```text
packages/pi-skill-visibility/
├── src/
│   ├── index.ts          # Thin Pi entrypoint
│   ├── visibility.ts     # Lifecycle, prompt/catalog filtering, command
│   ├── settings.ts       # Validation and legacy filename migration
│   ├── analysis.ts       # Streaming local-history evidence analysis
│   └── report.ts         # Markdown report formatter
└── test/                 # Filtering, settings, historical-path, analysis tests
```

## 🔎 Keywords

Pi extension, Pi coding agent, skills, skill visibility, skill catalog, autocomplete, local session analysis, Claude Code, TypeScript.

## 📄 License

MIT. See [`LICENSE`](./LICENSE).
