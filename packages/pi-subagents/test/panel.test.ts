import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { AgentRegistry } from "../src/agent-registry.js";
import { createPanelComponent, renderDetailView, renderListView } from "../src/panel.js";
import type { PanelJob, SubagentRuntime } from "../src/runtime.js";
import { SkillRegistry } from "../src/skill-registry.js";
import subagents, { type SubagentsDependencies } from "../src/subagents.js";
import type { ChildActivity, ChildRequest, ChildResult } from "../src/types.js";

type Mock = ReturnType<typeof createMockPi>;
type Context = ReturnType<typeof createMockContext>;

interface RegisteredTool {
	name: string;
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: ((value: unknown) => void) | undefined,
		ctx: unknown,
	) => Promise<{
		content: Array<{ type: string; text: string }>;
		details: Record<string, unknown>;
		usage?: {
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			totalTokens: number;
			cost: { total: number };
		};
	}>;
}

const activeSessions: Array<{ mock: Mock; context: Context }> = [];

afterEach(async () => {
	for (const session of activeSessions.splice(0)) {
		await emit(session.mock, "session_shutdown", { reason: "quit" }, session.context.ctx);
	}
	vi.restoreAllMocks();
});

test("registers /subagents alongside the existing commands", async () => {
	const { mock } = await setup();
	const command = mock.commands.get("subagents");
	assert.ok(command);
	assert.equal(command?.description, "Inspect running subagent jobs and terminate one");
});

test("list view frames every retained job and marks the selection", () => {
	const lines = renderListView(sampleJobs(), "job_a", identityTheme(), 100, 10);
	assert.match(lines[0] ?? "", /^╭─ Subagents · 1 active · 2 total ─+╮$/u);
	// The selected job carries the cursor and the other does not; both keep
	// their description, state, and elapsed time.
	assert.match(lines[1] ?? "", /^│ ❯ ▶ explorer {2}review auth middleware\s+running\s+42s │$/u);
	assert.match(lines[2] ?? "", /^│ {3}✗ builder {3}add cooldown tests\s+cancelled\s+1m2s │$/u);
	// The key hints live in the bottom border rather than costing a content row.
	assert.equal(lines.length, 4);
	assert.match(lines.at(-1) ?? "", /^╰─ ↑↓ select {2}⏎ open {2}k terminate {2}esc close ─+╯$/u);
});

test("list view keeps the selection visible and counts the jobs outside the window", () => {
	const jobs: PanelJob[] = Array.from({ length: 12 }, (_, index) => ({
		jobId: `job_${index}`,
		agent: "explorer",
		description: `task ${index}`,
		state: index === 11 ? "running" : "completed",
		createdAt: index,
		elapsedMs: 0,
		turns: 0,
		tools: [],
		model: "anthropic/model-x",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
		limitations: [],
		droppedEvents: 0,
		activity: [],
	}));
	const theme = identityTheme();
	// Selecting the last job used to let the `… more` marker overwrite its row.
	const last = renderListView(jobs, "job_11", theme, 60, 6);
	assert.equal(last.length, 8);
	assert.match(last[1] ?? "", /^│ … 7 above/u);
	assert.match(last[6] ?? "", /^│ ❯ ▶ explorer {2}task 11 /u);
	const first = renderListView(jobs, "job_0", theme, 60, 6);
	assert.match(first[1] ?? "", /^│ ❯ ✓ explorer {2}task 0 /u);
	assert.match(first[6] ?? "", /^│ … 7 below/u);
	// A selection in the middle gives up one row to each marker and keeps its height.
	const middle = renderListView(jobs, "job_6", theme, 60, 6);
	assert.equal(middle.length, 8);
	assert.match(middle[1] ?? "", /^│ … \d+ above/u);
	assert.ok(middle.some((line) => /^│ ❯ ✓ explorer {2}task 6 /u.test(line)));
	assert.match(middle[6] ?? "", /^│ … \d+ below/u);
});

test("detail view shows the job's budget, meta line, and activity", () => {
	const job = sampleJobs()[0] as PanelJob;
	const lines = renderDetailView(job, identityTheme(), 100, 10, undefined);
	assert.match(lines[0] ?? "", /^╭─ explorer · running · 42s · 7\/100 turns ─+╮$/u);
	// The description leads the meta line and the id follows it; what the job
	// costs to run sits on its own line under it.
	assert.match(lines[1] ?? "", /^│ review auth middleware {2}job_a\s+│$/u);
	assert.match(
		lines[2] ?? "",
		/^│ anthropic\/model-x · ctx 49k\/1\.0m 4\.9% · cache 90\.2% · in 41k · out 6\.6k · \$0\.029\s+│$/u,
	);
	assert.match(lines[4] ?? "", /^│ 12:04:31 read {3}✓ src\/auth\/mw\.ts → 80 lines/u);
	assert.match(lines[5] ?? "", /^│ 12:04:35 say {6}The middleware verifies exp before refresh\./u);
	assert.match(
		lines.at(-1) ?? "",
		/^╰─ ↑↓ scroll {2}PgUp\/PgDn page {2}←→ job {2}k terminate {2}esc back ─+╯$/u,
	);
});

test("detail view keeps the tool column aligned across tool-name lengths", () => {
	const job: PanelJob = {
		...(sampleJobs()[0] as PanelJob),
		activity: [
			{ seq: 1, at: at(1, 0, 0), kind: "tool", tool: "read", detail: "a.ts", outcome: "ok" },
			{ seq: 2, at: at(1, 0, 1), kind: "tool", tool: "write", detail: "b.ts", outcome: "error" },
			{ seq: 3, at: at(1, 0, 2), kind: "tool", tool: "list_directory", detail: "src" },
			{ seq: 4, at: at(1, 0, 3), kind: "output", detail: "done" },
		],
	};
	const lines = renderDetailView(job, identityTheme(), 80, 10, undefined);
	// Clock, a six-column label, a two-column outcome mark, then the detail.
	assert.match(lines[4] ?? "", /^│ 01:00:00 read {3}✓ a\.ts/u);
	assert.match(lines[5] ?? "", /^│ 01:00:01 write {2}✗ b\.ts/u);
	// Truncating the name adds pi-tui's own style resets around the ellipsis.
	assert.match((lines[6] ?? "").split("\u001b[0m").join(""), /^│ 01:00:02 list_… … src/u);
	assert.match(lines[7] ?? "", /^│ 01:00:03 say {6}done/u);
});

test("detail view follows the newest event and scrolls to an explicit offset", () => {
	const job: PanelJob = {
		...(sampleJobs()[0] as PanelJob),
		activity: Array.from({ length: 30 }, (_, index) => ({
			seq: index + 1,
			at: at(1, 0, index),
			kind: "output" as const,
			detail: `line ${index + 1}`,
		})),
	};
	// 10 body rows leave 7 for the log: the meta lines and the rule take the rest.
	const tail = renderDetailView(job, identityTheme(), 80, 10, undefined);
	assert.equal(tail.length, 12);
	assert.ok(tail.some((line) => line.includes("line 30")));
	assert.ok(!tail.some((line) => line.includes("line 23 ")));
	// The scroll position sits at the right end of the bottom border.
	assert.match(tail.at(-1) ?? "", /─ 24–30\/30 ─╯$/u);
	const head = renderDetailView(job, identityTheme(), 80, 10, 0);
	assert.ok(head.some((line) => line.includes("line 1 ")));
	assert.ok(!head.some((line) => line.includes("line 8 ")));
	assert.match(head.at(-1) ?? "", /─ 1–7\/30 ─╯$/u);
});

test("panel reports a terminal selection as not terminable", () => {
	const job: PanelJob = {
		jobId: "job_b",
		state: "completed",
		createdAt: 0,
		elapsedMs: 1_000,
		turns: 0,
		tools: [],
		model: "anthropic/model-x",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
		limitations: [],
		droppedEvents: 0,
		activity: [],
	};
	assert.match(
		renderListView([job], "job_b", identityTheme(), 80, 10).at(-1) ?? "",
		/k terminate \(inactive\)/u,
	);
	const detail = renderDetailView(job, identityTheme(), 80, 10, undefined);
	assert.match(detail.at(-1) ?? "", /k terminate \(inactive\)/u);
	assert.ok(detail.some((line) => line.includes("No activity recorded.")));
});

test("detail view reports dropped events and a job's own limitations", () => {
	const lines = renderDetailView(
		{
			jobId: "job_a",
			state: "running",
			createdAt: 0,
			elapsedMs: 0,
			turns: 0,
			tools: ["read"],
			model: "anthropic/model-x",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
			limitations: ["Agent model was unavailable; inherited the main model."],
			droppedEvents: 37,
			activity: [{ seq: 38, at: at(1, 2, 3), kind: "notice", detail: "Job started." }],
		},
		identityTheme(),
		100,
		10,
		undefined,
	);
	// The limitation is a fact about the job, so it sits above the rule with the
	// meta line rather than being appended to the chronological log.
	assert.match(lines[3] ?? "", /^│ note: Agent model was unavailable; inherited the main model\./u);
	assert.match(lines[4] ?? "", /^│ ─+ │$/u);
	assert.match(lines[5] ?? "", /^│ … 37 earlier event\(s\) dropped/u);
});

test("list view renders an empty session", () => {
	const lines = renderListView([], undefined, identityTheme(), 60, 10);
	assert.ok(lines.some((line) => line.includes("No subagent jobs in this session.")));
	assert.match(lines.at(-1) ?? "", /k terminate \(inactive\)/u);
});

test("every panel line stays within the render width", () => {
	const job: PanelJob = {
		jobId: "job_a",
		agent: "a".repeat(40),
		description: "d".repeat(90),
		state: "running",
		createdAt: 0,
		elapsedMs: 0,
		turns: 0,
		tools: ["read", "grep", "find", "ls", "bash"],
		model: "anthropic/model-x",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
		limitations: [],
		droppedEvents: 0,
		activity: [{ seq: 1, at: at(1, 2, 3), kind: "output", detail: "x".repeat(400) }],
	};
	// The bound is on rendered columns, not code units: the panel's own glyphs are
	// multi-byte and a long detail line is truncated to fit the panel.
	for (const lines of [
		renderListView([job], "job_a", identityTheme(), 48, 10),
		renderDetailView(job, identityTheme(), 48, 10, undefined),
	]) {
		for (const line of lines) {
			assert.equal(visibleWidth(line), 48, `line width ${visibleWidth(line)}: ${line}`);
		}
	}
});

test("a job's activity records the child's tool calls, results, and visible output", async () => {
	let report: ((activity: ChildActivity) => void) | undefined;
	let release: (() => void) | undefined;
	const runChild = async (request: ChildRequest): Promise<ChildResult> => {
		report = request.onActivity;
		await new Promise<void>((resolve) => {
			release = resolve;
		});
		return { state: "completed", result: "done", limitations: [], truncated: false };
	};
	const { mock, context } = await setup({ runChild });
	const spawned = await spawnJob(mock, context);
	const jobId = String(spawned.details.jobId);
	await Promise.resolve();
	assert.ok(report, "expected the runtime to pass an activity observer");
	report?.({ type: "tool_start", toolCallId: "c1", tool: "read", args: { path: "src/a.ts" } });
	report?.({
		type: "tool_end",
		toolCallId: "c1",
		tool: "read",
		result: { content: [{ type: "text", text: "40 lines" }] },
		isError: false,
	});
	report?.({ type: "output", text: "Read the file." });
	const runtime = runtimeOf(mock);
	const job = runtime.panelJobs().find((candidate) => candidate.jobId === jobId);
	assert.deepEqual(
		job?.activity.map((event) => ({ kind: event.kind, tool: event.tool, detail: event.detail })),
		[
			{ kind: "tool", tool: "read", detail: "src/a.ts" },
			{ kind: "output", tool: undefined, detail: "Read the file." },
		],
	);
	assert.equal(job?.activity[0]?.result, "40 lines");
	// The widget surfaces only the newest line.
	assert.equal(runtime.activeJobsForDisplay()[0]?.latestActivity, "Read the file.");
	release?.();
});

test("a job records what its child spends and the panel reports it", async () => {
	let report: ((activity: ChildActivity) => void) | undefined;
	let release: (() => void) | undefined;
	const runChild = async (request: ChildRequest): Promise<ChildResult> => {
		report = request.onActivity;
		await new Promise<void>((resolve) => {
			release = resolve;
		});
		return { state: "completed", result: "done", limitations: [], truncated: false };
	};
	const { mock, context } = await setup({ runChild });
	const spawned = await spawnJob(mock, context);
	const jobId = String(spawned.details.jobId);
	await Promise.resolve();
	assert.ok(report, "expected the runtime to pass an activity observer");
	report?.({
		type: "usage",
		usage: {
			input: 100,
			output: 20,
			cacheRead: 0,
			cacheWrite: 900,
			contextTokens: 1_020,
			cost: 0.01,
		},
	});
	report?.({
		type: "usage",
		usage: {
			input: 30,
			output: 10,
			cacheRead: 1_000,
			cacheWrite: 0,
			contextTokens: 1_060,
			cost: 0.002,
		},
	});
	const job = runtimeOf(mock)
		.panelJobs()
		.find((candidate) => candidate.jobId === jobId);
	// Tokens and cost accumulate; context size is the latest reading, not a sum.
	assert.deepEqual(job?.usage, {
		input: 130,
		output: 30,
		cacheRead: 1_000,
		cacheWrite: 900,
		cost: 0.012,
		contextTokens: 1_060,
	});
	// The child's model and its window come from the parent, which resolved both
	// before the spawn; the child only reports how many tokens it sent.
	assert.equal(job?.model, "test-provider/test-model");
	assert.equal(job?.contextWindow, 200_000);
	const detail = renderDetailView(job as PanelJob, identityTheme(), 100, 10, undefined);
	assert.match(
		detail[2] ?? "",
		/^│ test-provider\/test-model · ctx 1\.1k\/200k 0\.5% · cache 49\.3% · in 2\.0k · out 30 · \$0\.012/u,
	);
	release?.();
});

test("subagent tool results report each child response's usage exactly once", async () => {
	let report: ((activity: ChildActivity) => void) | undefined;
	let release: (() => void) | undefined;
	const runChild = async (request: ChildRequest): Promise<ChildResult> => {
		report = request.onActivity;
		await new Promise<void>((resolve) => {
			release = resolve;
		});
		return { state: "completed", result: "done", limitations: [], truncated: false };
	};
	const { mock, context } = await setup({ runChild });
	const spawned = await spawnJob(mock, context);
	const jobId = String(spawned.details.jobId);
	// Nothing was spent yet, so the spawn result reports no usage at all.
	assert.equal(spawned.usage, undefined);
	await Promise.resolve();
	const spend = (input: number, output: number, cacheRead: number, cost: number) =>
		report?.({ type: "usage", usage: { input, output, cacheRead, cacheWrite: 0, cost } });

	spend(100, 20, 300, 0.01);
	const tail = await tool(mock, "subagent_tail").execute(
		"tail",
		{ jobId },
		undefined,
		undefined,
		context.ctx,
	);
	assert.deepEqual(tail.usage, {
		input: 100,
		output: 20,
		cacheRead: 300,
		cacheWrite: 0,
		totalTokens: 420,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
	});
	// Usage stays out of the model-visible text.
	assert.doesNotMatch(tail.content[0]?.text ?? "", /cost|cacheRead/u);

	spend(10, 5, 0, 0.002);
	release?.();
	const waited = await tool(mock, "subagent_wait").execute(
		"wait",
		{ jobId },
		undefined,
		undefined,
		context.ctx,
	);
	// Only the spend after the tail, not the running total.
	assert.equal(waited.usage?.input, 10);
	assert.equal(waited.usage?.output, 5);
	assert.equal(waited.usage?.cost.total, 0.002);

	const again = await tool(mock, "subagent_wait").execute(
		"wait-again",
		{ jobId },
		undefined,
		undefined,
		context.ctx,
	);
	assert.equal(again.usage, undefined);
});

test("a background completion shows its spend without telling the model", async () => {
	let report: ((activity: ChildActivity) => void) | undefined;
	let release: (() => void) | undefined;
	let now = 1_000;
	vi.spyOn(Date, "now").mockImplementation(() => now);
	const runChild = async (request: ChildRequest): Promise<ChildResult> => {
		report = request.onActivity;
		await new Promise<void>((resolve) => {
			release = resolve;
		});
		return { state: "completed", result: "done", limitations: [], truncated: false };
	};
	const { mock, context } = await setup({ runChild });
	await tool(mock, "subagent_spawn").execute(
		"spawn",
		{ task: "background work", description: "test job", background: true },
		undefined,
		undefined,
		context.ctx,
	);
	await Promise.resolve();
	report?.({ type: "turn", turns: 5 });
	report?.({
		type: "usage",
		usage: { input: 1_000, output: 1_100, cacheRead: 61_000, cacheWrite: 0, cost: 0.042 },
	});
	now = 49_000;
	release?.();
	await vi.waitFor(() => {
		assert.ok(mock.sentMessages.length > 0);
	});
	const message = mock.sentMessages[0]?.message as {
		customType: string;
		content: string;
		display: boolean;
		details: Record<string, unknown>;
	};
	assert.equal(message.customType, "pi-subagents-completion");
	assert.doesNotMatch(message.content, /usage|cost|elapsedMs|turns/u);
	assert.deepEqual(message.details.usage, {
		input: 1_000,
		output: 1_100,
		cacheRead: 61_000,
		cacheWrite: 0,
		cost: 0.042,
	});
	assert.equal(message.details.turns, 5);
	assert.equal(message.details.elapsedMs, 48_000);
	// The model is part of the result, so the main agent and the renderer both see it.
	assert.match(message.content, /"model":"test-provider\/test-model"/u);

	const renderer = mock.messageRenderers.get("pi-subagents-completion");
	assert.ok(renderer);
	const render = (details: unknown, width: number) =>
		(
			renderer({ ...message, details }, { expanded: false, outputPad: 1 }, identityTheme()) as {
				render(width: number): string[];
			}
		).render(width);
	assert.match(
		render(message.details, 200).join("\n"),
		/Subagent job completion · test-provider\/test-model · completed · 48s · 5 turns · cache 98\.4% · in 62k · out 1\.1k · \$0\.042 \(/u,
	);
	for (const line of render(message.details, 20)) assert.ok(visibleWidth(line) <= 20);
	// A completion recorded before usage was reported keeps the plain label.
	assert.match(render({ result: "done" }, 200).join("\n"), /Subagent job completion \(/u);
});

test("the cost line degrades when the model's window or usage is unknown", () => {
	const job = sampleJobs()[1] as PanelJob;
	const lines = renderDetailView(job, identityTheme(), 100, 10, undefined);
	// No response has reported usage yet, so context and cache rate are unknown
	// rather than zero.
	assert.match(
		lines[2] ?? "",
		/^│ anthropic\/model-x · ctx — · cache — · in 0 · out 0 · \$0\.000/u,
	);
	const unmeasured = renderDetailView(
		{ ...job, contextWindow: undefined, usage: { ...job.usage, contextTokens: 8_000 } },
		identityTheme(),
		100,
		10,
		undefined,
	);
	// An unregistered model has no window to measure against, so the panel shows
	// the context size alone instead of an invented percentage.
	assert.match(unmeasured[2] ?? "", /^│ anthropic\/model-x · ctx 8\.0k · cache —/u);
});

test("an observer that throws cannot disturb the job", async () => {
	let report: ((activity: ChildActivity) => void) | undefined;
	const runChild = async (request: ChildRequest): Promise<ChildResult> => {
		report = request.onActivity;
		return { state: "completed", result: "done", limitations: [], truncated: false };
	};
	const { mock, context } = await setup({ runChild });
	const spawned = await spawnJob(mock, context);
	const waited = await tool(mock, "subagent_wait").execute(
		"wait",
		{ jobId: spawned.details.jobId },
		undefined,
		undefined,
		context.ctx,
	);
	assert.equal(waited.details.state, "completed");
	// A late report against a terminal job is ignored rather than recorded.
	report?.({ type: "output", text: "after the end" });
	const job = runtimeOf(mock)
		.panelJobs()
		.find((candidate) => candidate.jobId === spawned.details.jobId);
	assert.ok(!job?.activity.some((event) => event.detail === "after the end"));
});

test("a user cancellation is reported differently from the model's own", async () => {
	const runChild = (request: ChildRequest): Promise<ChildResult> =>
		new Promise((resolve) => {
			request.signal.addEventListener("abort", () =>
				resolve({
					state: "cancelled",
					error: "Subagent execution was cancelled.",
					limitations: [],
					truncated: false,
				}),
			);
		});
	const { mock, context } = await setup({ runChild });
	const runtime = runtimeOf(mock);

	const byUser = await spawnJob(mock, context);
	await Promise.resolve();
	await runtime.cancel(String(byUser.details.jobId), "user");
	const userJob = runtime.panelJobs().find((job) => job.jobId === byUser.details.jobId);
	assert.equal(userJob?.state, "cancelled");
	assert.equal(userJob?.error, "Subagent execution was cancelled by the user.");
	// The record says who stopped it, so the panel can report that after the fact.
	assert.ok(
		userJob?.activity.some(
			(event) =>
				event.kind === "notice" && event.detail === "Subagent execution was cancelled by the user.",
		),
	);

	const byModel = await spawnJob(mock, context);
	await Promise.resolve();
	await tool(mock, "subagent_cancel").execute(
		"cancel",
		{ jobId: byModel.details.jobId },
		undefined,
		undefined,
		context.ctx,
	);
	const modelJob = runtime.panelJobs().find((job) => job.jobId === byModel.details.jobId);
	assert.equal(modelJob?.error, "Subagent execution was cancelled.");
});

test("cancelling one job leaves its siblings running", async () => {
	const started = new Set<string>();
	const runChild = (request: ChildRequest): Promise<ChildResult> => {
		started.add(request.task);
		return new Promise((resolve) => {
			request.signal.addEventListener("abort", () =>
				resolve({
					state: "cancelled",
					error: "Subagent execution was cancelled.",
					limitations: [],
					truncated: false,
				}),
			);
		});
	};
	const { mock, context } = await setup({ runChild });
	const first = await spawnJob(mock, context, "alpha");
	const second = await spawnJob(mock, context, "beta");
	const third = await spawnJob(mock, context, "gamma");
	await Promise.resolve();
	assert.deepEqual([...started].sort(), ["alpha", "beta", "gamma"]);

	const runtime = runtimeOf(mock);
	await runtime.cancel(String(second.details.jobId), "user");
	const states = new Map(runtime.panelJobs().map((job) => [job.jobId, job.state]));
	assert.equal(states.get(String(first.details.jobId)), "running");
	assert.equal(states.get(String(second.details.jobId)), "cancelled");
	assert.equal(states.get(String(third.details.jobId)), "running");
});

test("terminal jobs stay listed in the panel so a stopped child can be reviewed", async () => {
	const runChild = async (): Promise<ChildResult> => ({
		state: "completed",
		result: "done",
		limitations: [],
		truncated: false,
	});
	const { mock, context } = await setup({ runChild });
	const spawned = await spawnJob(mock, context);
	await tool(mock, "subagent_wait").execute(
		"wait",
		{ jobId: spawned.details.jobId },
		undefined,
		undefined,
		context.ctx,
	);
	const runtime = runtimeOf(mock);
	// The active-jobs widget drops it, but the panel keeps it for review.
	assert.equal(runtime.activeJobsForDisplay().length, 0);
	const job = runtime.panelJobs().find((candidate) => candidate.jobId === spawned.details.jobId);
	assert.equal(job?.state, "completed");
	assert.ok(job?.activity.some((event) => event.detail === "Job completed."));
});

test("the panel selects the first active job and moves with the arrow keys", async () => {
	const { mock, context } = await setup({ runChild: neverSettles });
	const first = await spawnJob(mock, context, "alpha");
	const second = await spawnJob(mock, context, "beta");
	await Promise.resolve();
	let renders = 0;
	const component = panel(runtimeOf(mock), () => undefined, { requestRender: () => renders++ });
	try {
		// The first render lands on the oldest active job.
		assert.match(component.render(100)[1] ?? "", /^│ ❯ /u);
		assert.ok(component.render(100)[1]?.includes(String(first.details.jobId)));
		component.handleInput(KEYS.down);
		assert.ok(component.render(100)[2]?.includes(String(second.details.jobId)));
		assert.match(component.render(100)[2] ?? "", /^│ ❯ /u);
		assert.ok(renders > 0, "expected the selection change to request a render");
		// Moving past the end stays on the last job rather than wrapping or crashing.
		component.handleInput(KEYS.down);
		component.handleInput(KEYS.down);
		assert.match(component.render(100)[2] ?? "", /^│ ❯ /u);
	} finally {
		component.dispose();
	}
});

test("keys are recognised under the Kitty keyboard protocol", async () => {
	const { mock, context } = await setup({ runChild: neverSettles });
	await spawnJob(mock, context, "alpha");
	const second = await spawnJob(mock, context, "beta");
	await Promise.resolve();
	const runtime = runtimeOf(mock);

	const closed: Array<{ kill?: string }> = [];
	const moving = panel(runtime, (result) => closed.push(result));
	moving.render(100);
	moving.handleInput(KITTY.down);
	assert.match(moving.render(100)[2] ?? "", /^│ ❯ /u);
	moving.handleInput(KITTY.escape);
	assert.deepEqual(closed, [{}]);

	const killed: Array<{ kill?: string }> = [];
	const killing = panel(runtime, (result) => killed.push(result));
	killing.render(100);
	killing.handleInput(KITTY.down);
	killing.handleInput(KITTY.k);
	assert.deepEqual(killed, [{ kill: String(second.details.jobId) }]);
});

test("escape closes the panel and k reports the job to terminate", async () => {
	const { mock, context } = await setup({ runChild: neverSettles });
	const spawned = await spawnJob(mock, context, "alpha");
	await Promise.resolve();
	const runtime = runtimeOf(mock);

	const closed: Array<{ kill?: string }> = [];
	const closing = panel(runtime, (result) => closed.push(result));
	closing.render(100);
	closing.handleInput(KEYS.escape);
	assert.deepEqual(closed, [{}]);
	// A closed panel ignores further input rather than reporting twice.
	closing.handleInput("k");
	assert.equal(closed.length, 1);

	const killed: Array<{ kill?: string }> = [];
	const killing = panel(runtime, (result) => killed.push(result));
	killing.render(100);
	killing.handleInput("k");
	assert.deepEqual(killed, [{ kill: String(spawned.details.jobId) }]);
});

test("enter opens the detail view, arrows switch jobs there, and escape returns to the list", async () => {
	const { mock, context } = await setup({ runChild: neverSettles });
	const first = await spawnJob(mock, context, "alpha");
	const second = await spawnJob(mock, context, "beta");
	await Promise.resolve();
	const closed: Array<{ kill?: string }> = [];
	const component = panel(runtimeOf(mock), (result) => closed.push(result));
	try {
		component.render(100);
		component.handleInput(KEYS.enter);
		let lines = component.render(100);
		assert.match(lines[0] ?? "", /^╭─ .* · running · /u);
		assert.ok(lines[1]?.includes(String(first.details.jobId)));
		component.handleInput(KEYS.right);
		lines = component.render(100);
		assert.ok(lines[1]?.includes(String(second.details.jobId)));
		// Escape goes back to the list rather than closing the panel outright.
		component.handleInput(KEYS.escape);
		assert.deepEqual(closed, []);
		lines = component.render(100);
		assert.match(lines[0] ?? "", /^╭─ Subagents · 2 active/u);
		assert.match(lines[2] ?? "", /^│ ❯ /u);
		// Ctrl+C closes from anywhere.
		component.handleInput(KEYS.enter);
		component.handleInput("\u0003");
		assert.deepEqual(closed, [{}]);
	} finally {
		component.dispose();
	}
});

test("k does nothing when the selected job is already terminal", async () => {
	const { mock, context } = await setup({
		runChild: async () => ({
			state: "completed" as const,
			result: "done",
			limitations: [],
			truncated: false,
		}),
	});
	const spawned = await spawnJob(mock, context, "alpha");
	await tool(mock, "subagent_wait").execute(
		"wait",
		{ jobId: spawned.details.jobId },
		undefined,
		undefined,
		context.ctx,
	);
	const results: Array<{ kill?: string }> = [];
	const component = panel(runtimeOf(mock), (result) => results.push(result));
	try {
		component.render(100);
		component.handleInput("k");
		assert.deepEqual(results, []);
	} finally {
		component.dispose();
	}
});

test("the panel stops refreshing once its session ends", async () => {
	const { mock, context } = await setup({ runChild: neverSettles });
	await spawnJob(mock, context, "alpha");
	await Promise.resolve();
	const runtime = runtimeOf(mock);
	let renders = 0;
	const component = panel(runtime, () => undefined, { requestRender: () => renders++ });
	component.render(100);

	// A shutdown while the panel is open never calls dispose, so the panel has
	// to notice the session is gone and release its own timer and subscription.
	await emit(mock, "session_shutdown", { reason: "quit" }, context.ctx);
	activeSessions.length = 0;
	assert.equal(runtime.isSessionActive(), false);
	const before = renders;
	runtime.subscribeJobs(() => undefined);
	component.render(100);
	// Disposing afterwards is still safe.
	component.dispose();
	component.dispose();
	assert.equal(renders, before, "expected no render request after the session ended");
});

function at(hours: number, minutes: number, seconds: number): number {
	const date = new Date(2026, 0, 1, hours, minutes, seconds);
	return date.getTime();
}

/** Legacy terminal encodings, which `matchesKey` also accepts. */
const KEYS = {
	down: "\u001b[B",
	right: "\u001b[C",
	enter: "\r",
	escape: "\u001b",
};

/** Kitty keyboard protocol encodings, which the old raw comparisons never matched. */
const KITTY = {
	down: "\u001b[B",
	escape: "\u001b[27u",
	k: "\u001b[107u",
};

function panel(
	runtime: SubagentRuntime,
	done: (result: { kill?: string }) => void,
	tui: { requestRender: () => void } = { requestRender: () => undefined },
) {
	return createPanelComponent(
		runtime,
		{ ...tui, terminal: { rows: 30 } },
		identityTheme(),
		new KeybindingsManager(TUI_KEYBINDINGS),
		done,
	);
}

function sampleJobs(): PanelJob[] {
	return [
		{
			jobId: "job_a",
			agent: "explorer",
			description: "review auth middleware",
			state: "running",
			createdAt: 0,
			startedAt: 0,
			elapsedMs: 42_000,
			maxTurns: 100,
			turns: 7,
			tools: ["read", "grep"],
			model: "anthropic/model-x",
			contextWindow: 1_000_000,
			usage: {
				input: 3_000,
				output: 6_600,
				cacheRead: 37_000,
				cacheWrite: 1_000,
				cost: 0.029,
				contextTokens: 49_000,
			},
			limitations: [],
			droppedEvents: 0,
			activity: [
				{
					seq: 1,
					at: at(12, 4, 31),
					kind: "tool",
					tool: "read",
					detail: "src/auth/mw.ts",
					outcome: "ok",
					result: "80 lines",
				},
				{
					seq: 2,
					at: at(12, 4, 35),
					kind: "output",
					detail: "The middleware verifies exp before refresh.",
				},
			],
		},
		{
			jobId: "job_b",
			agent: "builder",
			description: "add cooldown tests",
			state: "cancelled",
			createdAt: 1,
			startedAt: 1,
			finishedAt: 62_001,
			elapsedMs: 62_000,
			turns: 0,
			tools: ["read", "edit"],
			model: "anthropic/model-x",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
			error: "Subagent execution was cancelled by the user.",
			limitations: [],
			droppedEvents: 0,
			activity: [],
		},
	];
}

const neverSettles = (request: ChildRequest): Promise<ChildResult> =>
	new Promise((resolve) => {
		request.signal.addEventListener("abort", () =>
			resolve({
				state: "cancelled",
				error: "Subagent execution was cancelled.",
				limitations: [],
				truncated: false,
			}),
		);
	});

function identityTheme(): Theme {
	return {
		fg: (_role: string, text: string) => text,
		bg: (_role: string, text: string) => text,
		bold: (text: string) => text,
	} as Theme;
}

function tool(mock: Mock, name: string): RegisteredTool {
	const found = (mock.tools as unknown as RegisteredTool[]).find(
		(candidate) => candidate.name === name,
	);
	assert.ok(found, `expected tool ${name}`);
	return found;
}

function spawnJob(mock: Mock, context: Context, task = "inspect the panel") {
	return tool(mock, "subagent_spawn").execute(
		"spawn",
		{ task, description: "test job" },
		undefined,
		undefined,
		context.ctx,
	);
}

function runtimeOf(mock: Mock): SubagentRuntime {
	const runtime = registeredRuntimes.get(mock);
	assert.ok(runtime, "expected a runtime for this session");
	return runtime;
}

const registeredRuntimes = new WeakMap<Mock, SubagentRuntime>();

async function setup(dependencies: SubagentsDependencies = {}) {
	const mock = createMockPi();
	const context = createMockContext({
		model: { provider: "test-provider", id: "test-model" },
		modelRegistry: {
			getProviderAuthStatus: () => ({ configured: true, source: "environment" as const }),
			getRegisteredProviderIds: () => [],
			find: () => ({ contextWindow: 200_000 }),
		},
	});
	subagents(mock.pi, {
		seedAgents: () => undefined,
		agents: emptyAgentRegistry(),
		skills: emptySkillRegistry(),
		...dependencies,
		onRuntime: (runtime) => registeredRuntimes.set(mock, runtime),
	});
	await emit(mock, "session_start", { reason: "startup" }, context.ctx);
	activeSessions.push({ mock, context });
	return { mock, context };
}

async function emit(mock: Mock, event: string, payload: unknown, context: unknown): Promise<void> {
	for (const handler of mock.events.get(event) ?? []) await handler(payload, context);
}

function emptyAgentRegistry(): AgentRegistry {
	const empty = () => ({ agents: new Map(), diagnostics: [] });
	return new AgentRegistry(empty, empty);
}

function emptySkillRegistry(): SkillRegistry {
	const empty = () => ({ skills: new Map(), diagnostics: [] });
	return new SkillRegistry(empty, empty);
}
