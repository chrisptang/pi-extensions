---
"@chrisptang/pi-subagents": patch
---

Back up a built-in agent definition before seeding overwrites it, and report the replacement instead of letting it pass silently.

`explorer.md` and `builder.md` are owned by the extension, so every load still rewrites a file whose contents differ from the shipped definition. What changes is that the displaced contents are first copied to `<name>.md.bak` beside the file, and the replacement is surfaced as a diagnostic in `/agents` naming both the file and its backup. A user who had edited one of the two filenames can now recover their version.

The backup is a single stable path per agent holding the most recently displaced version, so repeated upgrades do not accumulate a file per load. A `.bak` is never picked up as an agent definition. If the backup cannot be written, the existing file is left untouched rather than clobbered.
