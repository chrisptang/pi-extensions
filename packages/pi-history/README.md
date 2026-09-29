# ⌨️ pi-history — Prompt History That Survives the Session

[![npm](https://img.shields.io/npm/v/@chrisptang/pi-history)](https://www.npmjs.com/package/@chrisptang/pi-history) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Pi already lets you press Up to browse the prompts you typed, but that history lives in memory and disappears when the session ends. This extension writes each typed prompt to a user-local SQLite database and restores it into the editor at startup, so Up reaches yesterday's prompts the way a shell history does.

## ✨ Features

- Records every prompt you type into a user-local SQLite database, keeping the most recent 1000 per project name.
- Restores stored prompts into the editor at session start, so Up and Down browse across sessions and restarts.
- Groups history by project directory name; different paths with the same directory name share prompts.
- Skips blank prompts and consecutive duplicates, matching familiar shell-history behavior.
- Leaves Up, Down, and every other key exactly as Pi defines them, including any custom keybindings.
- Uses SQLite transactions so concurrent Pi sessions do not overwrite each other's prompts.

## 📦 Install

```bash
pi install npm:@chrisptang/pi-history
```

Try without installing permanently:

```bash
pi -e npm:@chrisptang/pi-history
```

Try this package locally from the repository root:

```bash
npm --workspace @chrisptang/pi-history run build
pi -e ./packages/pi-history
```

The package declares `dist/index.ts`, so an unbuilt local checkout must be built before Pi loads the package directory.
Pi extensions run with the Pi process's user permissions, so install only trusted packages.

## 🚀 Quick start

There is nothing to configure. Type a few prompts, exit Pi, then start it again in the same project and press Up: the prompts from your previous session are there.

Run `/history` to see how many prompts are stored and where.

## 💬 Commands

`/history` reports the number of stored prompts for the current project name, the database path, and how many are reachable with Up. It takes no arguments and rejects any that are given. In print and JSON modes it produces no output, because those modes have no channel for it.

## 🗃️ Storage

Prompts are stored in `<getAgentDir()>/pi-history.db` (normally `~/.pi/agent/pi-history.db`). The database is created on the first recorded prompt or migration, not on an empty read. Its file is restricted to the current user on POSIX. SQLite write transactions serialize concurrent appends, consecutive-duplicate checks, and trimming to the most recent 1000 prompts per project directory name. Projects named `app` share history even when they live at different paths.

On first access from a workspace with `<workspace>/.pi/pi-history.json`, its entries are imported into the database in order, after any existing entries for that name. The legacy file is removed only after the import commits. If migration fails or the old JSON is malformed, it is kept and that workspace stops recording until the problem is fixed; an already imported file that reappears with different contents is kept and reported instead of silently duplicating or deleting data. Only workspaces opened after upgrading are migrated. Back up the old file before upgrading if it contains important prompts. A previously tracked legacy file must be removed from Git separately.

Only prompts you type are recorded. Messages injected by other extensions and prompts arriving over RPC are skipped, since they are not things you would page back to.

If the database cannot be read, the extension reports the error and stops recording for that session rather than overwriting stored history.

## 🔒 Security and privacy

Everything your prompts contain is stored as plain text in the user-local SQLite database. Nothing is sent anywhere. Treat it like shell history: pasted secrets land on disk. No new project-local history file is created. Delete the database to clear all stored history; existing legacy JSON files are removed only after migration succeeds.

## 🚧 Limitations

- Pi's editor caps its in-memory history at 100 entries, so although 1000 prompts are kept on disk, only the most recent 100 are reachable with Up. `/history` reports both numbers.
- Restoring history installs a custom editor component through Pi's `setEditorComponent` API. Another extension that installs its own editor in the same session replaces this one, and whichever runs last wins; recording to disk continues either way.
- History is restored at session start. Prompts typed in a different session that is still running do not appear until the next session begins.
- A prompt is recorded when submitted, whether or not the agent answers successfully.

## 🗂️ Package layout

```text
packages/pi-history/
├── src/                               # Authoritative implementation and helpers
│   ├── index.ts                       # Thin Pi entrypoint
│   ├── history.ts                     # Lifecycle wiring, capture, and the command
│   ├── store.ts                       # SQLite storage, retention, and legacy migration
│   └── editor.ts                      # Editor subclass that seeds stored prompts
├── dist/                              # Generated Jiti runtime
├── scripts/build-runtime.mjs          # Runtime builder
└── test/                              # Store, editor, and extension-wiring coverage
```

The generated runtime is built from `src/index.ts` and does not import back into `src`. The editor module stays behind a lazy chunk so a non-interactive session never loads it.

## 🔎 Keywords

Pi extension, Pi coding agent, AI coding agent, prompt history, editor history, persistent history, shell-like history, TypeScript Pi package, npm Pi extension.

## 📄 License

MIT.
See [`LICENSE`](./LICENSE).
