import assert from "node:assert/strict";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { registerGoalCommand } from "../src/command-registration.js";
import { GoalCommandController } from "../src/commands.js";
import { GoalRuntime } from "../src/runtime.js";

function fixture(overrides: Record<string, unknown> = {}) {
	const mock = createMockPi({ activeTools: ["goal_confirm", "goal_complete", "goal_blocked"] });
	const runtime = new GoalRuntime(mock.pi);
	const commands = new GoalCommandController(runtime);
	registerGoalCommand(mock.pi, runtime, commands);
	const context = createMockContext({ mode: "tui", ...overrides });
	const command = mock.commands.get("goal");
	const tool = mock.tools.find((tool) => tool.name === "goal_confirm");
	assert.ok(command && tool);
	const execute = tool.execute as (...args: unknown[]) => Promise<unknown>;
	return {
		...mock,
		...context,
		runtime,
		commands,
		commandsForTransition: (text: string) => command.handler(text, context.ctx),
		start: (text = "--tokens 100k initial objective") => command.handler(text, context.ctx),
		confirm: (
			objective = "Agreed scope, constraints, and passing acceptance tests",
			signal?: AbortSignal,
			requestId?: string,
		) => {
			const message = mock.sentMessages.at(-1)?.message as { content: string };
			return execute(
				"approval",
				{
					request_id: requestId ?? /Request ID: (\S+)/.exec(message.content)?.[1],
					objective,
				},
				signal,
				undefined,
				context.ctx,
			);
		},
	};
}

for (const mode of ["tui", "rpc"]) {
	test(`command clarifies without saving, then persists only approved objective in ${mode}`, async () => {
		let message = "";
		const f = fixture({
			mode,
			confirm: async (_title: string, text: string) => {
				message = text;
				assert.equal(f.runtime.activeGoal, undefined);
				assert.equal(f.entries.length, 0);
				return true;
			},
		});
		const tools = f.rawPi.getActiveTools();
		const definitions = JSON.stringify(f.tools);
		await f.start();
		assert.equal(f.entries.length, 0);
		assert.equal(f.sentUserMessages.length, 0);
		const clarification = f.sentMessages[0]?.message as { content: string };
		assert.match(clarification.content, /MUST clarify.*acceptance criteria/s);
		await f.confirm();
		assert.match(message, /Agreed scope/);
		assert.match(message, /100000/);
		assert.equal(
			f.runtime.activeGoal?.text,
			"Agreed scope, constraints, and passing acceptance tests",
		);
		assert.equal(f.runtime.activeGoal?.tokenBudget, 100_000);
		assert.equal(f.sentUserMessages.length, 1);
		assert.deepEqual(f.rawPi.getActiveTools(), tools);
		assert.equal(JSON.stringify(f.tools), definitions);
		await assert.rejects(f.confirm(), /No matching/);
	});
}

test("No/Escape leaves draft unsaved and permits a revised confirmation", async () => {
	let approved = false;
	const f = fixture({ confirm: async () => approved });
	await f.start();
	await f.confirm();
	assert.equal(f.entries.length, 0);
	assert.equal(f.sentUserMessages.length, 0);
	approved = true;
	await f.confirm("revised objective");
	assert.equal(f.runtime.activeGoal?.text, "revised objective");
});

for (const mode of ["print", "json"]) {
	test(`headless ${mode} rejects before prompt or persistence`, async () => {
		const f = fixture({ mode });
		await assert.rejects(async () => f.start(), /requires TUI or RPC UI/);
		assert.equal(f.entries.length, 0);
		assert.equal(f.sentMessages.length, 0);
	});
}

for (const transition of [
	"clear",
	"pause",
	"edit replacement",
	"shutdown",
	"replace-session",
	"new-draft",
	"abort",
]) {
	test(`pending confirmation is cancelled by ${transition}`, async () => {
		let release!: (value: boolean) => void;
		let signal: AbortSignal | undefined;
		const f = fixture({
			confirm: (_title: string, _text: string, options: { signal: AbortSignal }) => {
				signal = options.signal;
				return new Promise<boolean>((resolve) => {
					release = resolve;
				});
			},
		});
		await f.start();
		const controller = new AbortController();
		const confirmation = f.confirm("old objective", controller.signal);
		const rejected = assert.rejects(confirmation, /cancelled or superseded/);
		if (transition === "shutdown") f.runtime.closeMenuSession();
		else if (transition === "replace-session") f.runtime.replaceMenuSession();
		else if (transition === "new-draft") await f.start("new objective");
		else if (transition === "abort") controller.abort();
		else await f.commandsForTransition(transition);
		assert.equal(signal?.aborted, true);
		release(true); // Even a misbehaving UI cannot approve after cancellation.
		await rejected;
		assert.equal(f.runtime.activeGoal, undefined);
		assert.equal(f.sentUserMessages.length, 0);
	});
}

test("duplicate, invalid and stale confirmation calls cannot save", async () => {
	let release!: (value: boolean) => void;
	const f = fixture({
		confirm: () =>
			new Promise<boolean>((resolve) => {
				release = resolve;
			}),
	});
	await f.start();
	await assert.rejects(f.confirm("", undefined), /Usage/);
	await assert.rejects(f.confirm("x".repeat(4_001)), /too long/);
	await assert.rejects(f.confirm("valid", undefined, "wrong-id"), /No matching/);
	const first = f.confirm();
	await assert.rejects(f.confirm(), /already open/);
	release(true);
	await first;
	assert.equal(f.sentUserMessages.length, 1);
});

test("unavailable tool and busy agent leave state unchanged", async () => {
	const f = fixture();
	f.rawPi.setActiveTools([]);
	await assert.rejects(async () => f.start(), /goal_confirm is unavailable/);
	assert.equal(f.sentMessages.length, 0);
	const busy = fixture({ isIdle: () => false });
	await busy.start();
	assert.equal(busy.sentMessages.length, 0);
});

test("menu-style start remains direct; replacing by command pauses old Goal during clarification", async () => {
	const f = fixture({ confirm: async () => false });
	await f.commands.startGoal("old objective", undefined, f.ctx);
	const oldId = f.runtime.activeGoal?.id;
	await f.start("replacement objective");
	assert.equal(f.runtime.activeGoal?.id, oldId);
	assert.equal(f.runtime.activeGoal?.status, "paused");
	await f.confirm();
	assert.equal(f.runtime.activeGoal?.text, "old objective");
	assert.equal(f.runtime.activeGoal?.status, "paused");
});
