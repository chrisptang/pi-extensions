---
"@chrisptang/pi-model-alias": minor
---

Add pi-model-alias, which switches the session model through short aliases defined in `model-alias.json`.

`/ma <alias>` resolves an alias to a `provider/model-id` reference, splitting on the first slash so ids containing slashes still work. An alias may hold several candidates; unregistered candidates and those without configured credentials are dropped, and one of the rest is picked at random. A thinking level may be attached as a `thinkingLevel` field or a trailing `:level` suffix, supported in every entry form. `/ma` with no argument lists the configured aliases and `/model-alias-reload` re-reads the file.

The optional `skills` map runs a skill on its own model: `/skill:<name>` is intercepted before expansion, the configured model is applied, and the previous model and thinking level are restored at `agent_settled`. A skill target may be a model reference, a candidate pool, or the name of an alias. Because Pi skills are inline prompt expansion, this changes which model runs the skill, not where it runs; the skill still shares the main session's context.
