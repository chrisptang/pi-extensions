import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type TestContext, test, vi } from "vitest";
import { AnalyticsDatabase } from "../src/storage/database.js";
import { resolveTimeRange } from "../src/storage/queries.js";
import { DatabaseSync } from "../src/storage/sqlite.js";
import { AnalyticsStore } from "../src/storage/store.js";
import type { SessionRecord, SettledRun } from "../src/types.js";

function run(id: string, startedAtMs: number, options: Partial<SettledRun> = {}): SettledRun {
	return {
		id,
		startedAtMs,
		finishedAtMs: startedAtMs + 100,
		durationMs: 100,
		triggerSource: "interactive",
		initialProvider: "openai",
		initialModel: "gpt-test",
		outcome: "success",
		attemptCount: 1,
		generations: [],
		tools: [],
		skills: [],
		providerErrors: [],
		toolErrorCount: 0,
		providerErrorCount: 0,
		recoveredErrorCount: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
		...options,
	};
}

async function fixture(t: TestContext): Promise<AnalyticsStore> {
	const directory = await mkdtemp(path.join(tmpdir(), "pi-analytics-store-"));
	t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
	const store = new AnalyticsStore(path.join(directory, "pi-analytics.db"));
	t.onTestFinished(() => store.close().catch(() => undefined));
	return store;
}

test("store publishes a content-free run and returns reconciled analytics", async (t) => {
	const store = await fixture(t);
	const started = new Date(2026, 7, 2, 12).getTime();
	await store.recordRun(
		run("run-1", started, {
			outcome: "recovered_success",
			attemptCount: 2,
			generations: [
				{
					id: "g1",
					ordinal: 0,
					provider: "openai",
					model: "gpt-a",
					startedAtMs: started,
					finishedAtMs: started + 10,
					durationMs: 10,
					stopReason: "error",
					outcome: "error",
					responses: [
						{ ordinal: 0, occurredAtMs: started + 1, status: 429 },
						{ ordinal: 1, occurredAtMs: started + 2, status: 500 },
					],
				},
				{
					id: "g2",
					ordinal: 1,
					provider: "anthropic",
					model: "claude-b",
					startedAtMs: started + 20,
					finishedAtMs: started + 40,
					durationMs: 20,
					stopReason: "stop",
					outcome: "stop",
					responses: [{ ordinal: 0, occurredAtMs: started + 21, status: 200 }],
				},
			],
			tools: [
				{
					id: "tool-1",
					ordinal: 0,
					name: "read",
					provider: "openai",
					model: "gpt-a",
					startedAtMs: started + 5,
					finishedAtMs: started + 15,
					durationMs: 10,
					isError: true,
					completionState: "finished",
				},
			],
			skills: [
				{
					id: "skill-1",
					name: "reviewing-code",
					initiatedBy: "model",
					occurredAtMs: started + 5,
					provider: "openai",
					model: "gpt-a",
				},
			],
			providerErrors: [
				{
					id: "error-1",
					generationId: "g1",
					occurredAtMs: started + 10,
					provider: "openai",
					model: "gpt-a",
					category: "timeout",
					recovered: true,
					terminal: false,
				},
			],
			toolErrorCount: 1,
			providerErrorCount: 3,
			recoveredErrorCount: 3,
		}),
	);

	const snapshot = await store.getSnapshot({ fromMs: started - 1, toMs: started + 1_000 });
	assert.deepEqual(snapshot.overview, {
		responseCycles: 1,
		llmCalls: 2,
		callsPerResponse: 2,
		p95CallsPerResponse: 2,
		toolCalls: 1,
		toolErrors: 1,
		skillActivations: 1,
		providerErrors: 3,
		recoveredErrors: 3,
	});
	assert.deepEqual(snapshot.skills[0]?.models, [{ provider: "openai", model: "gpt-a", count: 1 }]);
	assert.equal(snapshot.tools[0]?.averageDurationMs, 10);
	assert.equal(snapshot.reliability.http429, 1);
	assert.equal(snapshot.reliability.http5xx, 1);
	assert.equal(snapshot.reliability.categories.timeout, 1);
});

test("duplicate run ids remain idempotent across independent writer files", async (t) => {
	const directory = await mkdtemp(path.join(tmpdir(), "pi-analytics-dedup-"));
	t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
	const root = path.join(directory, "pi-analytics.db");
	const left = new AnalyticsStore(root);
	const right = new AnalyticsStore(root);
	t.onTestFinished(async () => {
		await Promise.all([left.close(), right.close()]);
	});
	await Promise.all([left.recordRun(run("same", 1)), right.recordRun(run("same", 1))]);
	assert.equal((await left.getSnapshot({ fromMs: 0, toMs: 10 })).overview.responseCycles, 1);
});

test("two stores publish concurrently and clear switches every writer to fresh data", async (t) => {
	const directory = await mkdtemp(path.join(tmpdir(), "pi-analytics-concurrent-"));
	t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
	const root = path.join(directory, "pi-analytics.db");
	const left = new AnalyticsStore(root);
	const right = new AnalyticsStore(root);
	t.onTestFinished(async () => {
		await Promise.all([left.close(), right.close()]);
	});
	await Promise.all(
		Array.from({ length: 20 }, (_, index) =>
			(index % 2 ? left : right).recordRun(run(`run-${index}`, index + 1)),
		),
	);
	assert.equal((await left.getSnapshot({ fromMs: 0, toMs: 100 })).overview.responseCycles, 20);
	assert.equal((await left.clearAll()).cleanupIncomplete, false);
	await right.recordRun(run("new", 50));
	assert.deepEqual((await left.getSnapshot({ fromMs: 0, toMs: 100 })).overview.responseCycles, 1);
});

test("a snapshot taken after Clear sees only data written afterwards", async (t) => {
	const directory = await mkdtemp(path.join(tmpdir(), "pi-analytics-read-clear-"));
	t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
	const root = path.join(directory, "pi-analytics.db");
	const writer = new AnalyticsStore(root);
	const reader = new AnalyticsStore(root);
	t.onTestFinished(async () => {
		await Promise.all([writer.close(), reader.close()]);
	});
	await writer.recordRun(run("before", 1));
	await writer.clearAll();
	assert.equal((await reader.getSnapshot({ fromMs: 0, toMs: 10 })).overview.responseCycles, 0);
	await writer.recordRun(run("after", 2));
	assert.equal((await reader.getSnapshot({ fromMs: 0, toMs: 10 })).overview.responseCycles, 1);
});

test("snapshot cancellation rejects before reading", async (t) => {
	const store = await fixture(t);
	await store.recordRun(run("before", 1));
	const controller = new AbortController();
	controller.abort(new DOMException("cancelled read", "AbortError"));
	await assert.rejects(
		store.getSnapshot({ fromMs: 0, toMs: 10 }, controller.signal),
		/cancelled read/,
	);
});

test("response statistics honor exact bounds and nearest-rank percentiles", async (t) => {
	const store = await fixture(t);
	for (const [index, calls] of [1, 2, 3, 4, 7, 9].entries()) {
		await store.recordRun(
			run(`range-${index}`, 100 + index, {
				generations: Array.from({ length: calls }, (_, ordinal) => ({
					id: `range-${index}-generation-${ordinal}`,
					ordinal,
					startedAtMs: 100 + index,
					outcome: "stop" as const,
					responses: [],
				})),
			}),
		);
	}
	const snapshot = await store.getSnapshot({ fromMs: 101, toMs: 105 });
	assert.equal(snapshot.responses.count, 4);
	assert.equal(snapshot.responses.average, 4);
	assert.equal(snapshot.responses.median, 3.5);
	assert.equal(snapshot.responses.p95, 7);
	assert.equal(snapshot.responses.maximum, 7);
	assert.deepEqual(snapshot.responses.distribution, {
		one: 0,
		twoToThree: 2,
		fourToSix: 1,
		sevenPlus: 1,
	});
});

test("token usage survives a round trip and aggregates per model", async (t) => {
	const store = await fixture(t);
	const started = 1_000;
	const generation = (id: string, provider: string, model: string, input: number) => ({
		id,
		ordinal: 0,
		provider,
		model,
		startedAtMs: started,
		outcome: "stop" as const,
		usage: { input, output: 10, cacheRead: 40, cacheWrite: 5, cost: 0.25 },
		responses: [],
	});
	await store.recordRun(
		run("tokens-1", started, {
			generations: [generation("g1", "anthropic", "claude-b", 100)],
			usage: { input: 100, output: 10, cacheRead: 40, cacheWrite: 5, cost: 0.25 },
		}),
	);
	await store.recordRun(
		run("tokens-2", started + 1, {
			generations: [
				{ ...generation("g2", "anthropic", "claude-b", 60), ordinal: 0 },
				// A generation without usage counters must not be counted as zero tokens.
				{
					id: "g3",
					ordinal: 1,
					provider: "openai",
					model: "gpt-a",
					startedAtMs: started + 1,
					outcome: "stop" as const,
					responses: [],
				},
			],
		}),
	);

	const snapshot = await store.getSnapshot({ fromMs: 0, toMs: 10_000 });
	assert.equal(snapshot.tokens.input, 160);
	assert.equal(snapshot.tokens.output, 20);
	assert.equal(snapshot.tokens.cacheRead, 80);
	assert.equal(snapshot.tokens.cacheWrite, 10);
	assert.equal(snapshot.tokens.tokens, 270);
	assert.equal(snapshot.tokens.cost, 0.5);
	assert.equal(snapshot.tokens.measuredCalls, 2);
	assert.equal(snapshot.tokens.unmeasuredCalls, 1);
	// Cache reads over all prompt tokens: 80 / (160 + 80 + 10).
	assert.equal(Math.round(snapshot.tokens.cacheHitRate), 32);
	assert.deepEqual(
		snapshot.tokens.models.map(({ provider, model, calls, tokens }) => ({
			provider,
			model,
			calls,
			tokens,
		})),
		[{ provider: "anthropic", model: "claude-b", calls: 2, tokens: 270 }],
	);
});

test("first-token timestamps round-trip and drive per-model TTFT and tok/s", async (t) => {
	const store = await fixture(t);
	const started = 1_000;
	await store.recordRun(
		run("perf-1", started, {
			generations: [
				{
					id: "g1",
					ordinal: 0,
					provider: "openai",
					model: "gpt-a",
					startedAtMs: started,
					firstTokenAtMs: started + 50,
					finishedAtMs: started + 150,
					durationMs: 150,
					outcome: "stop",
					usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0 },
					responses: [],
				},
				{
					id: "g2",
					ordinal: 1,
					provider: "openai",
					model: "gpt-a",
					startedAtMs: started + 1_000,
					firstTokenAtMs: started + 1_200,
					finishedAtMs: started + 1_400,
					durationMs: 400,
					outcome: "stop",
					usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0 },
					responses: [],
				},
				// No stream event recorded: counted as a call but excluded from both metrics.
				{
					id: "g3",
					ordinal: 2,
					provider: "anthropic",
					model: "claude-b",
					startedAtMs: started + 2_000,
					outcome: "stop",
					responses: [],
				},
			],
		}),
	);

	const snapshot = await store.getSnapshot({ fromMs: 0, toMs: 10_000 });
	assert.equal(snapshot.performance.length, 2);
	const gpt = snapshot.performance.find(({ model }) => model === "gpt-a");
	assert.ok(gpt);
	assert.equal(gpt.calls, 2);
	// TTFT samples: 50 and 200 ms.
	assert.deepEqual(gpt.timeToFirstToken, { measured: 2, average: 125, p95: 200, maximum: 200 });
	// Output rates: 10/0.1s = 100 and 20/0.2s = 100 tok/s.
	assert.deepEqual(gpt.outputTokensPerSecond, {
		measured: 2,
		average: 100,
		p95: 100,
		maximum: 100,
	});
	const claude = snapshot.performance.find(({ model }) => model === "claude-b");
	assert.ok(claude);
	assert.equal(claude.calls, 1);
	assert.equal(claude.timeToFirstToken.measured, 0);
	assert.equal(claude.outputTokensPerSecond.measured, 0);
});

test("a pre-v3 database gains the first-token column and keeps its rows", async (t) => {
	const directory = await mkdtemp(path.join(tmpdir(), "pi-analytics-migrate-"));
	t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
	const root = path.join(directory, "pi-analytics.db");
	const legacy = new DatabaseSync(root);
	// The v2 generations shape, before first_token_at_ms existed.
	legacy.exec(`
		CREATE TABLE runs (
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
		CREATE TABLE generations (
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
		INSERT INTO runs (
			id, started_at_ms, finished_at_ms, duration_ms, trigger_source,
			outcome, attempt_count, tool_error_count, provider_error_count, recovered_error_count
		) VALUES ('legacy', 1, 2, 1, 'interactive', 'success', 1, 0, 0, 0);
		INSERT INTO generations (
			run_id, id, ordinal, provider, model, started_at_ms, finished_at_ms, duration_ms, outcome
		) VALUES ('legacy', 'g1', 0, 'openai', 'gpt-old', 1, 2, 1, 'stop');
		PRAGMA user_version = 2;
	`);
	legacy.close();

	const store = new AnalyticsStore(root);
	t.onTestFinished(() => store.close().catch(() => undefined));
	const before = await store.getSnapshot({ fromMs: 0, toMs: 10 });
	assert.equal(before.overview.responseCycles, 1);
	assert.equal(before.performance[0]?.calls, 1);
	assert.equal(before.performance[0]?.timeToFirstToken.measured, 0);

	await store.recordRun(
		run("fresh", 5, {
			generations: [
				{
					id: "g1",
					ordinal: 0,
					startedAtMs: 5,
					firstTokenAtMs: 6,
					finishedAtMs: 7,
					durationMs: 2,
					outcome: "stop",
					responses: [],
				},
			],
		}),
	);
	const after = await store.getSnapshot({ fromMs: 0, toMs: 10 });
	assert.equal(after.overview.responseCycles, 2);
	assert.ok(after.performance.some((item) => item.timeToFirstToken.measured === 1));
});

test("failed database initialization closes its connection and shutdown remains safe", async (t) => {
	const directory = await mkdtemp(path.join(tmpdir(), "pi-analytics-init-failure-"));
	t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
	const file = path.join(directory, "test.db");
	const incompatible = new DatabaseSync(file);
	try {
		incompatible.exec("CREATE TABLE runs (id TEXT PRIMARY KEY)");
	} finally {
		incompatible.close();
	}
	const close = vi.spyOn(DatabaseSync.prototype, "close");
	try {
		const database = new AnalyticsDatabase(file);
		await assert.rejects(database.readRuns(0, 10), /started_at_ms/);
		assert.equal(close.mock.calls.length, 1);
		await database.close();
		await database.close();
		assert.equal(close.mock.calls.length, 1);
	} finally {
		close.mockRestore();
	}
});

test("time ranges use local Today and rolling windows", () => {
	const now = new Date(2026, 7, 2, 15, 30).getTime();
	assert.equal(resolveTimeRange("today", now).fromMs, new Date(2026, 7, 2).getTime());
	assert.equal(resolveTimeRange("7d", now).fromMs, now - 7 * 24 * 60 * 60 * 1_000);
	assert.equal(resolveTimeRange("30d", now).fromMs, now - 30 * 24 * 60 * 60 * 1_000);
	assert.equal(resolveTimeRange("all", now).fromMs, 0);
	assert.equal(resolveTimeRange("all", now).toMs, now + 1);
});

function session(
	id: string,
	startedAtMs: number,
	options: Partial<SessionRecord> = {},
): SessionRecord {
	return {
		id,
		project: "demo",
		startedAtMs,
		endedAtMs: startedAtMs + 60_000,
		llmCalls: 1,
		usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
		...options,
	};
}

test("store round-trips sessions and derives activity days and streaks", async (t) => {
	const store = await fixture(t);
	const day = (date: number, hour = 12) => new Date(2026, 7, date, hour).getTime();
	await store.recordSessions([
		session("s1", day(1), { project: "alpha", llmCalls: 3 }),
		session("s2", day(1, 15), { project: "alpha", llmCalls: 2 }),
		session("s3", day(2), { project: "beta", llmCalls: 1 }),
		session("s4", day(3), { project: "alpha", llmCalls: 4 }),
		// A gap on the 4th splits the streak.
		session("s5", day(6), { project: "beta", llmCalls: 1, endedAtMs: day(6) + 3_600_000 }),
	]);

	const snapshot = await store.getSnapshot({ fromMs: day(1) - 1, toMs: day(6) + 7_200_000 });
	const stats = snapshot.sessions;
	assert.equal(stats.count, 5);
	assert.equal(stats.llmCalls, 11);
	assert.equal(stats.activeDays, 4);
	assert.equal(stats.longestStreak, 3);
	assert.equal(stats.currentStreak, 1);
	assert.equal(stats.longestDurationMs, 3_600_000);
	assert.deepEqual(
		stats.days.map(({ date, sessions }) => ({ date, sessions })),
		[
			{ date: "2026-08-01", sessions: 2 },
			{ date: "2026-08-02", sessions: 1 },
			{ date: "2026-08-03", sessions: 1 },
			{ date: "2026-08-06", sessions: 1 },
		],
	);
	assert.deepEqual(
		stats.projects.map(({ project, sessions }) => ({ project, sessions })),
		[
			{ project: "alpha", sessions: 3 },
			{ project: "beta", sessions: 2 },
		],
	);
});

test("re-importing a session replaces it instead of duplicating", async (t) => {
	const store = await fixture(t);
	const started = new Date(2026, 7, 10, 9).getTime();
	await store.recordSessions([session("s1", started, { llmCalls: 1 })]);
	await store.recordSessions([session("s1", started, { llmCalls: 9, project: "renamed" })]);

	const snapshot = await store.getSnapshot({ fromMs: started - 1, toMs: started + 1_000 });
	assert.equal(snapshot.sessions.count, 1);
	assert.equal(snapshot.sessions.llmCalls, 9);
	assert.deepEqual(
		snapshot.sessions.projects.map(({ project }) => project),
		["renamed"],
	);
});

test("clearing analytics also removes imported sessions", async (t) => {
	const store = await fixture(t);
	const started = new Date(2026, 7, 11, 9).getTime();
	await store.recordSessions([session("s1", started)]);
	await store.clearAll();

	const snapshot = await store.getSnapshot({ fromMs: started - 1, toMs: started + 1_000 });
	assert.equal(snapshot.sessions.count, 0);
	assert.equal(snapshot.sessions.activeDays, 0);
	assert.equal(snapshot.sessions.longestStreak, 0);
});
