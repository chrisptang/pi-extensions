---
"@chrisptang/pi-subagents": major
---

Remove messaging in both directions. A subagent job is now one-way: start it, watch it, read its result.

A child that hits a decision it cannot make now ends and reports what it needs, instead of blocking on a question. The caller decides and, where useful, starts a fresh job with the answer written into its task. That is one round trip, and it replaces a request-response protocol that existed to save it.

Removed: the main-agent `subagent_send` tool, the child `subagent_send` and `subagent_wait` tools, the loopback TCP message broker with its per-job tokens and private credential bootstrap pipe, and the RPC steering path that injected a main-agent request into a running child. `subagent_wait` no longer returns early with `reason: "subagent_message"`; its only outcomes are a terminal state, a timeout, and cancellation. About 1,500 lines of source and tests go with them, along with the listening socket and token lifecycle as a security surface.

A child now receives exactly the work tools the caller selects. Nothing is added on its behalf, and no extension is injected into a child process at all, so no `subagent_*` tool reaches a child: it cannot spawn a grandchild, cancel or inspect a sibling, or send anything anywhere. This strengthens the nesting guarantee rather than relying on the `PI_SUBAGENT_DEPTH` guard, which remains as defence in depth.

Inspection is unaffected and was never part of the removed channel. `/subagents` keeps the live activity view, selection, and confirmed termination, and the above-editor widget keeps its latest-activity line: both read the child's RPC stdout event stream, which is one-way by nature. To redirect a job that is going the wrong way, terminate it and spawn another; its file changes are kept and its activity record stays readable.

The built-in `builder` agent told children to ask the main agent through `subagent_send`; it now tells them to stop and return the decision, with the options and a recommendation. Reword any agent definition or skill of your own the same way, and start a fresh Pi session after upgrading so stored calls do not request removed tool names.
