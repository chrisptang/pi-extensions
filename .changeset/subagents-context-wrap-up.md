---
"@chrisptang/pi-subagents": minor
---

Bound a child by its context window, and make the built-in explorer cheaper to run.

A child reading large files filled its context window long before its turn budget ran out; Pi's own compaction then summarized away the evidence it had gathered, and the child re-read what it had lost instead of converging. When the model's context window is known, the child is now told about the bound in its system prompt, and once a response reports the context 70% full it is asked to stop using tools and report. The report carries a limitation naming the context bound, and a child that keeps working three turns past the request is stopped as `budget_exhausted`, the same way the turn budget already works.

Agent definitions accept `effort` as the Claude Code spelling of `thinkingLevel`, so a definition written for either harness resolves the same; `thinkingLevel` wins when both are set. The built-in `explorer` now declares `effort: low`, because it runs a small model over many tool calls and inherited the main session's level before.

The built-in `architect` sends explorer differently: one explorer answers one question, design comparisons are never delegated, and every explorer task states its completion condition so the child stops once the cited evidence answers the question.
