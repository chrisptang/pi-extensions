---
"@narumitw/pi-goal": minor
---

Require user clarification and a native `goal_confirm` approval before `/goal <objective>` persists or activates a new goal. Preserve the requested token budget, reject stale confirmations, and cancel draft approval on superseding commands or session teardown.

Objective-bearing commands now require idle Pi and TUI or RPC confirmation; print/JSON starts are rejected. Previous active goals are paused during replacement clarification. Menu starts, edits, resumes, and managed-run RPC retain their existing behavior.
