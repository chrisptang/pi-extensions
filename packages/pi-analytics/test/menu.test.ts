import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
	KeybindingsManager,
	type KeyId,
	matchesKey,
	TUI_KEYBINDINGS,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { resolveMenuScreen, runConfirmation, runMenu } from "@narumitw/pi-tui-kit";
import { createRpcHarness, createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import {
	type AnalyticsMenuDataSource,
	type AnalyticsMenuState,
	createAnalyticsMenu,
	showAnalyticsMenu,
} from "../src/menu.js";
import type { AnalyticsSnapshot } from "../src/storage/queries.js";

initTheme("dark", false);

const confirmationOptions = { runConfirmation, isCurrent: () => true };

const snapshot: AnalyticsSnapshot = {
	overview: {
		responseCycles: 83,
		llmCalls: 192,
		callsPerResponse: 2.31,
		p95CallsPerResponse: 6,
		toolCalls: 414,
		toolErrors: 7,
		skillActivations: 31,
		providerErrors: 4,
		recoveredErrors: 3,
	},
	skills: [
		{
			name: "reviewing-code",
			count: 18,
			modelInitiated: 13,
			userInitiated: 5,
			lastOccurredAtMs: 1_786_000_000_000,
			models: [{ provider: "openai", model: "gpt-test", count: 18 }],
		},
	],
	tools: [
		{
			name: "read",
			count: 182,
			errors: 2,
			averageDurationMs: 12.5,
			lastOccurredAtMs: 1_786_000_000_000,
			models: [{ provider: "openai", model: "gpt-test", count: 182 }],
		},
	],
	reliability: {
		http429: 3,
		http5xx: 1,
		recovered: 3,
		terminal: 1,
		categories: {
			dns: 0,
			timeout: 2,
			connection_refused: 0,
			connection_reset: 1,
			tls: 0,
			network_other: 0,
			provider_other: 0,
		},
	},
	responses: {
		count: 83,
		llmCalls: 192,
		average: 2.31,
		median: 2,
		p95: 6,
		maximum: 9,
		distribution: { one: 31, twoToThree: 34, fourToSix: 15, sevenPlus: 3 },
	},
	tokens: {
		input: 120_000,
		output: 38_000,
		cacheRead: 880_000,
		cacheWrite: 42_000,
		cost: 4.13,
		tokens: 1_080_000,
		measuredCalls: 190,
		unmeasuredCalls: 2,
		cacheHitRate: 84.45,
		models: [
			{
				provider: "anthropic",
				model: "claude-b",
				calls: 150,
				tokens: 900_000,
				input: 100_000,
				output: 30_000,
				cacheRead: 740_000,
				cacheWrite: 30_000,
				cost: 3.5,
			},
			{
				provider: "openai",
				model: "gpt-a",
				calls: 40,
				tokens: 180_000,
				input: 20_000,
				output: 8_000,
				cacheRead: 140_000,
				cacheWrite: 12_000,
				cost: 0.63,
			},
		],
	},
	sessions: {
		count: 12,
		llmCalls: 190,
		activeDays: 4,
		totalDays: 7,
		longestStreak: 3,
		currentStreak: 2,
		tokens: 1_080_000,
		cost: 4.13,
		averageDurationMs: 1_800_000,
		longestDurationMs: 9_000_000,
		projects: [
			{ project: "pi-extensions", sessions: 8, llmCalls: 150, tokens: 900_000, cost: 3.5 },
			{ project: "demo", sessions: 4, llmCalls: 40, tokens: 180_000, cost: 0.63 },
		],
		days: [
			{ date: "2026-08-03", sessions: 2, llmCalls: 40, tokens: 200_000, cost: 0.8 },
			{ date: "2026-08-04", sessions: 4, llmCalls: 70, tokens: 400_000, cost: 1.6 },
			{ date: "2026-08-05", sessions: 4, llmCalls: 60, tokens: 380_000, cost: 1.4 },
			{ date: "2026-08-07", sessions: 2, llmCalls: 20, tokens: 100_000, cost: 0.33 },
		],
	},
};

function source(overrides: Partial<AnalyticsMenuDataSource> = {}): AnalyticsMenuDataSource {
	return {
		path: "/home/test/.pi/agent/pi-analytics.db",
		async load() {
			return { kind: "ready", snapshot };
		},
		async clearAll() {
			return { cleanupIncomplete: false };
		},
		...overrides,
	};
}

async function state(
	controller: ReturnType<typeof createAnalyticsMenu>,
): Promise<AnalyticsMenuState> {
	return controller.getState({ signal: new AbortController().signal });
}

function withRpcUi(
	context: ReturnType<typeof createMockContext>,
	rpc: ReturnType<typeof createRpcHarness>,
) {
	const base = context.ctx as unknown as {
		ui: Record<string, unknown>;
		[key: string]: unknown;
	};
	return { ...base, ui: { ...base.ui, ...rpc.ui } } as never;
}

test("dashboard exposes nine primary rows and concise settled metrics", async () => {
	const controller = createAnalyticsMenu(source());
	const screen = resolveMenuScreen(controller.menu, "main", await state(controller));
	assert.equal(screen.kind, "actions");
	if (screen.kind !== "actions") return;
	assert.equal(screen.items.length, 9);
	assert.deepEqual(
		screen.items.map(({ label }) => label),
		[
			"Change time range",
			"Response cycles",
			"Tools",
			"Skills",
			"Provider reliability",
			"Sessions & activity",
			"Tokens & cost",
			"Data & privacy",
			"Close",
		],
	);
	assert.match(screen.title, /Last 7 days/);
	const lines = screen.lines?.join("\n") ?? "";
	assert.match(lines, /Collected\nResponse cycles\s+83/);
	assert.match(lines, /Tool calls\s+414 · 7 errors/);
	assert.match(lines, /Skills\s+31 activations/);
	assert.match(lines, /Reliability\s+4 provider errors · 3 recovered/);
	assert.match(lines, /Imported\nSessions\s+12/);
	assert.match(lines, /LLM calls\s+190/);
	assert.match(lines, /Tokens\s+1\.08M · \$4\.13/);
	assert.match(lines, /Active days\s+4\/7/);
	assert.ok(lines.indexOf("Collected") < lines.indexOf("Imported"));
});

test("tokens screen separates cached prompt tokens from billed input and lists models", async () => {
	const controller = createAnalyticsMenu(source());
	const screen = resolveMenuScreen(controller.menu, "tokens", await state(controller));
	assert.equal(screen.kind, "detail");
	const lines = screen.lines?.join("\n") ?? "";
	assert.match(lines, /Input \(uncached\)\s+120k/);
	assert.match(lines, /Cache read\s+880k/);
	assert.match(lines, /Cache write\s+42k/);
	assert.match(lines, /Output\s+38k/);
	assert.match(lines, /Total\s+1\.08M/);
	assert.match(lines, /Cost\s+\$4\.13/);
	assert.match(lines, /Cache hit rate\s+84\.45%/);
	// Calls the provider reported without usage counters stay visible instead of reading as zero.
	assert.match(lines, /Calls without usage\s+2/);
	assert.match(lines, /anthropic\/claude-b\s+900k · \$3\.50 · 150 calls/);
	assert.match(lines, /openai\/gpt-a\s+180k · \$0\.63 · 40 calls/);
});

test("skill and tool browse details preserve attribution and model breakdowns", async () => {
	const controller = createAnalyticsMenu(source());
	const current = await state(controller);
	const skills = resolveMenuScreen(controller.menu, "skills", current);
	const tools = resolveMenuScreen(controller.menu, "tools", current);
	assert.equal(skills.kind, "browse");
	assert.equal(tools.kind, "browse");
	if (skills.kind !== "browse" || tools.kind !== "browse") return;
	assert.equal(skills.items[0]?.statusText, "18 · 13 model / 5 user");
	assert.match(skills.items[0]?.details?.join("\n") ?? "", /openai\/gpt-test: 18/);
	assert.equal(tools.items[0]?.statusText, "182 · 2 errors");
	assert.match(tools.items[0]?.details?.join("\n") ?? "", /Average duration: 12.5 ms/);
});

test("dashboard strips terminal controls from stored labels, models, and paths", async () => {
	const baseSkill = snapshot.skills[0];
	assert.ok(baseSkill);
	const unsafe = {
		...snapshot,
		skills: [
			{
				...baseSkill,
				name: "skill\u001b]8;;https://evil.example\u0007name",
				models: [{ provider: "provider\u001b[31m", model: "model\u009b31m", count: 1 }],
			},
		],
	};
	const controller = createAnalyticsMenu(
		source({
			path: "/tmp/path\u001b]0;owned\u0007",
			async load() {
				return { kind: "ready", snapshot: unsafe };
			},
		}),
	);
	const current = await state(controller);
	const skills = resolveMenuScreen(controller.menu, "skills", current);
	const privacy = resolveMenuScreen(controller.menu, "privacy", current);
	assert.equal(skills.kind, "browse");
	assert.equal(privacy.kind, "actions");
	if (skills.kind !== "browse" || privacy.kind !== "actions") return;
	assert.equal((skills.items[0]?.id ?? "").includes("\u001b"), true);
	assert.doesNotMatch(
		JSON.stringify({
			item: {
				label: skills.items[0]?.label,
				searchText: skills.items[0]?.searchText,
				details: skills.items[0]?.details,
			},
			lines: privacy.lines,
		}),
		/\\u00(?:1b|07|9b)/iu,
	);
});

test("range selection updates the next state load without creating settings", async () => {
	const loaded: string[] = [];
	const controller = createAnalyticsMenu(
		source({
			async load(range) {
				loaded.push(range.id ?? "custom");
				return { kind: "ready", snapshot };
			},
		}),
	);
	await state(controller);
	const action = controller.menu.actions.setRange;
	await action({
		ctx: createMockContext({ hasUI: true, mode: "rpc" }).ctx,
		state: await state(controller),
		signal: new AbortController().signal,
		itemId: "30d",
	});
	await state(controller);
	assert.deepEqual(loaded, ["7d", "30d"]);
});

test("clear cancellation is side-effect free and confirmation clears committed rows", async () => {
	let clears = 0;
	const controller = createAnalyticsMenu(
		source({
			async clearAll() {
				clears += 1;
				return { cleanupIncomplete: false };
			},
		}),
		Date.now,
		confirmationOptions,
	);
	const current = await state(controller);
	const cancelledRpc = createRpcHarness([{ kind: "select", response: undefined }]);
	const cancelled = createMockContext({ hasUI: true, mode: "rpc" });
	await controller.menu.actions.clearData({
		ctx: withRpcUi(cancelled, cancelledRpc),
		state: current,
		signal: new AbortController().signal,
		itemId: "clear",
	});
	cancelledRpc.assertConsumed();
	assert.equal(clears, 0);
	assert.match(cancelledRpc.dialogs[0]?.title ?? "", /clear all local analytics history/i);
	assert.match(
		cancelledRpc.dialogs[0]?.title ?? "",
		/selected range currently shows 83 response cycles/i,
	);

	const confirmedRpc = createRpcHarness([{ kind: "select", response: "Delete data" }]);
	const confirmed = createMockContext({ hasUI: true, mode: "rpc" });
	await controller.menu.actions.clearData({
		ctx: withRpcUi(confirmed, confirmedRpc),
		state: current,
		signal: new AbortController().signal,
		itemId: "clear",
	});
	confirmedRpc.assertConsumed();
	assert.equal(clears, 1);
	assert.match(confirmed.notifications[0]?.message ?? "", /Cleared local analytics data/);
});

test("TUI Ctrl+C closes the dashboard from clear confirmation without deleting data", async () => {
	let clears = 0;
	const controller = createAnalyticsMenu(
		source({
			async clearAll() {
				clears += 1;
				return { cleanupIncomplete: false };
			},
		}),
		Date.now,
		confirmationOptions,
	);
	const tui = createTuiHarness({ width: 80, rows: 24 });
	const context = createMockContext({ hasUI: true, mode: "tui", custom: tui.custom });
	const clearing = controller.menu.actions.clearData({
		ctx: context.ctx,
		state: await state(controller),
		signal: new AbortController().signal,
		itemId: "clear",
	});
	await tui.waitForOpen();
	tui.press("ctrl+c");
	assert.deepEqual(await clearing, { kind: "close" });
	assert.equal(clears, 0);
});

test("stale and failed clear confirmations never delete analytics", async () => {
	let clears = 0;
	const analyticsSource = source({
		async clearAll() {
			clears += 1;
			return { cleanupIncomplete: false };
		},
	});
	const stale = createAnalyticsMenu(analyticsSource, Date.now, {
		runConfirmation,
		isCurrent: () => false,
	});
	const staleContext = createMockContext({ hasUI: true, mode: "rpc" });
	assert.deepEqual(
		await stale.menu.actions.clearData({
			ctx: staleContext.ctx,
			state: await state(stale),
			signal: new AbortController().signal,
			itemId: "clear",
		}),
		{ kind: "close" },
	);

	const failed = createAnalyticsMenu(analyticsSource, Date.now, confirmationOptions);
	const failedContext = createMockContext({
		hasUI: true,
		mode: "rpc",
		select: async () => {
			throw new Error("confirmation transport failed");
		},
	});
	await assert.rejects(
		Promise.resolve(
			failed.menu.actions.clearData({
				ctx: failedContext.ctx,
				state: await state(failed),
				signal: new AbortController().signal,
				itemId: "clear",
			}),
		),
		/confirmation transport failed/u,
	);
	assert.equal(clears, 0);
});

test("clear reports obsolete files that could not be removed", async () => {
	const controller = createAnalyticsMenu(
		source({
			async clearAll() {
				return { cleanupIncomplete: true };
			},
		}),
		Date.now,
		confirmationOptions,
	);
	const current = await state(controller);
	const rpc = createRpcHarness([{ kind: "select", response: "Delete data" }]);
	const confirmed = createMockContext({ hasUI: true, mode: "rpc" });
	await controller.menu.actions.clearData({
		ctx: withRpcUi(confirmed, rpc),
		state: current,
		signal: new AbortController().signal,
		itemId: "clear",
	});
	rpc.assertConsumed();
	assert.match(confirmed.notifications[0]?.message ?? "", /Cleared local analytics data/);
	assert.match(confirmed.notifications[1]?.message ?? "", /still in use/);
});

test("clear completion remains visible when cancellation races after confirmation", async () => {
	let startedClear!: () => void;
	const started = new Promise<void>((resolve) => {
		startedClear = resolve;
	});
	let release!: () => void;
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	const controller = createAnalyticsMenu(
		source({
			async clearAll() {
				startedClear();
				await blocked;
				return { cleanupIncomplete: false };
			},
		}),
		Date.now,
		confirmationOptions,
	);
	const current = await state(controller);
	const rpc = createRpcHarness([{ kind: "select", response: "Delete data" }]);
	const confirmed = createMockContext({ hasUI: true, mode: "rpc" });
	const owner = new AbortController();
	const clearing = controller.menu.actions.clearData({
		ctx: withRpcUi(confirmed, rpc),
		state: current,
		signal: owner.signal,
		itemId: "clear",
	});
	await started;
	owner.abort();
	release();
	assert.deepEqual(await clearing, { kind: "close" });
	rpc.assertConsumed();
	assert.match(confirmed.notifications[0]?.message ?? "", /Cleared local analytics data/);
});

test("session replacement after committed clear suppresses stale UI publication", async () => {
	let startedClear!: () => void;
	const started = new Promise<void>((resolve) => {
		startedClear = resolve;
	});
	let release!: () => void;
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	let current = true;
	const controller = createAnalyticsMenu(
		source({
			async clearAll() {
				startedClear();
				await blocked;
				return { cleanupIncomplete: false };
			},
		}),
		Date.now,
		{ runConfirmation, isCurrent: () => current },
	);
	const rpc = createRpcHarness([{ kind: "select", response: "Delete data" }]);
	const context = createMockContext({ hasUI: true, mode: "rpc" });
	const clearing = controller.menu.actions.clearData({
		ctx: withRpcUi(context, rpc),
		state: await state(controller),
		signal: new AbortController().signal,
		itemId: "clear",
	});
	await started;
	current = false;
	release();
	assert.deepEqual(await clearing, { kind: "close" });
	rpc.assertConsumed();
	assert.equal(context.notifications.length, 0);
});

test("empty and unavailable states remain actionable", async () => {
	const emptySnapshot: AnalyticsSnapshot = {
		...snapshot,
		overview: { ...snapshot.overview, responseCycles: 0 },
		skills: [],
		tools: [],
	};
	const empty = createAnalyticsMenu(
		source({
			async load() {
				return { kind: "ready", snapshot: emptySnapshot };
			},
		}),
	);
	const emptyMain = resolveMenuScreen(empty.menu, "main", await state(empty));
	// Imported sessions stay visible even before the first response cycle is collected.
	const emptyText = emptyMain.lines?.join("\n") ?? "";
	assert.match(emptyText, /Response cycles\s+0/);
	assert.match(emptyText, /Imported\nSessions\s+12/);
	const unavailable = createAnalyticsMenu(
		source({
			async load() {
				return { kind: "unavailable", message: "Native binding unavailable on linux-arm64-musl" };
			},
		}),
	);
	const unavailableMain = resolveMenuScreen(unavailable.menu, "main", await state(unavailable));
	assert.match(unavailableMain.lines?.join("\n") ?? "", /No analytics are being collected/);
	assert.match(unavailableMain.lines?.join("\n") ?? "", /linux-arm64-musl/);
});

test("RPC adapts the same dashboard without opening custom TUI", async () => {
	const rpc = createRpcHarness([{ kind: "select", response: "Close" }]);
	const base = createMockContext({ hasUI: true, mode: "rpc" }).ctx as unknown as {
		ui: Record<string, unknown>;
		[key: string]: unknown;
	};
	const ctx = { ...base, ui: { ...base.ui, ...rpc.ui } } as never;
	const owner = new AbortController();
	await showAnalyticsMenu(ctx, source(), {
		signal: owner.signal,
		isCurrent: () => !owner.signal.aborted,
	});
	rpc.assertConsumed();
});

test("TUI shows a cancellable loader before opening the dashboard", async () => {
	let customCalls = 0;
	const { ctx } = createMockContext({
		hasUI: true,
		mode: "tui",
		custom: async (factory: unknown) =>
			new Promise<unknown>((resolve) => {
				if (typeof factory !== "function") return resolve(undefined);
				customCalls += 1;
				let component: { dispose?(): void; handleInput(data: string): void };
				const done = (value: unknown) => {
					component.dispose?.();
					resolve(value);
				};
				component = (
					factory as (
						tui: { requestRender(): void },
						theme: { fg(_color: string, text: string): string },
						keybindings: object,
						done: (value: unknown) => void,
					) => typeof component
				)({ requestRender() {} }, { fg: (_color, text) => text }, {}, done);
				setImmediate(() => component.handleInput("\u001b"));
			}),
	});
	const owner = new AbortController();
	await showAnalyticsMenu(
		ctx,
		source({
			async load(_range, signal) {
				await new Promise<void>((_resolve, reject) => {
					signal.addEventListener(
						"abort",
						() => reject(new DOMException("cancelled", "AbortError")),
						{ once: true },
					);
				});
				return { kind: "ready", snapshot };
			},
		}),
		{ signal: owner.signal, isCurrent: () => !owner.signal.aborted },
	);
	assert.equal(customCalls, 1);
});

test("dashboard rendering is width-safe and owner cancellation settles the menu", async () => {
	const controller = createAnalyticsMenu(source());
	const tui = createTuiHarness({ width: 40, rows: 20 });
	const owner = new AbortController();
	const base = createMockContext({ hasUI: true, mode: "tui" }).ctx as unknown as {
		ui: Record<string, unknown>;
		[key: string]: unknown;
	};
	const ctx = { ...base, ui: { ...base.ui, custom: tui.custom } } as never;
	const running = runMenu(ctx, controller.menu, {
		getState: controller.getState,
		signal: owner.signal,
		isCurrent: () => !owner.signal.aborted,
	});
	await tui.waitForOpen();
	for (const width of [40, 80, 120]) {
		tui.resize({ width, rows: 20 });
		const frame = tui.render();
		for (const line of frame) assert.ok(visibleWidth(line) <= width);
		assert.equal(stripVTControlCharacters(frame[0] ?? ""), "─".repeat(width));
		assert.equal(stripVTControlCharacters(frame.at(-1) ?? ""), "─".repeat(width));
	}
	owner.abort();
	assert.equal((await running).kind, "stale");
});

test.each(["r", "R", "\u001b[114u", "\u001b[114;2u"])(
	"dashboard cycles immediately with %j and preserves selection",
	async (key) => {
		const loaded: string[] = [];
		const tui = createTuiHarness({
			width: 100,
			rows: 40,
			keybindings: new KeybindingsManager(TUI_KEYBINDINGS),
		});
		const { ctx } = createMockContext({ hasUI: true, mode: "tui", custom: tui.custom });
		const running = showAnalyticsMenu(
			ctx,
			source({
				async load(range) {
					loaded.push(range.id ?? "custom");
					return { kind: "ready", snapshot };
				},
			}),
			{ signal: new AbortController().signal, isCurrent: () => true },
		);
		await vi.waitFor(() => assert.match(tui.render().join("\n"), /range 7D\/30D\/ALL/));
		assert.doesNotMatch(tui.render().join("\n"), /Change time range/);
		assert.match(tui.render().join("\n"), /Input \(uncached\)/);
		for (let index = 0; index < 5; index += 1) tui.send("\u001b[C");
		for (const label of ["Analytics · 30D", "Analytics · ALL", "Analytics · 7D"]) {
			tui.send(key);
			await vi.waitFor(() => assert.match(tui.render().join("\n"), new RegExp(label)));
		}
		assert.deepEqual(loaded, ["7d", "30d", "all", "7d"]);
		assert.match(tui.render().join("\n"), /Session length is wall-clock/);
		tui.press("tui.select.cancel");
		await running;
	},
);

test("tabs show ordered read-only metrics, wrap safely, scroll, and close directly", async () => {
	const tui = createTuiHarness({
		width: 120,
		rows: 24,
		keybindings: new KeybindingsManager(TUI_KEYBINDINGS),
	});
	const { ctx } = createMockContext({ hasUI: true, mode: "tui", custom: tui.custom });
	const running = showAnalyticsMenu(ctx, source(), {
		signal: new AbortController().signal,
		isCurrent: () => true,
	});
	await vi.waitFor(() => assert.match(tui.render().join("\n"), /Analytics · 7D/));
	const frame = stripVTControlCharacters(tui.render().join("\n"));
	assert.match(
		frame,
		/Tokens & cost.*Response cycles.*Tools.*Skills.*Provider reliability.*Sessions & activity/,
	);
	assert.doesNotMatch(frame, /Data & privacy|enter select|→ /);
	for (const metric of [
		/Calls per response/,
		/Average duration/,
		/Model initiated/,
		/HTTP 429/,
		/Longest streak/,
		/Input \(uncached\)/,
	]) {
		tui.send("\t");
		assert.match(tui.render().join("\n"), metric);
	}
	tui.press("tui.select.pageDown");
	assert.match(tui.render().join("\n"), /openai\/gpt-a/);
	for (const width of [1, 20, 40, 80, 120]) {
		tui.resize({ width, rows: 24 });
		for (const line of tui.render()) assert.ok(visibleWidth(line) <= width);
	}
	tui.send("\u001b");
	await running;
});

test("range shortcut yields to remapped standard actions", async () => {
	const keybindings = {
		getKeys: (binding: string): KeyId[] =>
			binding === "tui.select.cancel" ? ["r", "shift+r"] : [],
		matches: (data: string, binding: string) =>
			binding === "tui.select.cancel" && (matchesKey(data, "r") || matchesKey(data, "shift+r")),
	};
	const tui = createTuiHarness({ width: 100, keybindings });
	const { ctx } = createMockContext({ hasUI: true, mode: "tui", custom: tui.custom });
	const running = showAnalyticsMenu(ctx, source(), {
		signal: new AbortController().signal,
		isCurrent: () => true,
	});
	await vi.waitFor(() => assert.match(tui.render().join("\n"), /Analytics · 7D/));
	assert.doesNotMatch(tui.render().join("\n"), /range 7D\/30D\/ALL/);
	tui.send("r");
	await running;
});

test.each(["cancel", "dispose", "replace"])("range query aborts on %s", async (exit) => {
	let querySignal: AbortSignal | undefined;
	const owner = new AbortController();
	const tui = createTuiHarness({ width: 100 });
	const { ctx } = createMockContext({ hasUI: true, mode: "tui", custom: tui.custom });
	const running = showAnalyticsMenu(
		ctx,
		source({
			async load(range, signal) {
				if (range.id !== "7d") {
					querySignal = signal;
					await new Promise<void>((resolve) =>
						signal.addEventListener("abort", () => resolve(), { once: true }),
					);
				}
				return { kind: "ready", snapshot };
			},
		}),
		{ signal: owner.signal, isCurrent: () => !owner.signal.aborted },
	);
	await vi.waitFor(() => assert.match(tui.render().join("\n"), /range 7D\/30D\/ALL/));
	tui.send("r");
	await vi.waitFor(() => assert.ok(querySignal));
	if (exit === "replace") owner.abort();
	else {
		await tui.waitForOpen();
		if (exit === "dispose") tui.dispose();
		else tui.press("ctrl+c");
	}
	await running;
	assert.equal(querySignal?.aborted, true);
});

test("sessions screen reports streaks, a heatmap and per-project totals", async () => {
	const controller = createAnalyticsMenu(source());
	const screen = resolveMenuScreen(controller.menu, "sessions", await state(controller));
	assert.equal(screen.kind, "detail");
	const lines = screen.lines?.join("\n") ?? "";
	assert.match(lines, /Sessions\s+12/);
	assert.match(lines, /Active days\s+4\/7/);
	assert.match(lines, /Longest streak\s+3 days/);
	assert.match(lines, /Current streak\s+2 days/);
	assert.match(lines, /Average session\s+30m/);
	assert.match(lines, /Longest session\s+2h 30m/);
	// The heatmap keeps one row per week with a Monday-first header.
	assert.match(lines, /Mon Tue Wed Thu Fri Sat Sun/);
	assert.match(lines, /less · ░ ▒ ▓ █ more/);
	assert.match(lines, /pi-extensions\s+8 sessions · 900k · \$3\.50/);
	assert.match(lines, /demo\s+4 sessions · 180k · \$0\.63/);
	assert.match(lines, /Session length is wall-clock time/);
});

test("sessions screen points at the backfill script when nothing is imported", async () => {
	const empty: AnalyticsSnapshot = {
		...snapshot,
		sessions: { ...snapshot.sessions, count: 0, days: [], projects: [] },
	};
	const controller = createAnalyticsMenu(
		source({
			load: async () => ({ kind: "ready", snapshot: empty }),
		}),
	);
	const screen = resolveMenuScreen(controller.menu, "sessions", await state(controller));
	const lines = screen.lines?.join("\n") ?? "";
	assert.match(lines, /No sessions recorded in this range/);
	assert.match(lines, /backfill-sessions\.mjs/);
});

test("a database with neither runs nor sessions shows only the collection hint", async () => {
	const blank: AnalyticsSnapshot = {
		...snapshot,
		overview: { ...snapshot.overview, responseCycles: 0 },
		sessions: { ...snapshot.sessions, count: 0, tokens: 0, cost: 0, days: [], projects: [] },
	};
	const controller = createAnalyticsMenu(
		source({ load: async () => ({ kind: "ready", snapshot: blank }) }),
	);
	const screen = resolveMenuScreen(controller.menu, "main", await state(controller));
	const lines = screen.lines?.join("\n") ?? "";
	assert.match(lines, /Response cycles\s+0/);
	assert.match(lines, /Imported\nSessions\s+0/);
});
