import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { AgentRegistry } from "../src/agent-registry.js";
import { emptyOverrides } from "../src/instruction-overrides.js";
import type { SubagentRuntime } from "../src/runtime.js";
import { SkillRegistry } from "../src/skill-registry.js";
import subagents, { type SubagentsDependencies } from "../src/subagents.js";
import type { ChildRequest, ChildResult } from "../src/types.js";

/**
 * Evidence that independent jobs run concurrently rather than one after another.
 *
 * `subagent_spawn` returns a job id without awaiting its child, and the runtime
 * starts each child on its own detached process, so a batch of spawns overlaps.
 * These tests pin that down: a regression that serialized the children would
 * still return the same ids, and only the observed overlap distinguishes the two.
 */

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

test("spawning three jobs runs three children at the same time", async () => {
	let inFlight = 0;
	let peak = 0;
	const release: Array<() => void> = [];
	const runChild = (request: ChildRequest): Promise<ChildResult> => {
		inFlight++;
		peak = Math.max(peak, inFlight);
		return new Promise<ChildResult>((resolve) => {
			release.push(() => {
				inFlight--;
				resolve({
					state: "completed",
					result: `done ${request.task}`,
					limitations: [],
					truncated: false,
				});
			});
		});
	};
	const { mock, context } = await setup({ runChild });
	const spawned = [];
	for (const task of ["alpha", "beta", "gamma"]) {
		spawned.push(await spawnJob(mock, context, task));
	}
	// Every child launched before any of them was allowed to finish.
	await Promise.resolve();
	assert.equal(peak, 3, `expected 3 children in flight, saw ${peak}`);
	assert.equal(release.length, 3);

	const runtime = runtimeOf(mock);
	assert.deepEqual(
		runtime.activeJobsForDisplay().map((job) => job.state),
		["running", "running", "running"],
	);

	for (const finish of release) finish();
	const results = await Promise.all(
		spawned.map((job) =>
			tool(mock, "subagent_wait").execute(
				"wait",
				{ jobId: job.details.jobId },
				undefined,
				undefined,
				context.ctx,
			),
		),
	);
	assert.deepEqual(
		results.map((result) => result.details.state),
		["completed", "completed", "completed"],
	);
	// Each child received its own task, so the results are not one job's repeated.
	assert.deepEqual(results.map((result) => result.details.result).sort(), [
		"done alpha",
		"done beta",
		"done gamma",
	]);
});

test("spawn returns without waiting for its child to finish", async () => {
	let released: (() => void) | undefined;
	const runChild = (): Promise<ChildResult> =>
		new Promise((resolve) => {
			released = () =>
				resolve({ state: "completed", result: "done", limitations: [], truncated: false });
		});
	const { mock, context } = await setup({ runChild });
	const spawned = await spawnJob(mock, context, "long running");
	// The tool call has already returned while the child is still blocked.
	assert.equal(spawned.details.state, "queued");
	await Promise.resolve();
	assert.ok(released, "expected the child to have started");
	assert.equal(runtimeOf(mock).activeJobsForDisplay()[0]?.state, "running");
	released?.();
});

test("a job that finishes early does not hold back its siblings", async () => {
	const finishers = new Map<string, () => void>();
	const runChild = (request: ChildRequest): Promise<ChildResult> =>
		new Promise((resolve) => {
			finishers.set(request.task, () =>
				resolve({
					state: "completed",
					result: `done ${request.task}`,
					limitations: [],
					truncated: false,
				}),
			);
		});
	const { mock, context } = await setup({ runChild });
	const slow = await spawnJob(mock, context, "slow");
	const fast = await spawnJob(mock, context, "fast");
	await Promise.resolve();

	finishers.get("fast")?.();
	const fastResult = await tool(mock, "subagent_wait").execute(
		"wait",
		{ jobId: fast.details.jobId },
		undefined,
		undefined,
		context.ctx,
	);
	assert.equal(fastResult.details.state, "completed");
	// The slow job is untouched by its sibling's completion.
	const runtime = runtimeOf(mock);
	const slowJob = runtime.panelJobs().find((job) => job.jobId === slow.details.jobId);
	assert.equal(slowJob?.state, "running");
	finishers.get("slow")?.();
});

test("the active-job limit is the only cap on concurrency", async () => {
	const release: Array<() => void> = [];
	const runChild = (): Promise<ChildResult> =>
		new Promise((resolve) => {
			release.push(() =>
				resolve({ state: "completed", result: "done", limitations: [], truncated: false }),
			);
		});
	const { mock, context } = await setup({ runChild });
	for (let index = 0; index < 8; index++) {
		await spawnJob(mock, context, `task ${index}`);
	}
	await Promise.resolve();
	assert.equal(release.length, 8);
	assert.equal(runtimeOf(mock).activeJobsForDisplay().length, 8);
	await assert.rejects(
		() => spawnJob(mock, context, "ninth"),
		/Active subagent job limit reached \(8\)/u,
	);
	for (const finish of release) finish();
});

test("the spawn contract tells the model that a parallel batch must be independent", async () => {
	const { mock } = await setup();
	const spawn = (
		mock.tools as unknown as Array<{
			name: string;
			description: string;
			promptGuidelines?: string[];
		}>
	).find((candidate) => candidate.name === "subagent_spawn");
	assert.ok(spawn);
	assert.match(spawn?.description ?? "", /mutually independent/u);
	assert.match(
		spawn?.description ?? "",
		/start it only after that job's result has been collected/u,
	);
	assert.ok(
		spawn?.promptGuidelines?.some((line) => /mutually independent tasks/u.test(line)),
		"expected an independence guideline",
	);
	assert.ok(
		spawn?.promptGuidelines?.some((line) => /disjoint file ownership/u.test(line)),
		"expected a disjoint-ownership guideline",
	);
});

test("a user instruction file replaces the spawn description and guidelines", async () => {
	const overrides = emptyOverrides();
	overrides.tools.set("subagent_spawn", {
		description: "Spawn only when the user has named the files each job owns.",
		guidelines: ["Never run more than two jobs at once."],
	});
	const { mock } = await setup({ instructions: overrides });
	const spawn = promptSurface(mock, "subagent_spawn");
	assert.equal(spawn.description, "Spawn only when the user has named the files each job owns.");
	assert.deepEqual(spawn.promptGuidelines, ["Never run more than two jobs at once."]);
});

test("an override for one tool leaves the others on their built-in text", async () => {
	const overrides = emptyOverrides();
	overrides.tools.set("subagent_cancel", { description: "Cancel nothing without asking me." });
	const { mock } = await setup({ instructions: overrides });
	assert.equal(
		promptSurface(mock, "subagent_cancel").description,
		"Cancel nothing without asking me.",
	);
	// The untouched tools still carry the shipped contract.
	assert.match(promptSurface(mock, "subagent_spawn").description, /mutually independent/u);
	assert.match(promptSurface(mock, "subagent_wait").description, /become terminal/u);
});

function promptSurface(
	mock: Mock,
	name: string,
): { description: string; promptGuidelines?: string[] } {
	const found = (
		mock.tools as unknown as Array<{
			name: string;
			description: string;
			promptGuidelines?: string[];
		}>
	).find((candidate) => candidate.name === name);
	assert.ok(found, `expected tool ${name}`);
	return found;
}

test("the spawn contract tells the model to do the work itself by default", async () => {
	const { mock } = await setup();
	const spawn = (
		mock.tools as unknown as Array<{
			name: string;
			description: string;
			promptGuidelines?: string[];
			parameters: { properties?: Record<string, { description?: string }> };
		}>
	).find((candidate) => candidate.name === "subagent_spawn");
	assert.ok(spawn);
	const guidelines = spawn?.promptGuidelines ?? [];
	// The restraint rule is first, so a model that reads one bullet reads this one.
	assert.match(guidelines[0] ?? "", /do the work yourself by default/iu);
	// It names the three cases that justify the cost, and says the cost exists.
	assert.match(guidelines[0] ?? "", /independent tasks/iu);
	assert.match(guidelines[0] ?? "", /flood this context/iu);
	assert.match(guidelines[0] ?? "", /user asks/iu);
	assert.match(guidelines[0] ?? "", /verify its claims/iu);
	// Work that must stay in the main session is named rather than implied.
	assert.ok(
		guidelines.some((line) => /never delegate planning/iu.test(line)),
		"expected a keep-it-here guideline",
	);
	// A child cannot ask, so the task has to be self-contained.
	assert.match(spawn?.description ?? "", /cannot ask you anything/iu);
	// Thinking level inherits the session rather than being chosen per job.
	assert.match(
		spawn?.parameters.properties?.thinkingLevel?.description ?? "",
		/inherits this session's effective level/iu,
	);
});

function tool(mock: Mock, name: string): RegisteredTool {
	const found = (mock.tools as unknown as RegisteredTool[]).find(
		(candidate) => candidate.name === name,
	);
	assert.ok(found, `expected tool ${name}`);
	return found;
}

function spawnJob(mock: Mock, context: Context, task: string) {
	return tool(mock, "subagent_spawn").execute(
		"spawn",
		{ task, description: "test job" },
		undefined,
		undefined,
		context.ctx,
	);
}

const registeredRuntimes = new WeakMap<Mock, SubagentRuntime>();

function runtimeOf(mock: Mock): SubagentRuntime {
	const runtime = registeredRuntimes.get(mock);
	assert.ok(runtime, "expected a runtime for this session");
	return runtime;
}

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
