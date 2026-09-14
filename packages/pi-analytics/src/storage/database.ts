import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
	GenerationRecord,
	ProviderErrorRecord,
	SessionRecord,
	SettledRun,
	SkillActivationRecord,
	ToolCallRecord,
	UsageRecord,
} from "../types.js";

const SCHEMA_VERSION = 2;

// Written as one statement batch so a fresh database reaches the current shape atomically.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
	id TEXT PRIMARY KEY,
	started_at_ms INTEGER NOT NULL,
	finished_at_ms INTEGER NOT NULL,
	duration_ms INTEGER NOT NULL,
	trigger_source TEXT NOT NULL,
	initial_provider TEXT,
	initial_model TEXT,
	outcome TEXT NOT NULL,
	attempt_count INTEGER NOT NULL,
	tool_error_count INTEGER NOT NULL,
	provider_error_count INTEGER NOT NULL,
	recovered_error_count INTEGER NOT NULL,
	input INTEGER NOT NULL DEFAULT 0,
	output INTEGER NOT NULL DEFAULT 0,
	cache_read INTEGER NOT NULL DEFAULT 0,
	cache_write INTEGER NOT NULL DEFAULT 0,
	cost REAL NOT NULL DEFAULT 0
) STRICT;

CREATE INDEX IF NOT EXISTS runs_started_at ON runs (started_at_ms);

CREATE TABLE IF NOT EXISTS generations (
	run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
	id TEXT NOT NULL,
	ordinal INTEGER NOT NULL,
	provider TEXT,
	model TEXT,
	thinking_level TEXT,
	started_at_ms INTEGER NOT NULL,
	finished_at_ms INTEGER,
	duration_ms INTEGER,
	stop_reason TEXT,
	outcome TEXT NOT NULL,
	has_usage INTEGER NOT NULL DEFAULT 0,
	input INTEGER NOT NULL DEFAULT 0,
	output INTEGER NOT NULL DEFAULT 0,
	cache_read INTEGER NOT NULL DEFAULT 0,
	cache_write INTEGER NOT NULL DEFAULT 0,
	cost REAL NOT NULL DEFAULT 0,
	PRIMARY KEY (run_id, id)
) STRICT;

CREATE INDEX IF NOT EXISTS generations_started_at ON generations (started_at_ms);
CREATE INDEX IF NOT EXISTS generations_model ON generations (provider, model);

CREATE TABLE IF NOT EXISTS provider_responses (
	run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
	generation_id TEXT NOT NULL,
	ordinal INTEGER NOT NULL,
	occurred_at_ms INTEGER NOT NULL,
	status INTEGER NOT NULL,
	PRIMARY KEY (run_id, generation_id, ordinal)
) STRICT;

CREATE TABLE IF NOT EXISTS tools (
	run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
	id TEXT NOT NULL,
	ordinal INTEGER NOT NULL,
	name TEXT NOT NULL,
	provider TEXT,
	model TEXT,
	started_at_ms INTEGER NOT NULL,
	finished_at_ms INTEGER,
	duration_ms INTEGER,
	is_error INTEGER NOT NULL,
	completion_state TEXT NOT NULL,
	PRIMARY KEY (run_id, id)
) STRICT;

CREATE TABLE IF NOT EXISTS skills (
	run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
	id TEXT NOT NULL,
	name TEXT NOT NULL,
	initiated_by TEXT NOT NULL,
	occurred_at_ms INTEGER NOT NULL,
	provider TEXT,
	model TEXT,
	PRIMARY KEY (run_id, id)
) STRICT;

CREATE TABLE IF NOT EXISTS sessions (
	id TEXT PRIMARY KEY,
	project TEXT NOT NULL,
	started_at_ms INTEGER NOT NULL,
	ended_at_ms INTEGER NOT NULL,
	llm_calls INTEGER NOT NULL,
	input INTEGER NOT NULL DEFAULT 0,
	output INTEGER NOT NULL DEFAULT 0,
	cache_read INTEGER NOT NULL DEFAULT 0,
	cache_write INTEGER NOT NULL DEFAULT 0,
	cost REAL NOT NULL DEFAULT 0
) STRICT;

CREATE INDEX IF NOT EXISTS sessions_started_at ON sessions (started_at_ms);

CREATE TABLE IF NOT EXISTS provider_errors (
	run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
	id TEXT NOT NULL,
	generation_id TEXT,
	occurred_at_ms INTEGER NOT NULL,
	provider TEXT,
	model TEXT,
	category TEXT NOT NULL,
	recovered INTEGER NOT NULL,
	terminal INTEGER NOT NULL,
	PRIMARY KEY (run_id, id)
) STRICT;
`;

export interface ClearAnalyticsResult {
	cleanupIncomplete: boolean;
}

/**
 * Stores settled runs in a single SQLite database.
 *
 * Concurrent Pi processes share one file: WAL keeps readers from blocking the writer, and
 * `busy_timeout` absorbs the brief write locks another process holds. Each run is inserted in one
 * transaction, so a crash mid-write leaves no partial run behind.
 */
export class AnalyticsDatabase {
	private database: DatabaseSync | undefined;
	private opening: Promise<DatabaseSync> | undefined;
	private closed = false;

	constructor(
		readonly path: string,
		private readonly options: { busyTimeoutMs?: number } = {},
	) {}

	async recordRun(run: SettledRun, signal?: AbortSignal): Promise<void> {
		throwIfAborted(signal);
		const database = await this.open();
		throwIfAborted(signal);
		insertRun(database, run);
	}

	async readRuns(fromMs: number, toMs: number, signal?: AbortSignal): Promise<SettledRun[]> {
		throwIfAborted(signal);
		const database = await this.open();
		throwIfAborted(signal);
		return selectRuns(database, fromMs, toMs);
	}

	async recordSessions(sessions: readonly SessionRecord[], signal?: AbortSignal): Promise<void> {
		throwIfAborted(signal);
		const database = await this.open();
		throwIfAborted(signal);
		insertSessions(database, sessions);
	}

	async readSessions(fromMs: number, toMs: number, signal?: AbortSignal): Promise<SessionRecord[]> {
		throwIfAborted(signal);
		const database = await this.open();
		throwIfAborted(signal);
		return selectSessions(database, fromMs, toMs);
	}

	async clearAll(signal?: AbortSignal): Promise<ClearAnalyticsResult> {
		throwIfAborted(signal);
		const database = await this.open();
		throwIfAborted(signal);
		database.exec(
			"BEGIN IMMEDIATE; DELETE FROM sessions; DELETE FROM provider_errors; DELETE FROM skills; DELETE FROM tools; DELETE FROM provider_responses; DELETE FROM generations; DELETE FROM runs; COMMIT;",
		);
		// VACUUM cannot run inside a transaction and only reclaims space; a busy database keeps
		// the pages instead of failing the clear.
		try {
			database.exec("VACUUM");
		} catch {
			return { cleanupIncomplete: true };
		}
		return { cleanupIncomplete: false };
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		const pending = this.opening;
		this.opening = undefined;
		if (pending) await pending.catch(() => undefined);
		this.database?.close();
		this.database = undefined;
	}

	private open(): Promise<DatabaseSync> {
		if (this.closed) return Promise.reject(new Error("Analytics storage is closed."));
		if (this.database) return Promise.resolve(this.database);
		this.opening ??= this.openDatabase();
		return this.opening;
	}

	private async openDatabase(): Promise<DatabaseSync> {
		const directory = path.dirname(this.path);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const database = new DatabaseSync(this.path);
		database.exec(`PRAGMA busy_timeout = ${Math.max(1, this.options.busyTimeoutMs ?? 5_000)}`);
		database.exec("PRAGMA journal_mode = WAL");
		database.exec("PRAGMA synchronous = NORMAL");
		database.exec("PRAGMA foreign_keys = ON");
		database.exec(SCHEMA);
		database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
		// The database and its WAL sidecars carry analytics history; keep them owner-only.
		if (process.platform !== "win32") {
			await chmod(this.path, 0o600).catch(() => undefined);
		}
		this.database = database;
		return database;
	}
}

function insertRun(database: DatabaseSync, run: SettledRun): void {
	database.exec("BEGIN IMMEDIATE");
	try {
		// A replayed run replaces its previous rows so a retried write cannot double-count.
		database.prepare("DELETE FROM runs WHERE id = ?").run(run.id);
		database
			.prepare(
				`INSERT INTO runs (
					id, started_at_ms, finished_at_ms, duration_ms, trigger_source,
					initial_provider, initial_model, outcome, attempt_count,
					tool_error_count, provider_error_count, recovered_error_count,
					input, output, cache_read, cache_write, cost
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				run.id,
				run.startedAtMs,
				run.finishedAtMs,
				run.durationMs,
				run.triggerSource,
				run.initialProvider ?? null,
				run.initialModel ?? null,
				run.outcome,
				run.attemptCount,
				run.toolErrorCount,
				run.providerErrorCount,
				run.recoveredErrorCount,
				run.usage.input,
				run.usage.output,
				run.usage.cacheRead,
				run.usage.cacheWrite,
				run.usage.cost,
			);

		const generation = database.prepare(
			`INSERT INTO generations (
				run_id, id, ordinal, provider, model, thinking_level,
				started_at_ms, finished_at_ms, duration_ms, stop_reason, outcome,
				has_usage, input, output, cache_read, cache_write, cost
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		const response = database.prepare(
			`INSERT INTO provider_responses (run_id, generation_id, ordinal, occurred_at_ms, status)
			 VALUES (?, ?, ?, ?, ?)`,
		);
		for (const item of run.generations) {
			generation.run(
				run.id,
				item.id,
				item.ordinal,
				item.provider ?? null,
				item.model ?? null,
				item.thinkingLevel ?? null,
				item.startedAtMs,
				item.finishedAtMs ?? null,
				item.durationMs ?? null,
				item.stopReason ?? null,
				item.outcome,
				item.usage ? 1 : 0,
				item.usage?.input ?? 0,
				item.usage?.output ?? 0,
				item.usage?.cacheRead ?? 0,
				item.usage?.cacheWrite ?? 0,
				item.usage?.cost ?? 0,
			);
			for (const entry of item.responses) {
				response.run(run.id, item.id, entry.ordinal, entry.occurredAtMs, entry.status);
			}
		}

		const tool = database.prepare(
			`INSERT INTO tools (
				run_id, id, ordinal, name, provider, model,
				started_at_ms, finished_at_ms, duration_ms, is_error, completion_state
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		for (const item of run.tools) {
			tool.run(
				run.id,
				item.id,
				item.ordinal,
				item.name,
				item.provider ?? null,
				item.model ?? null,
				item.startedAtMs,
				item.finishedAtMs ?? null,
				item.durationMs ?? null,
				item.isError ? 1 : 0,
				item.completionState,
			);
		}

		const skill = database.prepare(
			`INSERT INTO skills (run_id, id, name, initiated_by, occurred_at_ms, provider, model)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		);
		for (const item of run.skills) {
			skill.run(
				run.id,
				item.id,
				item.name,
				item.initiatedBy,
				item.occurredAtMs,
				item.provider ?? null,
				item.model ?? null,
			);
		}

		const error = database.prepare(
			`INSERT INTO provider_errors (
				run_id, id, generation_id, occurred_at_ms, provider, model, category, recovered, terminal
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		for (const item of run.providerErrors) {
			error.run(
				run.id,
				item.id,
				item.generationId ?? null,
				item.occurredAtMs,
				item.provider ?? null,
				item.model ?? null,
				item.category,
				item.recovered ? 1 : 0,
				item.terminal ? 1 : 0,
			);
		}
		database.exec("COMMIT");
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
	}
}

function insertSessions(database: DatabaseSync, sessions: readonly SessionRecord[]): void {
	database.exec("BEGIN IMMEDIATE");
	try {
		// Re-running the backfill replaces each session instead of duplicating it.
		const statement = database.prepare(
			`INSERT OR REPLACE INTO sessions (
				id, project, started_at_ms, ended_at_ms, llm_calls,
				input, output, cache_read, cache_write, cost
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		for (const session of sessions) {
			statement.run(
				session.id,
				session.project,
				session.startedAtMs,
				session.endedAtMs,
				session.llmCalls,
				session.usage.input,
				session.usage.output,
				session.usage.cacheRead,
				session.usage.cacheWrite,
				session.usage.cost,
			);
		}
		database.exec("COMMIT");
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
	}
}

function selectSessions(database: DatabaseSync, fromMs: number, toMs: number): SessionRecord[] {
	const rows = database
		.prepare(
			`SELECT * FROM sessions WHERE started_at_ms >= ? AND started_at_ms < ? ORDER BY started_at_ms`,
		)
		.all(fromMs, toMs) as Record<string, unknown>[];
	return rows.map((row) => ({
		id: text(row.id) ?? "",
		project: text(row.project) ?? "",
		startedAtMs: integer(row.started_at_ms),
		endedAtMs: integer(row.ended_at_ms),
		llmCalls: integer(row.llm_calls),
		usage: usageFrom(row),
	}));
}

function selectRuns(database: DatabaseSync, fromMs: number, toMs: number): SettledRun[] {
	const rows = database
		.prepare(
			`SELECT * FROM runs WHERE started_at_ms >= ? AND started_at_ms < ? ORDER BY started_at_ms`,
		)
		.all(fromMs, toMs) as Record<string, unknown>[];
	if (rows.length === 0) return [];

	const runs = new Map<string, SettledRun>();
	for (const row of rows) {
		const id = text(row.id) ?? "";
		runs.set(id, {
			id,
			startedAtMs: integer(row.started_at_ms),
			finishedAtMs: integer(row.finished_at_ms),
			durationMs: integer(row.duration_ms),
			triggerSource: (text(row.trigger_source) ?? "unknown") as SettledRun["triggerSource"],
			initialProvider: text(row.initial_provider),
			initialModel: text(row.initial_model),
			outcome: (text(row.outcome) ?? "success") as SettledRun["outcome"],
			attemptCount: integer(row.attempt_count),
			generations: [],
			tools: [],
			skills: [],
			providerErrors: [],
			toolErrorCount: integer(row.tool_error_count),
			providerErrorCount: integer(row.provider_error_count),
			recoveredErrorCount: integer(row.recovered_error_count),
			usage: usageFrom(row),
		});
	}

	const scope = `WHERE run_id IN (SELECT id FROM runs WHERE started_at_ms >= ? AND started_at_ms < ?)`;
	const generations = new Map<string, GenerationRecord>();
	for (const row of database
		.prepare(`SELECT * FROM generations ${scope} ORDER BY ordinal`)
		.all(fromMs, toMs) as Record<string, unknown>[]) {
		const runId = text(row.run_id) ?? "";
		const id = text(row.id) ?? "";
		const record: GenerationRecord = {
			id,
			ordinal: integer(row.ordinal),
			provider: text(row.provider),
			model: text(row.model),
			thinkingLevel: text(row.thinking_level),
			startedAtMs: integer(row.started_at_ms),
			finishedAtMs: optionalInteger(row.finished_at_ms),
			durationMs: optionalInteger(row.duration_ms),
			stopReason: text(row.stop_reason),
			outcome: (text(row.outcome) ?? "pending") as GenerationRecord["outcome"],
			usage: integer(row.has_usage) === 1 ? usageFrom(row) : undefined,
			responses: [],
		};
		generations.set(`${runId} ${id}`, record);
		runs.get(runId)?.generations.push(record);
	}

	for (const row of database
		.prepare(`SELECT * FROM provider_responses ${scope} ORDER BY ordinal`)
		.all(fromMs, toMs) as Record<string, unknown>[]) {
		const key = `${text(row.run_id) ?? ""} ${text(row.generation_id) ?? ""}`;
		generations.get(key)?.responses.push({
			ordinal: integer(row.ordinal),
			occurredAtMs: integer(row.occurred_at_ms),
			status: integer(row.status),
		});
	}

	for (const row of database
		.prepare(`SELECT * FROM tools ${scope} ORDER BY ordinal`)
		.all(fromMs, toMs) as Record<string, unknown>[]) {
		const tool: ToolCallRecord = {
			id: text(row.id) ?? "",
			ordinal: integer(row.ordinal),
			name: text(row.name) ?? "",
			provider: text(row.provider),
			model: text(row.model),
			startedAtMs: integer(row.started_at_ms),
			finishedAtMs: optionalInteger(row.finished_at_ms),
			durationMs: optionalInteger(row.duration_ms),
			isError: integer(row.is_error) === 1,
			completionState: (text(row.completion_state) ??
				"finished") as ToolCallRecord["completionState"],
		};
		runs.get(text(row.run_id) ?? "")?.tools.push(tool);
	}

	for (const row of database
		.prepare(`SELECT * FROM skills ${scope} ORDER BY occurred_at_ms`)
		.all(fromMs, toMs) as Record<string, unknown>[]) {
		const skill: SkillActivationRecord = {
			id: text(row.id) ?? "",
			name: text(row.name) ?? "",
			initiatedBy: (text(row.initiated_by) ?? "model") as SkillActivationRecord["initiatedBy"],
			occurredAtMs: integer(row.occurred_at_ms),
			provider: text(row.provider),
			model: text(row.model),
		};
		runs.get(text(row.run_id) ?? "")?.skills.push(skill);
	}

	for (const row of database
		.prepare(`SELECT * FROM provider_errors ${scope} ORDER BY occurred_at_ms`)
		.all(fromMs, toMs) as Record<string, unknown>[]) {
		const error: ProviderErrorRecord = {
			id: text(row.id) ?? "",
			generationId: text(row.generation_id),
			occurredAtMs: integer(row.occurred_at_ms),
			provider: text(row.provider),
			model: text(row.model),
			category: (text(row.category) ?? "provider_other") as ProviderErrorRecord["category"],
			recovered: integer(row.recovered) === 1,
			terminal: integer(row.terminal) === 1,
		};
		runs.get(text(row.run_id) ?? "")?.providerErrors.push(error);
	}

	return [...runs.values()];
}

function usageFrom(row: Record<string, unknown>): UsageRecord {
	return {
		input: integer(row.input),
		output: integer(row.output),
		cacheRead: integer(row.cache_read),
		cacheWrite: integer(row.cache_write),
		cost: Number(row.cost ?? 0),
	};
}

function text(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function integer(value: unknown): number {
	return Number(value ?? 0);
}

function optionalInteger(value: unknown): number | undefined {
	return value === null || value === undefined ? undefined : Number(value);
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw signal.reason ?? new DOMException("Analytics operation aborted", "AbortError");
	}
}
