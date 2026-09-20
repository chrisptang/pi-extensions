---
"@chrisptang/pi-goal": minor
---

Record every confirmed goal as Markdown under `.pi/pi-goals/{date}-{slug}.md` in the working directory so a later session can pick the objective up. The snapshot is written only after `goal_confirm` approval; later state changes refresh frontmatter and leave the body intact for hand-written notes.

Add `/goal --list` (aliases `-l`, `list`) to list archived goals. The archive stays a record rather than an activation source: picking one up still goes through `/goal <objective>`, and a failed write warns without blocking activation.
