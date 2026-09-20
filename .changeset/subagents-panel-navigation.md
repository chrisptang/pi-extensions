---
"@chrisptang/pi-subagents": minor
---

Redesign the `/subagents` panel as a framed list rendered in the editor's slot instead of a centered overlay, so it never covers the conversation, with an Enter-to-open, scrollable activity view, and match its keys through Pi's keybindings so they work under the Kitty keyboard protocol. Compact the above-editor widget to one line per job. Fix the list hiding the selected job when it overflows, align the activity log's tool column, share one duration format between the panel and the widget, and strip whole terminal colour sequences from child output instead of only their escape byte.
