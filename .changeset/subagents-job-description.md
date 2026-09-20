---
"@chrisptang/pi-subagents": minor
---

Label active jobs in the widget with the agent name and a caller-supplied description instead of only the generated job ID.

A running job previously announced itself as `job_mtwlhech_1`, which says nothing about what it is doing. `subagent_spawn` and `skill_run` now take a required `description`: a short label stating the work in a few words. A description past 60 characters is truncated for display rather than rejected, so an over-long label never costs the main agent an extra turn. The widget renders `agent · description`, falling back to the job ID when a job was spawned without an agent, so several concurrent jobs stay distinguishable at a glance.

The description is also carried on `subagent_inspect` summaries and the completion payload, where it identifies the job alongside its agent name.
