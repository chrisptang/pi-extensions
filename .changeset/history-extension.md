---
"@narumitw/pi-history": minor
---

Add `@narumitw/pi-history`, which makes Pi's Up-arrow prompt history survive the session.

Pi already browses typed prompts with Up and Down, but that history is in-memory only and seeded solely from the current session, so it is empty again on the next start. This extension records each interactively typed prompt to `<workspace>/.pi/pi-history.json` and replays the stored prompts into the editor at session start, so Up reaches prompts from previous sessions the way a shell history does.

History is per project, so prompts from unrelated workspaces never mix. The file holds the most recent 1000 prompts, oldest first, dropping the oldest past that. Blank prompts and consecutive duplicates are skipped. Only interactive input is recorded: prompts arriving over RPC or injected by another extension are not things a user would page back to.

Writes go through a temporary file in the destination directory followed by a rename, and each append re-reads the file first, so a second Pi session running in the same project keeps its prompts rather than being overwritten. A history file that cannot be parsed is reported once and left untouched instead of being replaced.

Restoring uses Pi's `setEditorComponent` with a `CustomEditor` subclass that only seeds stored prompts at construction, so Up/Down browsing, the restored draft, and every keybinding Pi wires onto a custom editor are inherited unchanged. Because Pi's editor caps its own history at 100 entries, 1000 prompts are stored on disk but the most recent 100 are reachable with Up; the new `/history` command reports both numbers along with the file path. The editor module stays behind a lazy chunk so a non-interactive session never loads it.
