# 📈 pi-analytics — Understand Pi Activity Without Sending Data Away

[![npm](https://img.shields.io/npm/v/@narumitw/pi-analytics)](https://www.npmjs.com/package/@narumitw/pi-analytics) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Measure local model, skill, tool, and provider reliability activity without storing conversation or tool content or sending analytics elsewhere.

## ✨ Features

- Collects content-free metrics automatically after installation.
- Counts settled response cycles, logical LLM calls, skill activations, tool calls, and observed provider errors.
- Reports tool failures and duration, model attribution, and per-response call distributions.
- Separates recovered provider errors from terminal failures.
- Reports sessions, active days, streaks, an activity heatmap, and per-project totals from imported session history.
- Provides Today, rolling 7-day, rolling 30-day, and all-time views through `/analytics`.
- Stores a private local SQLite database, isolates concurrent writers with WAL, and does not start an analytics server.

## 📦 Install

Install persistently:

```bash
pi install npm:@narumitw/pi-analytics
```

Try the published package without installing:

```bash
pi -e npm:@narumitw/pi-analytics
```

Build and try a local checkout from the repository root:

```bash
npm --workspace @narumitw/pi-analytics run build
pi -e ./packages/pi-analytics
```

The package declares `dist/index.ts`, so an unbuilt local checkout must run the build before Pi loads the package directory.

The extension uses Node's built-in filesystem APIs and has no native database dependency.
Pi extensions run with the Pi process's user permissions, so install only trusted packages.

## 🚀 Quick start

Complete at least one Pi response, then run:

```text
/analytics
```

The default overview covers the last seven rolling days:

```text
Analytics · Last 7 days

Response cycles                    83
LLM calls                         192
Calls per response        2.31 · P95 6
Tool calls                        414
Tool errors                         7
Skill activations                  31
Provider errors                     4
Recovered errors                    3
Tokens                             1.08M · $4.13
```

Use the menu to change the range or inspect Tokens & cost, Skills, Tools, Provider reliability, Response cycles, and Data & privacy.
The dashboard includes finalized cycles and omits active work.

## 📐 Metric definitions

### Tokens and cost

**Tokens & cost** reports the usage counters the provider returned with each assistant message, summed over the selected range and broken down per model.

Prompt tokens are kept apart rather than merged: **Input (uncached)** is billed at the full rate, **Cache read** is served from the cache, and **Cache write** is the cost of populating it.
**Cache hit rate** is `cache read ÷ (input + cache read + cache write)`.

Only calls whose counters the provider actually reported are included.
A call that returns no usage is counted under **Calls without usage** instead of being treated as zero tokens, so totals never understate real spend.

### Sessions and activity

**Sessions & activity** covers rows imported by `scripts/backfill-sessions.mjs`; the extension cannot collect them live because no Pi extension event carries a session identity.

**Active days** counts distinct local calendar days with at least one session, over the days spanned by the range.
**Longest streak** is the longest run of consecutive active days; **current streak** is the run ending on the range's last day, and a single trailing gap day does not end it.
**Session length** is wall-clock time from a session's first to last log entry, so idle time inside a session is included.

### Response cycles and LLM calls

A **response cycle** starts when Pi begins agent work and normally ends at `agent_settled`.
Retries, overflow-compaction recovery, tool follow-ups, and queued continuations before settlement remain in that cycle.

An **LLM call** is one logical provider generation.
A provider can make several HTTP attempts within it, so `429 → 429 → 200` counts as one LLM call, three observed HTTP responses, two provider errors, and one recovered generation.

### Skills

An activation is **User initiated** when an observed interactive or RPC `/skill:<name>` input belongs to an active or subsequently started response cycle.
This includes skill commands queued while Pi is streaming.
It is **Model initiated** when Pi's built-in `read` tool successfully loads the exact canonical `SKILL.md` path Pi discovered.
Each skill counts at most once per response cycle, with explicit user use taking precedence.

Pi does not expose a first-class skill-invocation event or post-chain acceptance event to input observers.
The extension does not count unsuccessful reads, provider behavior hidden from Pi, or non-standard loading such as `bash` plus `cat SKILL.md`.

### Tools

A tool call starts at Pi's `tool_execution_start` event and finishes at `tool_execution_end`.
The extension stores the tool name, model attribution, timing, completion state, and final error flag.
Pi does not expose enough information to distinguish a call blocked by another extension from other tool errors, so both count as errors.

### Provider reliability

Pi exposes HTTP responses and final assistant failures, but not every provider-SDK transport retry.
The dashboard therefore calls these values **observed provider errors**.
It reports HTTP 429 and 5xx counts, conservative error categories, recovered errors, and terminal failures.
Raw error messages are classified in memory and discarded.

## 💬 Commands

Run `/analytics` to inspect local usage, skills, tools, and provider reliability over a chosen time range.
It accepts no arguments and supports TUI and RPC; print and JSON modes reject it before reading analytics data.
Deleting analytics data requires confirmation, and cancellation leaves data unchanged.

## 🔒 Security and privacy

Current analytics live under:

```text
<pi-agent-directory>/pi-analytics.db
<pi-agent-directory>/pi-analytics.db-wal
<pi-agent-directory>/pi-analytics.db-shm
```

The database is plain SQLite, so any SQLite client can read it directly for ad-hoc analysis.
Record IDs for collected runs are generated by the extension; they are not Pi session IDs.
On Unix, the database is restricted to mode `0600`.

Stored fields are limited to timestamps and durations; extension-generated record IDs; provider/model IDs and thinking level; tool and skill names; user/model skill source; counts, outcomes, and completion states; token counts and costs reported by the provider; HTTP status codes; and classified provider-error categories.
Provider-supplied tool-call IDs are replaced with local ordinals before publication.
The extension does **not** store prompts, responses, thinking content, tool arguments or results, raw error messages, HTTP headers, file paths, or credentials.

Imported sessions are the one exception to the identifiers above, and they are only ever written by `scripts/backfill-sessions.mjs`: each row keeps Pi's session ID and the working-directory **basename** (for example `pi-extensions`) so activity can be attributed per project.
The full path is never stored. Skip a project with `--exclude`, or restrict the import with `--include`.

Each finalized response cycle is written in one transaction, so a crash cannot leave a partial cycle behind.
Concurrent Pi processes share the database through WAL, and a brief write lock held by another process is absorbed by a 5-second busy timeout.
The extension reports the first failed write and a later recovery without exposing filesystem errors.

`/analytics` reads the selected time range through indexed queries and checks cancellation before each read.

### Clear analytics data

Choose **Data & privacy → Clear analytics data…** to delete every record in one transaction.
Other Pi processes observe the empty database on their next read.
A record racing with Clear can land immediately before or after it.

The extension then runs `VACUUM` to release the file's pages.
If another process is using the database, Clear reports incomplete physical cleanup while the logical clear remains complete.
File deletion does not guarantee secure erasure from the storage medium.

## 🧭 Importing session history

`/analytics` only sees what the extension collected. Pi's own session logs go back further and record the provider's usage counters for every assistant message, so a one-off import backfills tokens, cost, sessions, active days, and streaks:

```bash
# Preview without writing anything.
node scripts/backfill-sessions.mjs --dry-run

# Import.
node scripts/backfill-sessions.mjs

# Import only personal projects.
node scripts/backfill-sessions.mjs --exclude work-repo --exclude other-repo
```

The import is idempotent: sessions are keyed by session ID and replaced on re-run, so it is safe to run again after more sessions accumulate.
It creates the database if it does not exist yet, and `--sessions` / `--database` override the default locations.

Versions that stored JSONL kept data in `<pi-agent-directory>/pi-analytics/`.
That directory holds no token counters, is not read by this version, and can be deleted manually once no old Pi process is running.

## 🚧 Limitations

- There are no retention settings; records remain until explicitly cleared.
- Analytics are best-effort derived metadata.
  A failed or interrupted local write may be omitted.
- Large all-time histories are read into memory when the dashboard opens.
- Prometheus, JSON/CSV export, cloud sync, and browser dashboards are not included.
- Sessions, active days, and streaks come only from the one-off import; they are not collected live.
- Session history predating token support carries no per-call usage for collected runs, and `cacheWrite` is absent from Pi session logs, so cache hit rate is computed without it.
- Statistics cover only events visible through Pi's public extension API.

## 🗂️ Package layout

```text
packages/pi-analytics/
├── src/                               # Authoritative implementation and helpers
│   ├── index.ts                       # Thin Pi entrypoint
│   ├── analytics.ts                   # Collection lifecycle and dashboard command
│   └── storage/database.ts            # SQLite schema and run persistence
├── dist/                              # Generated Jiti runtime
├── scripts/build-runtime.mjs          # Runtime builder
├── scripts/backfill-sessions.mjs      # One-off import of Pi session logs
└── test/                              # Behavior and lifecycle coverage
```

The generated runtime is built from `src/index.ts` and does not import back into `src`.

## 🔎 Keywords

Pi extension, Pi coding agent, local analytics, agent skills, tool usage, model calls, provider reliability, token usage, session history, activity heatmap, SQLite, content-free metrics.

## 📄 License

MIT.
See [`LICENSE`](./LICENSE).
