---
"@narumitw/pi-subagents": minor
---

Tell the model to do the work itself by default, and say when a subagent is actually worth its cost.

The guidance that mattered most — prefer direct work, keep planning and the final answer in the main session — lived only in the repository-only example skill, which is not published or registered. A default install therefore shipped ~1,500 tokens explaining how to delegate and nothing explaining when not to. That is the wrong balance for any model, and the worst case for models that reach for a subagent on anything sounding like more than one step.

`subagent_spawn` now carries two guidelines ahead of the parallelism rules, so they render as the first bullets of the system prompt's Guidelines list: do the work yourself unless several independent tasks can run at once, a wide survey would flood this context, or the user asked; and never delegate planning, the critical path, integration, deterministic checks, authorization decisions, or the final answer. The restraint rule is deliberately first, so a model that absorbs one bullet absorbs the one that prevents an unnecessary job. Cost: about 160 tokens.

Fixed a stale contract: the spawn description still claimed a job "may ask the main agent questions", which 4.0 removed. It now states that a job cannot ask anything, so the task must carry every decision the child needs.

The `thinkingLevel` parameter now tells the model to omit it, since a child already inherits the session's effective level; setting it is for deliberately spending less thinking on a mechanical job or more on a hard one.

The README gains a "What this is for" section stating the three cases up front, and a stricter `subagent_instruction.md` preset for a model that over-delegates, whose first rule makes the model name which case justifies the job.
