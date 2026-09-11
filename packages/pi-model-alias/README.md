# 🎚️ pi-model-alias — Switch Models by Short Name, Per Session or Per Skill

[![npm](https://img.shields.io/npm/v/@narumitw/pi-model-alias)](https://www.npmjs.com/package/@narumitw/pi-model-alias) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Give your models short names, switch with `/ma sonnet` instead of a full `provider/model-id`, and let a skill run on a model of its own.

## ✨ Features

- Maps short aliases onto `provider/model-id` references and switches the session model with `/ma <alias>`.
- Lets one alias hold several candidates and picks one at random, skipping any without configured credentials.
- Runs a skill on its own model: `/skill:<name>` switches before expansion and restores the previous model once the agent settles.
- Attaches an optional thinking level to an alias, either as a field or as a `:high` suffix.
- Reloads definitions from disk with `/model-alias-reload`, no restart required.
- Warns and keeps going on a malformed config rather than failing the session.

## 📦 Install

```bash
pi install npm:@narumitw/pi-model-alias
```

Try without installing permanently:

```bash
pi -e npm:@narumitw/pi-model-alias
```

Try this package locally from the repository root:

```bash
npm --workspace @narumitw/pi-model-alias run build
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
- An **array** is a candidate pool; one entry is chosen at random per switch.
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
- Switching models invalidates the provider's prompt cache, so a random pool or a per-skill override trades cache hits for model choice. A pool whose candidates differ in price also makes the cost of a switch non-deterministic.
- The previous model is restored at `agent_settled`, the idle boundary. A skill that leaves the agent busy holds the override until the run truly settles.
- Restoring only re-applies a thinking level that was active beforehand; if none was set, the level a skill applied stays in effect.
- A new or replaced session discards a pending restore.

## 🗂️ Package layout

```text
packages/pi-model-alias/
├── src/                               # Authoritative implementation and helpers
│   ├── index.ts                       # Thin Pi entrypoint
│   ├── model-alias.ts                 # Commands, skill interception, and restore
│   └── aliases.ts                     # Config loading, parsing, and resolution
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
