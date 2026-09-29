# pi-history SQLite storage

## Requirements
- Store prompt history in `<getAgentDir()>/pi-history.db` instead of creating project-local `pi-history.json`.
- Distinguish projects by directory **name** only: same-named directories intentionally share history.
- Migrate each existing `<workspace>/.pi/pi-history.json` on first access; do not discard malformed legacy data.
- Preserve interactive-only capture, ordering, consecutive-duplicate suppression, 1000-entry retention, `/history`, and editor replay.

## Design
- `packages/pi-history/src/store.ts` owns a `node:sqlite` database with `(project, id, prompt)` entries and a migrated legacy-path table. Use `getAgentDir()` and `CONFIG_DIR_NAME`. Reads without data must not create the database.
- First access validates the workspace's legacy JSON. Import it under a SQLite write transaction, marking the legacy path in the same transaction; commit before deleting the legacy file. A failed import leaves it intact and blocks append for that workspace. For an already migrated path, retry cleanup without importing twice. Existing SQLite rows follow legacy rows in chronological order. Different legacy paths of same-named projects are each imported once.
- Append and retention happen in one `BEGIN IMMEDIATE` transaction so separate Pi processes do not overwrite one another. DB failure is surfaced to the UI by existing warning behavior. Store prompts as user-private data (0600 DB on POSIX).
- `packages/pi-history/src/history.ts` reports DB location and avoids continuing after failed load; `README.md` documents migration, same-name sharing, privacy, and backup behavior. No new dependency, flag, project `.gitignore`, or changes to other packages.
- Rejected: continuing JSON and editing `.gitignore` (user explicitly requests migration); path-keyed project identity (user chose names).

## Tasks
- [x] T1. Implement SQLite storage and legacy migration — files: `packages/pi-history/src/store.ts`, `packages/pi-history/test/store.test.ts` — verify: `npx vitest run packages/pi-history/test/store.test.ts`.
- [x] T2. Align lifecycle, command, tests and docs — files: `packages/pi-history/src/history.ts`, `packages/pi-history/test/history.test.ts`, `packages/pi-history/README.md`, `.changeset/pi-history-sqlite.md` — verify: `npx vitest run packages/pi-history/test/history.test.ts`.
- [ ] T3. Audit and integration — `npm run check`, focused tests, package build and isolated Pi RPC load passed; full `npm test` ran with 4504 passing and two unrelated failures (`pi-starship` skill collision and `pi-worktree` timing assertion).
