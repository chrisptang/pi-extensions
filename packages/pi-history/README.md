# ⌨️ pi-history — Prompt History That Survives the Session

[![npm](https://img.shields.io/npm/v/@chrisptang/pi-history)](https://www.npmjs.com/package/@chrisptang/pi-history) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Pi already lets you press Up to browse the prompts you typed, but that history lives in memory and disappears when the session ends. This extension writes each typed prompt to a per-project file and restores it into the editor at startup, so Up reaches yesterday's prompts the way a shell history does.

## ✨ Features

- Records every prompt you type into a project-local history file, keeping the most recent 1000 and dropping the oldest past that.
- Restores stored prompts into the editor at session start, so Up and Down browse across sessions and restarts.
- Keeps one history per project, so prompts from unrelated workspaces never mix.
- Skips blank prompts and consecutive duplicates, matching familiar shell-history behavior.
- Leaves Up, Down, and every other key exactly as Pi defines them, including any custom keybindings.
- Re-reads the file on each append, so two Pi sessions in one project do not overwrite each other's prompts.

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

`/history` reports the number of stored prompts, the file holding them, and how many are reachable with Up. It takes no arguments and rejects any that are given. In print and JSON modes it produces no output, because those modes have no channel for it.

## 🗃️ Storage

Prompts are stored as JSON at `<workspace>/.pi/pi-history.json`, oldest first:

```json
{
	"entries": ["first prompt", "second prompt"]
}
```

The file is written through a temporary file in the same directory followed by a rename, so an interrupted write cannot truncate your history. Each append re-reads the file first, so a second Pi session running in the same project keeps its prompts too. Ordering between simultaneous writers is not coordinated beyond that: this is per-process sequencing, not a cross-process lock.

Only prompts you type are recorded. Messages injected by other extensions and prompts arriving over RPC are skipped, since they are not things you would page back to.

If the file cannot be parsed, the extension reports it once and stops recording for that session rather than replacing it, so a hand-edit mistake never costs you the stored prompts. Fix or delete the file to resume; deleting it simply starts an empty history.

## 🔒 Security and privacy

Everything your prompts contain is written in plain text to a file inside the project. Nothing is sent anywhere. Treat the file the way you would a shell history: if you paste a secret into a prompt, it lands on disk. Add `.pi/pi-history.json` to `.gitignore` if the project's `.pi` directory is tracked, and delete the file to clear what was stored.

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
│   ├── store.ts                       # File loading, trimming, and atomic writes
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
