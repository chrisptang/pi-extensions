import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { AgentRegistry } from "../src/agent-registry.js";
import { createPanelComponent, renderPanel } from "../src/panel.js";
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
	) => Promise<{ details: Record<string, unknown> }>;
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

test("panel lists active and terminal jobs with the selected job's activity", () => {
	const jobs: PanelJob[] = [
		{
			jobId: "job_a",
			agent: "explorer",
			description: "review auth middleware",
			state: "running",
			createdAt: 0,
			startedAt: 0,
			elapsedMs: 42_000,
			timeout: 120,
			maxTurns: 100,
			turns: 7,
			tools: ["read", "grep"],
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
			error: "Subagent execution was cancelled by the user.",
			limitations: [],
			droppedEvents: 0,
			activity: [],
		},
	];
	const lines = renderPanel(jobs, "job_a", identityTheme(), 120);
	assert.match(lines[0] ?? "", /Subagents · 1 active · 2 retained/u);
	// The selected job carries the cursor; the other does not.
	assert.match(lines[1] ?? "", /^❯ ▶ explorer/u);
	assert.match(lines[1] ?? "", /review auth middleware\s+running\s+42s/u);
	assert.match(lines[2] ?? "", /^ {2}✗ builder/u);
	assert.match(lines[2] ?? "", /cancelled\s+1m2s/u);
	// The detail heading names the job and what it was allowed to do.
	assert.match(
		lines[3] ?? "",
		/explorer · job_a · tools: read,grep · 120s timeout · 7\/100 turns/u,
	);
	assert.match(lines[4] ?? "", /12:04:31 read\s+✓ src\/auth\/mw\.ts → 80 lines/u);
	assert.match(lines[5] ?? "", /12:04:35 say\s+The middleware verifies exp before refresh\./u);
	assert.match(lines.at(-1) ?? "", /↑↓ select\s+k terminate\s+esc close/u);
});

test("panel reports a terminal selection as not terminable", () => {
	const lines = renderPanel(
		[
			{
				jobId: "job_b",
				state: "completed",
				createdAt: 0,
				elapsedMs: 1_000,
				turns: 0,
				tools: [],
				limitations: [],
				droppedEvents: 0,
				activity: [],
			},
		],
		"job_b",
		identityTheme(),
		80,
	);
	assert.match(lines.at(-1) ?? "", /k terminate \(inactive\)/u);
	assert.ok(lines.some((line) => line.includes("No activity recorded.")));
});

test("panel reports dropped events and a job's own limitations", () => {
	const lines = renderPanel(
		[
			{
				jobId: "job_a",
				state: "running",
				createdAt: 0,
				elapsedMs: 0,
				turns: 0,
				tools: ["read"],
				limitations: ["Agent model was unavailable; inherited the main model."],
				droppedEvents: 37,
				activity: [{ seq: 38, at: at(1, 2, 3), kind: "notice", detail: "Job started." }],
			},
		],
		"job_a",
		identityTheme(),
		100,
	);
	assert.ok(lines.some((line) => line.includes("… 37 earlier event(s) dropped")));
	assert.ok(
		lines.some((line) =>
			line.includes("note: Agent model was unavailable; inherited the main model."),
		),
	);
});

test("panel renders an empty session without a detail section", () => {
	const lines = renderPanel([], undefined, identityTheme(), 60);
	assert.ok(lines.some((line) => line.includes("No subagent jobs in this session.")));
	assert.match(lines.at(-1) ?? "", /k terminate \(inactive\)/u);
});

test("every panel line stays within the render width", () => {
	const lines = renderPanel(
		[
			{
				jobId: "job_a",
				agent: "a".repeat(40),
				description: "d".repeat(90),
				state: "running",
				createdAt: 0,
				elapsedMs: 0,
				turns: 0,
				tools: ["read", "grep", "find", "ls", "bash"],
				limitations: [],
				droppedEvents: 0,
				activity: [{ seq: 1, at: at(1, 2, 3), kind: "output", detail: "x".repeat(400) }],
			},
		],
		"job_a",
		identityTheme(),
		48,
	);
	// The bound is on rendered columns, not code units: the panel's own glyphs are
	// multi-byte and a long detail line is truncated to fit the overlay.
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= 48, `line too wide: ${visibleWidth(line)}`);
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
	const tui = { requestRender: () => renders++ };
	let renders = 0;
	const component = createPanelComponent(runtimeOf(mock), tui, identityTheme(), () => undefined);
	try {
		// The first render lands on the oldest active job.
		assert.match(component.render(100)[1] ?? "", /^❯ /u);
		assert.ok(component.render(100).some((line) => line.includes(String(first.details.jobId))));
		component.handleInput("\u001b[B");
		assert.ok(component.render(100).some((line) => line.includes(String(second.details.jobId))));
		assert.ok(renders > 0, "expected the selection change to request a render");
		// Moving past the end stays on the last job rather than wrapping or crashing.
		component.handleInput("\u001b[B");
		component.handleInput("\u001b[B");
		assert.ok(component.render(100).some((line) => line.includes(String(second.details.jobId))));
	} finally {
		component.dispose();
	}
});

test("escape closes the panel and k reports the job to terminate", async () => {
	const { mock, context } = await setup({ runChild: neverSettles });
	const spawned = await spawnJob(mock, context, "alpha");
	await Promise.resolve();
	const runtime = runtimeOf(mock);

	const closed: Array<{ kill?: string }> = [];
	const closing = createPanelComponent(runtime, noopTui(), identityTheme(), (result) =>
		closed.push(result),
	);
	closing.render(100);
	closing.handleInput("\u001b");
	assert.deepEqual(closed, [{}]);
	// A closed panel ignores further input rather than reporting twice.
	closing.handleInput("k");
	assert.equal(closed.length, 1);

	const killed: Array<{ kill?: string }> = [];
	const killing = createPanelComponent(runtime, noopTui(), identityTheme(), (result) =>
		killed.push(result),
	);
	killing.render(100);
	killing.handleInput("k");
	assert.deepEqual(killed, [{ kill: String(spawned.details.jobId) }]);
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
	const component = createPanelComponent(runtimeOf(mock), noopTui(), identityTheme(), (result) =>
		results.push(result),
	);
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
	const component = createPanelComponent(
		runtime,
		{ requestRender: () => renders++ },
		identityTheme(),
		() => undefined,
	);
	component.render(100);

	// A shutdown while the overlay is open never calls dispose, so the panel has
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

function noopTui() {
	return { requestRender: () => undefined };
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
	return { fg: (_role: string, text: string) => text } as Theme;
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
