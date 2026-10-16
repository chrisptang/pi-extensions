# Module Reference

Use this authoritative public reference whenever a question or change involves a module, format variable, display rule, alias, truncation rule, or module-specific option.

## 🧱 Modules

| Module | Format variables | Meaning |
| --- | --- | --- |
| `brand` | `$symbol` | Pi brand marker |
| `provider` | `$symbol`, `$provider` | Current model provider |
| `model` | `$symbol`, `$model` | Current model name |
| `thinking` | `$symbol`, `$level` | Thinking level |
| `directory` | `$symbol`, `$path`, `$full_path` | Current working directory |
| `session_name` | `$symbol`, `$name` | Current session display name |
| `git_worktree` | `$symbol`, `$name`, `$path` | Linked worktree name and top-level path |
| `git_branch` | `$symbol`, `$branch`, `$remote_name`, `$remote_branch` | Local branch and upstream |
| `github_pr` | `$symbol`, `$number`, `$link`, `$state`, `$checks`, `$review`, `$status` | Current-branch GitHub pull request |
| `git_commit` | `$symbol`, `$hash`, `$tag` | Seven-character HEAD hash and optional exact tag |
| `git_state` | `$symbol`, `$state`, `$progress_current`, `$progress_total` | Rebase, merge, revert, cherry-pick, bisect, or mail-apply state |
| `git_metrics` | `$symbol`, `$added`, `$deleted` | Added/deleted line totals from the working tree diff |
| `git_status` | `$symbol`, `$all_status`, `$summary`, `$ahead_behind`, `$ahead`, `$behind`, `$diverged`, `$up_to_date`, `$conflicted`, `$stashed`, `$deleted`, `$renamed`, `$modified`, `$typechanged`, `$staged`, `$untracked`, and detailed index/worktree counters | Cached porcelain-v2 counters |
| `activity` | `$symbol`, `$state`, `$tool`, `$count`, `$kind`, `$title`, `$text`, `$live` | Extension UI waits, active tools, streaming, completion, or idle; `$live` hides idle/completed states |
| `context` | `$symbol`, `$percentage`, `$tokens`, `$window` | Current context tokens, context window, and percentage |
| `tokens` | `$symbol`, `$input`, `$output`, `$total`, `$total_input` | Session token totals; `$total_input` includes prompt cache reads and writes |
| `cache` | `$symbol`, `$rate`, `$session_rate`, `$read`, `$write` | Prompt-cache totals, latest-request rate, and session token-weighted rate |
| `cost` | `$symbol`, `$cost`, `$tools`, `$subscription` | Reported usage-cost estimate, included tool-cost share, and subscription estimate marker |
| `time` | `$symbol`, `$time` | Current local time |
| `turn` | `$symbol`, `$count` | User turn count |
| `package` | `$symbol`, `$version`, `$source` | Direct project manifest version |
| `nodejs` | `$symbol`, `$version`, `$engines_version` | Detected Node.js project/runtime |
| `python` | `$symbol`, `$version`, `$virtualenv`, `$pyenv_prefix` | Python runtime and allowlisted environment name |
| `rust` | `$symbol`, `$version`, `$numver`, `$toolchain` | Safe native `rustc` runtime and allowlisted toolchain name |
| `golang` | `$symbol`, `$version`, `$mod_version` | Go runtime (`$mod_version` is reserved and currently empty) |
| `bun` / `deno` | `$symbol`, `$version` | Bun or Deno runtime |
| `mise` | `$symbol`, `$health` | Bounded mise health result |
| `direnv` | `$symbol`, `$rc_path`, `$allowed`, `$loaded` | Inert direnv status; `.envrc` is never sourced |
| `conda` | `$symbol`, `$environment` | Active Conda environment name |
| `pixi` | `$symbol`, `$version`, `$environment`, `$project_name` | Pixi project and environment |
| `nix_shell` | `$symbol`, `$state`, `$name`, `$level` | Allowlisted Nix shell activation metadata |
| `guix_shell` | `$symbol`, `$state` | Guix shell activation marker |
| `docker_context` | `$symbol`, `$context` | Non-default local Docker context |
| `kubernetes` | `$symbol`, `$context`, `$namespace`, `$cluster`, `$user` | Current inert kubeconfig metadata |
| `terraform` | `$symbol`, `$workspace`, `$version` | Local Terraform/OpenTofu workspace and optional version |
| `aws` | `$symbol`, `$profile`, `$region` | AWS profile/region metadata, never credentials |
| `gcloud` | `$symbol`, `$active`, `$account`, `$domain`, `$project`, `$region` | Active gcloud configuration metadata |
| `azure` | `$symbol`, `$subscription`, `$username` | Default Azure subscription; username is separately enabled |
| `openstack` | `$symbol`, `$cloud`, `$project` | Selected OpenStack cloud/project metadata |
| `os` | `$symbol`, `$type`, `$name`, `$version`, `$edition`, `$codename` | Platform/OS metadata; disabled by default |
| `container` | `$symbol`, `$name`, `$type` | Known container, WSL, or Dev Container context |
| `hostname` | `$symbol`, `$hostname`, `$ssh_symbol` | Hostname, SSH-only by default |
| `username` | `$symbol`, `$user` | Contextual login identity |
| `fill` | `$symbol` | Flexible width-aware root-layout marker |
| `extension_status` | `$symbol`, `$statuses`, `$count` | Pi extension statuses |

For exact default formats, symbols, enabled state, accepted style fields, display defaults, option types, numeric ranges, and enum values, use [the complete module catalog](module-catalog.md).
Those are legacy public module defaults; the quiet built-in document explicitly overrides selected module formats and styles without changing custom TOML or presets.
`activity` also exposes `$live_style` and `git_status` exposes `$summary_style` in style expressions, not as TOML fields.

## Reachability and collection rules

A module contributes work only when it is enabled and reachable from the root `format` directly or through `$all`.
Reachability activates that module's collector at module scope, even when its module format references only `$symbol`.
Omitting a data variable does not prevent the package, deployment, cloud, or execution collectors from reading that reachable module's allowlisted files and environment metadata.
Language project detection also runs at module scope, while its version command, Node engine-file read, and optional Python or Rust environment values are collected only when their corresponding variables are referenced.
The mise health, direnv status, Pixi version, and Terraform/OpenTofu version commands are likewise variable-gated, but their module-level detection and non-command metadata reads still occur when reachable.
A disabled module is absent even when the root format names it or `$all` is present.

Workspace detection uses at most one direct listing of the current working directory, stops at 2,048 entries, and never recurses.
A positive file, extension, or folder rule must match for direct detection to succeed.
Any matching `!` rule rejects the module before positive matches are considered.
Extensions may be configured with or without a leading dot, but defaults omit the dot.

For language modules, each non-empty `detect_files`, `detect_extensions`, or `detect_folders` array replaces only that category's built-in defaults.
An empty category keeps its built-in defaults.
For `mise`, `direnv`, and `pixi`, an empty `detect_files` uses the listed default files while configured extension and folder arrays remain additive detector categories.

## Exact language defaults

| Module | Default files | Default extensions | Default folders | Version command |
| --- | --- | --- | --- | --- |
| `nodejs` | `package.json`, `.node-version`, `.nvmrc`, `!bun.lock`, `!bun.lockb`, `!deno.json`, `!deno.jsonc` | `js`, `mjs`, `cjs`, `ts`, `mts`, `cts` | `node_modules` | `node --version` |
| `python` | `pyproject.toml`, `requirements.txt`, `Pipfile`, `poetry.lock`, `.python-version` | `py` | `.venv`, `venv` | existing active virtualenv interpreter, otherwise `python --version` |
| `rust` | `Cargo.toml` | `rs` | none | safe native `rustc --version` |
| `golang` | `go.mod`, `go.sum`, `go.work` | `go` | none | `go version` |
| `bun` | `bun.lock`, `bun.lockb`, `bunfig.toml` | none | none | `bun --version` |
| `deno` | `deno.json`, `deno.jsonc`, `deno.lock` | none | none | `deno -V` |

Node's negative file defaults prevent Bun and Deno projects from matching Node solely through overlapping JavaScript or TypeScript files.
Node `$engines_version` reads only `engines.node` from a direct `package.json` and does not evaluate the constraint.
Python `$virtualenv` uses the basename of `VIRTUAL_ENV`, then `CONDA_DEFAULT_ENV` when no virtualenv is active.
Python `$pyenv_prefix` reads `PYENV_VERSION` without invoking pyenv.
Rust `$toolchain` reads `RUSTUP_TOOLCHAIN`.
Rust rejects compiler paths beneath `.cargo` or `.rustup` and does not invoke rustup because a shim may install a toolchain.
Go `$mod_version` is reserved and remains empty.

Every language `version_format` defaults to `v$raw` and replaces every `$raw` occurrence with the parsed version without a leading `v`.
Malformed, multiline, replacement-character, failed, killed, timed-out, or oversized version output leaves the command-backed value empty.

## Exact environment and deployment defaults

| Module | Activation default | Optional command or read |
| --- | --- | --- |
| `mise` | direct `mise.toml`, `.mise.toml`, or `.tool-versions` | `mise doctor` only for `$health` |
| `direnv` | direct `.envrc` | `direnv status --json` only for `$rc_path`, `$allowed`, or `$loaded` |
| `conda` | non-empty `CONDA_DEFAULT_ENV`, excluding exact `base` by default | none |
| `pixi` | direct `pixi.toml` or `pixi.lock` | `pixi --version` only for `$version`; direct `pixi.toml` may supply project/workspace name |
| `nix_shell` | `IN_NIX_SHELL` is exactly `pure` or `impure` | none |
| `guix_shell` | non-empty `GUIX_ENVIRONMENT` | none |
| `docker_context` | a non-default Docker context; project files are not required by default | `DOCKER_CONTEXT`, then Docker `config.json` |
| `kubernetes` | a current context from `KUBECONFIG` or `~/.kube/config` | reads at most 8 config files by default |
| `terraform` | direct `.tf`, `.tfplan`, `.tfstate`, or `.terraform` | workspace metadata; `terraform version`, then `tofu version`, only for `$version` |

`mise` maps recognized healthy output to `healthy`, recognized warning/problem output to `issues`, and otherwise leaves `$health` empty.
`direnv` never reads or sources `.envrc`.
`direnv` maps `foundRC.allowed` to `allowed` or `denied`, reports loaded state as `loaded` or `not loaded`, and accepts a bounded legacy `Found RC path ...` fallback.
`pixi` hides the exact environment name `default` unless `show_default_environment = true`.
`pixi` prefers `PIXI_PROJECT_NAME`, then reads `project.name` or `workspace.name` from direct `pixi.toml`.
`nix_shell` publishes allowlisted `NIX_SHELL_NAME` and `NIX_SHELL_LEVEL` only when its state is valid.
`guix_shell` reports only the literal state `active`.

When `[docker_context].only_with_files = true`, default detection checks `Dockerfile`, `docker-compose.yml`, `docker-compose.yaml`, `compose.yml`, and `compose.yaml`.
Non-empty Docker detection arrays replace or extend those direct categories as described above.
Docker suppresses the exact context `default`.

Terraform differs from category-by-category language fallback.
When any Terraform detection array is non-empty, only the complete configured file, extension, and folder arrays are used.
When all three are empty, the built-in `.tf`, `.tfplan`, `.tfstate`, and `.terraform` rules apply.
Terraform workspace precedence is `TF_WORKSPACE`, `TF_DATA_DIR/environment`, then `.terraform/environment`.

### Usage semantics

- During a blocking extension UI prompt, `activity` sets `$state` to `waiting`, `$kind` to the prompt kind, and `$title` to the sanitized bounded title or an empty string.
- Prompt waiting takes precedence without losing the underlying tool, streaming, completed, or idle state, which returns when the prompt closes.
- Activity `$live` omits the symbol and shows `running <tool>`, adding `×<count>` for concurrent calls to that tool and `+<other-tool-count>` for other tool names; streaming without active tools shows `thinking`.
  A prompt instead shows `waiting for <kind>` with ` · <title>` when present.
  Idle and completed states render empty, while legacy `$text` still includes the configured symbol and idle/completed text.
  `$live_style` is `yellow` for a UI prompt and the module's `style` otherwise; the quiet default renders prompt waits through Pi's warning theme role.
- `tokens`, `cache`, and `cost` total every usage-bearing session entry, matching Pi's native session totals.
  This includes assistant messages, nested-LLM tool results, compactions, and branch summaries, including abandoned branches retained in the session; user, custom, model-change, thinking-level-change, label, and session-info entries contribute no usage.
- Tokens `$input`, `$output`, and `$total` retain their legacy meanings: raw input, output, and raw input plus output.
  `$total_input` is the explicit cumulative prompt total used by the default footer: `input + cacheRead + cacheWrite`.
- Cache `$read` and `$write` are cumulative, and the legacy cache format's `$session_rate` is token-weighted across the session: `cacheRead / (input + cacheRead + cacheWrite) * 100`.
  `$rate` remains the optional latest assistant-request rate with that request's token counts.
  With measured non-cached usage, both rates show `0.0%`; with no usage report, rates show `—`.
- `cache` remains enabled at module scope but is absent from the quiet built-in metrics row, as is `brand` from the first row.
  Custom root formats remain authoritative: add or remove `$cache` or use `$all` as desired; valid empty files retain the legacy root including cache.
- Context `$percentage` uses native one-decimal precision.
  The built-in template and legacy module format both show tokens, window, and percentage; display thresholds select color only.
  The quiet template uses muted text below `60%`, warning from `60%`, and error from `80%` through Pi's theme, while legacy module display defaults retain bold green/yellow/red.
  Missing context usage renders `—` rather than a measured zero.
  The module name remains `context`, not `context_usage`.
- Cost is the provider-reported usage estimate and always remains configurable through `[cost]` and `[[cost.display]]`.
  Subscription-backed OAuth models and `kimi-coding` append `$subscription` as `estimate`; this is not proof of an amount billed under a subscription.
  Missing usage renders cost as `—`, while measured zero renders `$0.000`.
  Formatting retains three decimal places below $1 and two from $1.
  `$cost` includes tool-result costs; `$tools` adds ` (tools $x)` only when that included share is positive, such as for subagent runs.
  The quiet template keeps cost dimmed regardless of amount; legacy module display thresholds remain unchanged.

### Directory, Git, and environment contraction

The quiet built-in root adds adaptive middle shortening for long directory, branch, and model output before fill and wrapping.
Only that new root layout receives this width-fitting behavior; usage is never width-shortened, and narrow terminals may still wrap.
Custom roots and presets retain the module-local contraction/truncation rules below.

The analogous modules keep their legacy display policy local and use Starship defaults:

```toml
[directory]
truncation_length = 3
truncate_to_repo = true
fish_style_pwd_dir_length = 0
truncation_symbol = ""
home_symbol = "~"
use_os_path_sep = true
substitutions = { "/Volumes/network/path" = "/net" }

[git_branch]
truncation_length = 0 # pi-starship's bounded no-truncation sentinel
truncation_symbol = "…"

[git_commit]
commit_hash_length = 7

[conda]
ignore_base = true
truncation_length = 1

[hostname]
trim_at = "." # set to "" to keep the complete hostname
```

Directory `$path` contracts the home directory and, by default, the current Git repository root before retaining the last three path components.
`$full_path` remains the unmodified absolute cwd.
A positive `fish_style_pwd_dir_length` abbreviates otherwise omitted parent components when no substitution is configured.
`substitutions` is an ordered TOML string table of literal replacements applied to the already home- or repository-contracted display path, before component truncation.
Pi exposes one cwd rather than separate logical and physical paths, and pi-starship does not implement Starship's regex substitution array or repo-root-specific split style/format fields.
Directory rendering reads only immutable home and repository-root snapshot data and performs no filesystem or Git work.

Git branch truncation retains the first `N` grapheme clusters and appends the first grapheme of `truncation_symbol` only when truncation occurs.
The same rule applies independently to `$branch`, `$remote_name`, and `$remote_branch`.
Upstream Starship represents its unlimited default as `2^63 - 1`; pi-starship uses `0` for the same behavior because its settings integers are deliberately bounded.
`commit_hash_length` accepts 0 through 64.

Git status `$summary` lists nonzero counters as `<count> <label>`, comma-separated in this exact order: conflicted, stashed, deleted, renamed, modified, typechanged, staged, untracked, ahead, behind.
For example: `1 conflicted, 4 modified, 2 ahead`; a clean status is empty.
`$summary_style` is `red` when conflicts exist and the module's `style` otherwise.
The quiet template uses dimmed normal status and Pi's error theme role for conflicts, while legacy `$all_status`, symbolic counters, and module defaults remain unchanged.

Conda retains the last path component by default; `0` keeps the complete environment path.
Hostname trimming runs before exact alias lookup, matching Starship.
These transformations affect display only.
Collectors retain bounded, control-sanitized source metadata.

### Model and provider aliases and model truncation

The model module accepts exact `model_aliases`, Starship-style `truncation_length` and `truncation_symbol` options, plus the Pi-specific `truncation_direction` option:

```toml
[model]
model_aliases = { "/models/Qwen3.6-35B-Q4.gguf" = "Qwen 35B Q4" }
truncation_length = 36
truncation_symbol = "…"
truncation_direction = "middle"
```

An exact alias replaces the label that the built-in Claude/GPT shortening rules would otherwise produce, bypasses those rules, and is then subject to the configured truncation.
`truncation_length` counts model grapheme clusters retained before the symbol; `0` disables truncation and is the default.
The direction names the removed portion: `start` retains the suffix, `end` retains the prefix and is the default, and `middle` retains both ends.
When no alias matches, truncation runs after the built-in Claude/GPT shortening rules.
Truncation changes display only; the provider model ID is untouched.
Terminal control sequences in model IDs and truncation symbols are removed at render time.
An empty symbol truncates without a marker.

The provider module accepts exact display aliases without changing the selected provider or model:

```toml
[provider]
provider_aliases = { "openai-codex" = "codex", "amazon-bedrock" = "bedrock" }
```

An empty alias hides only the provider text.
Provider names and aliases are stripped of terminal controls at render time.
For example, `middle` can retain both a Hugging Face model family and its variant, while `start` is useful when a llama.cpp server reports an absolute model path.
pi-starship treats model IDs as opaque strings and does not parse paths, repositories, GGUF suffixes, or quantization names.

`truncation_direction` is a pi-starship adaptation; upstream Starship has no model module or generic truncation-direction setting.

`git_worktree` is empty in the primary worktree.
In a linked worktree it defaults to the top-level directory name; use `$path` when the full absolute path is needed.

`git_commit`, `git_state`, and `git_metrics` are intentionally not present in the built-in root format.
Add their variables to `format` to opt in; also set `[git_metrics].disabled = false`, matching Starship's opt-in metrics default.
`$tag` resolves only an exact tag on HEAD and is queried only when the configured `git_commit` format references it.
