# 🎚️ pi-model-alias — Switch Models by Short Name, Per Session or Per Skill

[![npm](https://img.shields.io/npm/v/@chrisptang/pi-model-alias)](https://www.npmjs.com/package/@chrisptang/pi-model-alias) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Give your models short names, switch with `/ma sonnet` instead of a full `provider/model-id`, and let a skill run on a model of its own.

## ✨ Features

- Maps short aliases onto `provider/model-id` references and switches the session model with `/ma <alias>`.
- Starts a session on an alias with `pi --model <alias>`, which Pi alone would fuzzy-match to an unrelated model.
- Lets one alias hold several candidates, picks one at random, and then keeps using it for the rest of the session.
- Sidelines a candidate the provider rate-limits and rotates the alias onto another, honoring `retry-after`.
- Runs a skill on its own model: `/skill:<name>` switches before expansion and restores the previous model once the agent settles.
- Attaches an optional thinking level to an alias, either as a field or as a `:high` suffix.
- Keeps the current model and thinking level across `/new`, where Pi alone would fall back to the settings default.
- Reloads definitions from disk with `/model-alias-reload`, no restart required.
- Warns and keeps going on a malformed config rather than failing the session.

## 📦 Install

```bash
pi install npm:@chrisptang/pi-model-alias
```

Try without installing permanently:

```bash
pi -e npm:@chrisptang/pi-model-alias
```

Try this package locally from the repository root:

```bash
npm --workspace @chrisptang/pi-model-alias run build
pi -e ./packages/pi-model-alias
```

The package declares `dist/index.ts`, so an unbuilt local checkout must be built before Pi loads the package directory.
Pi extensions run with the Pi process's user permissions, so install only trusted packages.

## 🚀 Quick start

Create `model-alias.json` in your Pi agent directory (`~/.pi/agent/model-alias.json`):

```json
{
  "aliases": {
    "sonnet": "anthropic/claude-sonnet-4-5",
    "fast": "anthropic/claude-haiku-4-5",
    "deep": { "models": ["anthropic/claude-opus-4-1"], "thinkingLevel": "high" }
  }
}
```

Then switch models by name:

```text
/ma fast
```

Run `/ma` with no argument to list what is configured, and `/model-alias-reload` after editing the file.

An alias also works as the startup model:

```bash
pi --model fast
```

## 🎬 Starting on an alias

`pi --model <alias>` starts the session on that alias, applying the same candidate pick and thinking level as `/ma <alias>`.

Pi resolves `--model` against its own catalog before any session exists, and that path takes no extension hook, so an alias name first fuzzy-matches whatever catalog model happens to look similar. The extension re-resolves the flag once the session starts and switches to the alias target, which is why startup may briefly report the model Pi matched before the alias takes over.

A value that is not a configured alias is left to Pi untouched, so ordinary `--model` patterns and `provider/model-id` references keep working. An explicit `--provider` also defers to Pi, since that pairing addresses the catalog directly. When an alias has no candidate with usable credentials, the model Pi chose is kept and the reason is reported. Only the initial startup uses the flag; `/resume` and fork restore the model from the session transcript, and `/new` carries over the model of the session it replaces (see below).

## 🔁 Keeping the model across `/new`

A fresh session has no transcript to restore a model from, so Pi starts it on the `defaultProvider`/`defaultModel` from settings, discarding whatever `/model` or `/ma` had selected. The extension captures the outgoing model and thinking level when `/new` is issued and re-applies them once the new session is up. Held alias picks and cooldowns are still session-scoped and start clean.

## ⚙️ Settings

Definitions live in `model-alias.json` in the Pi agent directory.
The file has two optional maps, `aliases` and `skills`.

An entry accepts three forms:

```json
{
  "aliases": {
    "single": "anthropic/claude-sonnet-4-5",
    "pool": ["anthropic/claude-sonnet-4-5", "openai/gpt-5.1"],
    "detailed": {
      "models": ["anthropic/claude-opus-4-1"],
      "thinkingLevel": "high"
    }
  }
}
```

- A **string** is one model reference.
- An **array** is a candidate pool; one entry is chosen at random on the first switch and held from then on.
- An **object** takes `models` (or the single-value `model`) plus an optional `thinkingLevel`.

Model references are `provider/model-id`, split on the **first** slash only, so ids that themselves contain slashes work: `openrouter/anthropic/claude-sonnet` means provider `openrouter`, id `anthropic/claude-sonnet`.

A trailing `:level` suffix sets the thinking level inline, so `anthropic/claude-opus-4-1:high` is equivalent to the `detailed` form above.
Valid levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.
An unrecognized suffix is treated as part of the model id, and an unrecognized `thinkingLevel` field is ignored.

The suffix works in every form, including inside a candidate list.
A level applies to the alias as a whole rather than to one candidate, so when several candidates carry a suffix the last one wins and applies to whichever candidate is picked.
An explicit `thinkingLevel` field takes precedence over a suffix.

Candidates that are not registered in Pi, or that have no configured credentials, are dropped before the random pick.
If nothing is left, the current model is kept and the reason is reported.

### Held picks and rate-limit rotation

An alias draws from its pool once per session and then **holds** that model, so repeated `/ma pool` switches stay on the same candidate instead of redrawing.
Holding keeps the provider's prompt cache warm and makes cost predictable; `/ma` reports `(held)` once an alias has settled.

A held pick is released when the provider rate-limits it.
On a `429` or `503`, the candidate is put on **cooldown** and the alias rotates onto another candidate, which takes effect from the next turn.

The cooldown length comes from the response headers, following the same precedence as Pi's own provider retry:

| Header | Meaning |
| --- | --- |
| `retry-after-ms` | Delay in milliseconds; takes precedence. |
| `retry-after` | Delay in seconds, or an HTTP-date to wait until. |
| *(none)* | Falls back to 60 seconds. |

A server-requested delay is capped at 15 minutes, so a long quota reset cannot sideline a candidate for the whole session.
Repeated limits extend a cooldown rather than shortening it.
If every candidate is cooling down, the alias still picks one rather than refusing to switch, since the limit may have lifted early.

Held picks and cooldowns are **per session**. Both are released by a new session and by `/model-alias-reload`.

### Per-skill models

The `skills` map gives a skill its own model, keyed by skill name:

```json
{
  "aliases": { "fast": "anthropic/claude-haiku-4-5" },
  "skills": {
    "commit-message": "fast",
    "code-review": "anthropic/claude-opus-4-1:high"
  }
}
```

A skill target may be a model reference, a candidate pool, or the name of an alias defined above.
An alias name is accepted only as a lone target — mixing an alias name into a candidate list is rejected, because the intended semantics are ambiguous.

## 💬 Commands

| Command | Description |
| --- | --- |
| `/ma` | Lists the configured aliases. |
| `/ma <alias>` | Switches the session model to that alias, applying its thinking level if set. Completions show the target, or the candidate count for a pool. |
| `/model-alias-reload` | Re-reads `model-alias.json` and reports how many aliases loaded. |

## 🚧 Limitations

- A per-skill model changes **which model** runs the skill, not **where** it runs. Pi skills are inline prompt expansion, so the skill still shares the main session's conversation and context; this is not isolated execution. Use `pi-subagents` when you need a separate context.
- Switching models invalidates the provider's prompt cache, so a per-skill override or a rate-limit rotation trades cache hits for model choice. Holding a pick means a pool pays this only on the first switch.
- Rotation lands on the **next turn**, not the failing request. `after_provider_response` observes the status but cannot alter the request in flight, so Pi's own retry handles the current one; the alias switch applies from the following turn.
- A rate limit is attributed to the model the alias last switched to. If the user or another extension changes the model afterwards, the limit is ignored rather than blamed on the alias.
- A single-candidate alias has nowhere to rotate to; the limit is reported and the model stays put.
- The previous model is restored at `agent_settled`, the idle boundary. A skill that leaves the agent busy holds the override until the run truly settles.
- Restoring only re-applies a thinking level that was active beforehand; if none was set, the level a skill applied stays in effect.
- A new or replaced session discards a pending restore.
- `pi --model <alias>` corrects the model after Pi has already selected one, so the startup header can show Pi's own match for a moment, and an alias name that collides with a real model still resolves to the alias.

## 🗂️ Package layout

```text
packages/pi-model-alias/
├── src/                               # Authoritative implementation and helpers
│   ├── index.ts                       # Thin Pi entrypoint
│   ├── model-alias.ts                 # Commands, skill interception, and restore
│   ├── aliases.ts                     # Config loading, parsing, and resolution
│   ├── cli-model.ts                   # Reads the startup `--model` value from argv
│   └── cooldown.ts                    # Rate-limit cooldowns and retry-after parsing
├── dist/                              # Generated Jiti runtime
├── scripts/build-runtime.mjs          # Runtime builder
└── test/                              # Resolution and extension-wiring coverage
```

The generated runtime is built from `src/index.ts` and does not import back into `src`.

## 🔎 Keywords

Pi extension, Pi coding agent, AI coding agent, model alias, model switching, per-skill model, thinking level, TypeScript Pi package, npm Pi extension.

## 📄 License

MIT.
See [`LICENSE`](./LICENSE).
