# 🚀 pi-starship — Build Pi's Footer with Starship-style TOML

[![npm](https://img.shields.io/npm/v/@chrisptang/pi-starship)](https://www.npmjs.com/package/@chrisptang/pi-starship) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Build a customizable Pi footer with Starship-style TOML, native Pi modules, conditional formats, palettes, and responsive multiline layout.
The extension parses and renders the footer itself, so it does not need the `starship` executable or a shell prompt.

> **Different package:** The unscoped npm package `pi-starship` delegates to the Starship binary.
> This package is `@chrisptang/pi-starship` and renders Pi-specific modules natively.

## ✨ Features

- Starts with a quiet, iconless two-line footer and offers Starship presets plus a Pi-native Minimal preset.
- Supports root and module formats, conditional groups, `$all`, styles, palettes, and width-aware `$fill` alignment.
- Provides Pi, model, usage, Git, pull request, package, language, environment, deployment, cloud, and execution modules.
- Adaptively middle-shortens long workspace, session title, branch, and model labels in the built-in layout; usage stays intact and may wrap on narrow terminals.
- Keeps rendering pure while refreshing filesystem, process, and network-derived data through bounded caches.
- Uses `/starship` for presets, preview, configuration health, searchable module details, customization, and recovery.
- Bundles the authoritative configuration skill and references for editing `pi-starship.toml` or answering setup questions.
- Loads a generated split runtime to reduce Pi package startup work.

## 📦 Install

```bash
pi install npm:@chrisptang/pi-starship
```

Try the published package without installing it permanently:

```bash
pi -e npm:@chrisptang/pi-starship
```

Build the generated runtime and try the local package from this repository:

```bash
npm --workspace @chrisptang/pi-starship run build
pi -e ./packages/pi-starship
```

The package declares `dist/index.ts`, so build an unbuilt local checkout before Pi loads the package directory.
Install only from sources you trust because Pi extensions and skills run with Pi's permissions.
Do not enable this with `@narumitw/pi-statusline`: both own Pi's footer, and Pi does not arbitrate that conflict.

## 🚀 Quick start

Start Pi with the extension to use the built-in two-line footer without creating a settings file.
The first row shows directory, branch, nonempty textual Git status, and live activity on the left, with model and thinking level aligned right through fill.
The second shows `ΣIn` inclusive session input, `ΣOut` cumulative output, current-model `TTFT` in seconds and output `tok/s`, `Ctx` tokens/window and percentage, and reported cost including tool usage, with the session title aligned right when named.
The title shortens to the space left by usage and hides when no space remains.
Normal text uses terminal colors and Pi's muted theme role, without bold, rainbow segments, brand, or cache rate; context warnings, Git conflicts, and UI waits use Pi's warning/error theme roles.
Idle and completed activity stays hidden.
Run `/starship` to inspect the footer, choose a preset, or customize the configuration.

The bundled configuration skill is manual-only and is not available for automatic model invocation.
Run `/skill:configuring-pi-starship` before asking Pi to explain or edit `pi-starship.toml`:

```text
/skill:configuring-pi-starship explain the aws module
/skill:configuring-pi-starship enable the directory and git_branch modules
```

The skill loads the relevant reference and validates file edits.
It does not cover general TOML, shell Starship configuration, extension source development, or unrelated footer work.

## 💬 Commands

| Command | Purpose |
| --- | --- |
| `/starship` | Customize the footer, preview presets, inspect modules, or restore built-in configuration; RPC shows help. |
| `/starship settings` | Edit, preview, and confirm TOML; RPC shows the file path. |
| `/starship status` | Show the configuration source, path, and diagnostics. |
| `/starship help` | Show command and configuration help. |

All routes support TUI and RPC with the exceptions above and reject unknown or trailing arguments.
Print and JSON modes produce no command output; the footer runs only in TUI mode.
Preset selection, module inspection, and recovery are menu-only, not extra subcommands.
Restoring built-in configuration requires an existing settings document to replace; see [Settings](#-settings).

## ⚙️ Settings

The package bundles the `configuring-pi-starship` skill as the authoritative configuration guide for users and agents.
Invoke `/skill:configuring-pi-starship` before asking Pi how to configure the footer or edit `pi-starship.toml`.
The skill answers from its references and consults the bundled source only when the public documentation does not cover a question.

Read the references directly when preferred:

- [Configuration and format](./skills/configuring-pi-starship/references/configuration.md) — settings schema, validation and fallback behavior, presets, examples, format grammar, styles, palettes, and display thresholds.
- [Complete module catalog](./skills/configuring-pi-starship/references/module-catalog.md) — exact variables, default formats, symbols, enabled state, style fields, display defaults, option types, ranges, and enum values.
- [Module behavior](./skills/configuring-pi-starship/references/modules.md) — reachability, exact detection defaults, command gates, output semantics, aliases, truncation, and module-specific behavior.
- [Runtime and security](./skills/configuring-pi-starship/references/runtime-and-security.md) — network and command execution, local metadata, cloud and deployment context, fill layout, refresh behavior, and limitations.

The only configuration source remains `<getAgentDir()>/pi-starship.toml`.
Missing or malformed files use the quiet built-in fallback without writing a file.
Valid custom TOML—including empty files—and presets retain legacy root/module defaults, not the quiet template's overrides.
To migrate an existing document, choose **Restore built-in…**, review the replacement, and explicitly confirm; this replaces the entire document without a post-success backup.

A minimal custom document can select and style only the modules it needs; this example intentionally uses legacy module defaults, not the quiet built-in template:

```toml
format = "$model$directory$git_branch"

[model]
style = "bold blue"
```

`ΣIn` uses `$total_input` (`input + cacheRead + cacheWrite`); legacy `$input` and `$total` retain their existing meanings.
Missing usage shows `—`, not a measured zero.
`$speed` reports the latest current-model response, not a session average: TTFT measures provider-request start to first nonempty text, thinking, or tool-call content, and tok/s divides final output tokens by the whole request duration, including TTFT.
Unknown values show `—`; new requests, model/session changes, reload, and cancellation reset measurements rather than restoring historical timing.
Custom layouts and presets can opt in by adding `$speed` to their root format; see [usage semantics](./skills/configuring-pi-starship/references/modules.md#usage-semantics) for precision and timing details.
Cache metrics remain available through `$cache`, including the token-weighted `$session_rate` and latest assistant-request `$rate`, but are absent from the quiet default.
Reported cost retains three decimal places below $1 and two from $1; subscription-backed sessions append `estimate`, not a billing statement.
The cost includes usage that tools report in their results, such as subagent runs, and shows that share as `(tools $x)` when it is positive.

Use `/starship` for interactive configuration, preview, diagnostics, presets, and recovery.
Manual file edits load at the next `session_start`, including `/reload`.

## 🔒 Security and privacy

Some opt-in modules read local development, deployment, cloud, host, or user metadata, run bounded local commands, or query GitHub through `gh`.
Review [Runtime and security](./skills/configuring-pi-starship/references/runtime-and-security.md) before enabling them.

## 🚧 Limitations

pi-starship is Starship-inspired rather than fully compatible with shell Starship.
The complete supported and intentionally omitted behavior is documented in [Runtime and security](./skills/configuring-pi-starship/references/runtime-and-security.md).

## ➕ Adding a module

Create `src/modules/<name>.ts` with its format variables, defaults, and runtime value resolver, then register it in display order in `src/modules/catalog.ts`.
Configuration names, validation variables, defaults, and `$all` ordering are derived from that catalog.
Add the module to the built-in root format only when it should be visible by default, then document and test its user-facing values.
Keep `extension_status` last in the catalog so arbitrary third-party statuses follow native module output.

## 🗂️ Package layout

```text
packages/pi-starship/
├── src/                               # Modules, formats, presets, and runtime collectors
│   ├── index.ts                       # Thin Pi entrypoint
│   └── pi-starship.ts                 # Footer lifecycle and cached refresh
├── dist/                              # Generated Jiti runtime
├── scripts/build-runtime.mjs          # Runtime builder
├── skills/configuring-pi-starship/    # Authoritative configuration skill and references
└── test/                              # Behavior and lifecycle coverage
```

The generated runtime is built from `src/index.ts` and does not import back into `src`.

## 🔎 Keywords

Pi Coding Agent, Starship statusline, Starship TOML, terminal footer, native statusline, configuration editing, agent skill, GitHub pull request, prompt cache, cache hit rate, Pi extension

## 📄 License

MIT.
See [`LICENSE`](./LICENSE).
Starship attribution and its ISC license are included in [`NOTICES.md`](./NOTICES.md).
