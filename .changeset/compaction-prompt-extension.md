---
"@narumitw/pi-compaction-prompt": minor
---

Add `@narumitw/pi-compaction-prompt`, which injects a Markdown compaction prompt into Pi's context summarization. The prompt is read from `<workspace>/.pi/compaction.md` when the project is trusted and otherwise from `~/.pi/agent/compaction.md`, so a repository can override the user-wide policy.

The prompt is additive: it reaches Pi's summarization where `/compact` instructions go, keeping Pi's section format and its deterministic `<read-files>`/`<modified-files>` path lists. A `/compact <instructions>` argument is appended after the file prompt so a one-off focus narrows the standing policy.

Compaction falls back to Pi's default summary whenever no prompt is configured, the model or credentials are unavailable, summarization fails, or the generated summary is empty. Split-turn prefixes are summarized together with the earlier history because the extension API cannot reach Pi's separate turn-prefix prompt.
