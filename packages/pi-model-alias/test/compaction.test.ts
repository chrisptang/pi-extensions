import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type {
	CompactionResult,
	SessionBeforeCompactEvent,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, test, vi } from "vitest";

type CompactionPreparation = SessionBeforeCompactEvent["preparation"];
type SessionBeforeCompactResult = { cancel?: boolean; compaction?: CompactionResult };

let directory: string;
let previousAgentDir: string | undefined;
let modelAlias: typeof import("../src/model-alias.js").default;
let support: typeof import("../../../test/support.js");
let ai: typeof import("@earendil-works/pi-ai");

beforeEach(async () => {
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	directory = mkdtempSync(path.join(os.tmpdir(), "pi-alias-compact-"));
	process.env.PI_CODING_AGENT_DIR = directory;
	vi.resetModules();
	ai = await import("@earendil-works/pi-ai");
	support = await import("../../../test/support.js");
	modelAlias = (await import("../src/model-alias.js")).default;
});

afterEach(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(directory, { recursive: true, force: true });
});

function configure(aliases: object): void {
	writeFileSync(path.join(directory, "model-alias.json"), JSON.stringify({ aliases }));
}

function model(id: string): Model<Api> {
	return {
		id,
		provider: "summary",
		name: id,
		api: "openai-completions",
		baseUrl: "https://original.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 2000,
		maxTokens: 5000,
		headers: { "X-Remove": "model-default" },
	};
}

function response(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		provider: "summary",
		model: "a",
		api: "openai-completions",
		timestamp: 1,
		stopReason: "stop",
		content: [{ type: "text", text: "Summary" }],
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		...overrides,
	};
}

function preparation(overrides: Partial<CompactionPreparation> = {}): CompactionPreparation {
	return {
		firstKeptEntryId: "kept",
		messagesToSummarize: [{ role: "user", content: "History", timestamp: 1 }],
		turnPrefixMessages: [],
		isSplitTurn: false,
		tokensBefore: 12345,
		fileOps: { read: new Set(["current-read"]), written: new Set(), edited: new Set() },
		settings: { enabled: true, reserveTokens: 1000, keepRecentTokens: 200 },
		...overrides,
	};
}

function setup(aliases: object = { compact: "summary/a" }, hasUI = true) {
	configure(aliases);
	const harness = support.createMockPi();
	const requests: Array<{ model: Model<Api>; context: Context; options?: SimpleStreamOptions }> =
		[];
	const available = [model("a"), model("b")];
	let produce = async (): Promise<AssistantMessage> => response();
	const provider = {
		streamSimple(target: Model<Api>, context: Context, options?: SimpleStreamOptions) {
			requests.push({ model: target, context, options });
			const stream = ai.createAssistantMessageEventStream();
			void produce().then((message) => stream.end(message));
			return stream;
		},
	};
	const registry = {
		find: vi.fn((provider: string, id: string) =>
			available.find((entry) => entry.provider === provider && entry.id === id),
		),
		hasConfiguredAuth: vi.fn(() => true),
		getApiKeyAndHeaders: vi.fn(async () => ({
			ok: true as boolean,
			apiKey: "secret",
			baseUrl: "https://auth.invalid",
			headers: { "X-Remove": null, "X-Auth": "secret-header" },
			env: { TOKEN: "secret-env" },
			error: "secret auth error\u001b[31m",
		})),
		getProvider: vi.fn(() => provider),
	};
	const { ctx, notifications } = support.createMockContext({
		cwd: directory,
		hasUI,
		model: model("main"),
		thinkingLevel: "medium",
		modelRegistry: registry,
	});
	modelAlias(harness.pi);
	const handlers = harness.events.get("session_before_compact");
	assert.equal(handlers?.length, 1, "one compaction handler must be registered");
	const run = (overrides: Partial<SessionBeforeCompactEvent> = {}) =>
		handlers?.[0]?.(
			{
				type: "session_before_compact",
				preparation: preparation(),
				branchEntries: [],
				reason: "manual",
				willRetry: false,
				signal: new AbortController().signal,
				...overrides,
			},
			ctx,
		) as Promise<SessionBeforeCompactResult | undefined>;
	return {
		...harness,
		ctx,
		notifications,
		registry,
		requests,
		run,
		produce: (next: typeof produce) => {
			produce = next;
		},
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function prompt(context: Context): string {
	return JSON.stringify(context.messages);
}

for (const aliases of [{}, { Compact: "summary/a" }]) {
	test(`absent exact compact alias is silent: ${JSON.stringify(aliases)}`, async () => {
		const h = setup(aliases);
		assert.equal(await h.run(), undefined);
		assert.equal(h.registry.getApiKeyAndHeaders.mock.calls.length, 0);
		assert.deepEqual(h.requests, []);
		assert.deepEqual(h.notifications, []);
	});
}

for (const failure of ["unknown", "unauthed", "auth", "auth-throw", "provider"]) {
	test(`unusable compact alias falls back with one generic warning: ${failure}`, async () => {
		const h = setup({ compact: failure === "unknown" ? "missing/secret\u001b[31m" : "summary/a" });
		if (failure === "unauthed") h.registry.hasConfiguredAuth.mockReturnValue(false);
		if (failure === "auth") {
			h.registry.getApiKeyAndHeaders.mockResolvedValue({
				...(await h.registry.getApiKeyAndHeaders()),
				ok: false,
			});
		}
		if (failure === "auth-throw") {
			h.registry.getApiKeyAndHeaders.mockRejectedValue(new Error("secret\u001b[31m"));
		}
		if (failure === "provider") h.registry.getProvider.mockReturnValue(undefined as never);
		assert.equal(await h.run(), undefined);
		assert.equal(h.notifications.length, 1);
		assert.equal(h.notifications[0].level, "warning");
		assert.doesNotMatch(h.notifications[0].message, /secret|missing/u);
		assert.equal(h.notifications[0].message.includes("\u001b"), false);
		assert.deepEqual(h.requests, []);
		assert.deepEqual(h.setModels, []);
		assert.deepEqual(h.thinkingLevels, []);
	});
}

test("headless failures do not notify", async () => {
	const h = setup({ compact: "missing/a" }, false);
	assert.equal(await h.run(), undefined);
	assert.deepEqual(h.notifications, []);
});

for (const reason of ["manual", "threshold", "overflow"] as const) {
	test(`${reason} uses native compact and forwards auth, budgets, instructions and usage`, async () => {
		const h = setup();
		const prep = preparation({ previousSummary: "Previous summary" });
		const original = structuredClone(prep);
		const result = await h.run({
			reason,
			willRetry: reason === "overflow",
			preparation: prep,
			customInstructions: "Focus on decisions",
		});
		assert.equal(result?.compaction?.firstKeptEntryId, "kept");
		assert.equal(result?.compaction?.tokensBefore, 12345);
		assert.deepEqual(result?.compaction?.usage, response().usage);
		assert.deepEqual(result?.compaction?.details, {
			readFiles: ["current-read"],
			modifiedFiles: [],
		});
		assert.match(result?.compaction?.summary ?? "", /Summary/u);
		const request = h.requests[0];
		assert.equal(request.model.id, "a");
		assert.equal(request.model.baseUrl, "https://auth.invalid");
		assert.equal(request.options?.apiKey, "secret");
		assert.deepEqual(request.options?.headers, { "X-Remove": null, "X-Auth": "secret-header" });
		assert.deepEqual(request.options?.env, { TOKEN: "secret-env" });
		assert.equal(request.options?.maxTokens, 800);
		assert.equal(request.options?.reasoning, "medium");
		assert.match(prompt(request.context), /Focus on decisions/u);
		assert.match(prompt(request.context), /Previous summary/u);
		assert.deepEqual(prep, original);
		assert.deepEqual(h.setModels, []);
		assert.deepEqual(h.thinkingLevels, []);
		assert.deepEqual(h.notifications, []);
	});
}

test("auth without overrides preserves the registry model", async () => {
	const h = setup();
	h.registry.getApiKeyAndHeaders.mockResolvedValue({ ok: true } as never);
	assert.ok((await h.run())?.compaction);
	assert.equal(h.requests[0].model.baseUrl, "https://original.invalid");
	assert.equal(h.requests[0].model.headers?.["X-Remove"], "model-default");
	assert.equal(h.requests[0].options?.headers, undefined);
	assert.equal(h.requests[0].options?.env, undefined);
});

for (const level of ["high", "off"] as const) {
	test(`alias thinking ${level} affects only summary request`, async () => {
		const h = setup({ compact: { models: ["summary/a"], thinkingLevel: level } });
		await h.run();
		assert.equal(h.requests[0].options?.reasoning, level === "off" ? undefined : level);
		assert.equal((h.ctx as { thinkingLevel: string }).thinkingLevel, "medium");
		assert.deepEqual(h.thinkingLevels, []);
	});
}

test("thinking level and provider are captured before awaiting auth", async () => {
	const h = setup();
	const auth = await h.registry.getApiKeyAndHeaders();
	const gate = deferred<typeof auth>();
	h.registry.getApiKeyAndHeaders.mockReturnValue(gate.promise);
	const result = h.run();
	Object.defineProperty(h.ctx, "thinkingLevel", { get: () => assert.fail("stale context read") });
	Object.defineProperty(h.ctx, "modelRegistry", { get: () => assert.fail("late registry read") });
	gate.resolve(auth);
	assert.ok((await result)?.compaction);
	assert.equal(h.requests[0].options?.reasoning, "medium");
});

test("successful compact pool is sticky, shares /ma picks, and reload clears it", async () => {
	const h = setup({ compact: ["summary/a", "summary/b"] });
	const random = vi.spyOn(Math, "random").mockReturnValue(0);
	await h.run();
	random.mockReturnValue(0.99);
	await h.run();
	assert.deepEqual(
		h.requests.map((request) => request.model.id),
		["a", "a"],
	);
	await h.commands.get("ma")?.handler("compact", h.ctx);
	assert.equal((h.setModels[0] as Model<Api>).id, "a");
	await h.commands.get("model-alias-reload")?.handler("", h.ctx);
	await h.run();
	assert.equal(h.requests.at(-1)?.model.id, "b");
});

test("definitions reloaded during request do not restore an obsolete sticky pick", async () => {
	const h = setup({ compact: ["summary/a", "summary/b"] });
	const random = vi.spyOn(Math, "random").mockReturnValue(0);
	const gate = deferred<AssistantMessage>();
	h.produce(() => gate.promise);
	const result = h.run();
	await vi.waitFor(() => assert.equal(h.requests.length, 1));
	await h.commands.get("model-alias-reload")?.handler("", h.ctx);
	random.mockReturnValue(0.99);
	gate.resolve(response());
	assert.ok((await result)?.compaction);
	h.produce(async () => response());
	await h.run();
	assert.equal(h.requests.at(-1)?.model.id, "b");
});

function previous(details: unknown, fromHook = true): SessionEntry {
	return {
		type: "compaction",
		id: "previous",
		parentId: null,
		timestamp: "2026-01-01T00:00:00Z",
		summary: "Previous",
		firstKeptEntryId: "old-kept",
		tokensBefore: 100,
		fromHook,
		details,
	};
}

test("split turn preserves native summaries and cumulative hook file lists without mutation", async () => {
	const h = setup();
	let count = 0;
	h.produce(async () => response({ content: [{ type: "text", text: `Summary ${++count}` }] }));
	const prep = preparation({
		isSplitTurn: true,
		turnPrefixMessages: [{ role: "user", content: "Turn prefix", timestamp: 2 }],
	});
	const original = structuredClone(prep);
	const branchEntries = [
		previous({ readFiles: ["obsolete"], modifiedFiles: [] }),
		previous({ readFiles: ["old-read", "old-modified"], modifiedFiles: ["old-modified"] }),
	];
	const result = await h.run({ preparation: prep, branchEntries });
	assert.match(result?.compaction?.summary ?? "", /Summary 1[\s\S]*Turn Context[\s\S]*Summary 2/u);
	assert.deepEqual(result?.compaction?.details, {
		readFiles: ["current-read", "old-read"],
		modifiedFiles: ["old-modified"],
	});
	assert.equal(result?.compaction?.usage?.totalTokens, 30);
	assert.deepEqual(
		h.requests.map((request) => request.options?.maxTokens),
		[800, 500],
	);
	assert.match(prompt(h.requests[1].context), /Turn prefix/u);
	assert.deepEqual(prep, original);
	const next = preparation({
		fileOps: { read: new Set(["next-read"]), written: new Set(["new-file"]), edited: new Set() },
	});
	const repeated = await h.run({
		preparation: next,
		branchEntries: [previous(result?.compaction?.details)],
	});
	assert.deepEqual(repeated?.compaction?.details, {
		readFiles: ["current-read", "next-read", "old-read"],
		modifiedFiles: ["new-file", "old-modified"],
	});
	assert.deepEqual([...next.fileOps.read], ["next-read"]);
});

for (const details of [
	null,
	{ readFiles: [3], modifiedFiles: ["bad"] },
	{ readFiles: ["bad"], modifiedFiles: "bad" },
]) {
	test(`invalid previous hook details are ignored: ${JSON.stringify(details)}`, async () => {
		const h = setup();
		const result = await h.run({ branchEntries: [previous(details)] });
		assert.deepEqual(result?.compaction?.details, {
			readFiles: ["current-read"],
			modifiedFiles: [],
		});
	});
}

test("non-hook previous details are left to native preparation", async () => {
	const h = setup();
	const result = await h.run({
		branchEntries: [previous({ readFiles: ["do-not-import"], modifiedFiles: [] }, false)],
	});
	assert.deepEqual(result?.compaction?.details, { readFiles: ["current-read"], modifiedFiles: [] });
});

for (const failure of ["throw", "error", "length", "empty", "aborted", "toolCall"]) {
	test(`failed provider response is rejected before native file lists mask it: ${failure}`, async () => {
		const h = setup({ compact: ["summary/a", "summary/b"] });
		const random = vi.spyOn(Math, "random").mockReturnValue(0);
		if (failure === "throw") {
			h.registry.getProvider.mockReturnValue({
				streamSimple: () => {
					throw new Error("secret\u001b[31m");
				},
			});
		} else {
			h.produce(async () =>
				response({
					...(failure === "empty" ? { content: [{ type: "text" as const, text: " \n" }] } : {}),
					...(failure === "toolCall"
						? {
								content: [
									{ type: "text" as const, text: "Summary" },
									{ type: "toolCall" as const, id: "t", name: "read", arguments: {} },
								],
							}
						: {}),
					...(["error", "length", "aborted"].includes(failure)
						? {
								stopReason: failure as AssistantMessage["stopReason"],
								errorMessage: "secret\u001b[31m",
							}
						: {}),
				}),
			);
		}
		assert.equal(await h.run(), undefined);
		assert.equal(h.notifications.length, 1);
		assert.doesNotMatch(h.notifications[0].message, /secret/u);
		assert.equal(h.notifications[0].message.includes("\u001b"), false);
		random.mockReturnValue(0.99);
		await h.commands.get("ma")?.handler("compact", h.ctx);
		assert.equal((h.setModels[0] as Model<Api>).id, "b", "failed picks are not sticky");
	});
}

for (const emptyCall of [1, 2]) {
	test(`empty split summary ${emptyCall} cannot be masked by separators`, async () => {
		const h = setup();
		let count = 0;
		h.produce(async () =>
			response({ content: [{ type: "text", text: ++count === emptyCall ? "" : "Summary" }] }),
		);
		assert.equal(
			await h.run({
				preparation: preparation({
					isSplitTurn: true,
					turnPrefixMessages: [{ role: "user", content: "Prefix", timestamp: 1 }],
				}),
			}),
			undefined,
		);
		assert.equal(h.requests.length, emptyCall);
	});
}

test("pre-aborted operation cancels before auth", async () => {
	const h = setup();
	const controller = new AbortController();
	controller.abort();
	assert.deepEqual(await h.run({ signal: controller.signal }), { cancel: true });
	assert.equal(h.registry.getApiKeyAndHeaders.mock.calls.length, 0);
	assert.deepEqual(h.notifications, []);
});

for (const stage of ["auth", "request"] as const) {
	for (const cancel of ["signal", "shutdown", "reload", "session_start"] as const) {
		test(`${cancel} during ${stage} cancels without fallback, warning or sticky pick`, async () => {
			const h = setup({ compact: ["summary/a", "summary/b"] });
			const random = vi.spyOn(Math, "random").mockReturnValue(0);
			const auth = await h.registry.getApiKeyAndHeaders();
			const authGate = deferred<typeof auth>();
			const requestGate = deferred<AssistantMessage>();
			if (stage === "auth") h.registry.getApiKeyAndHeaders.mockReturnValue(authGate.promise);
			else h.produce(() => requestGate.promise);
			const controller = new AbortController();
			const result = h.run({ signal: controller.signal });
			if (stage === "request") await vi.waitFor(() => assert.equal(h.requests.length, 1));
			if (cancel === "signal") controller.abort();
			else if (cancel === "session_start")
				await h.events.get("session_start")?.[0]?.({ reason: "resume" }, h.ctx);
			else
				await h.events.get("session_shutdown")?.[0]?.(
					{ reason: cancel === "reload" ? "reload" : "exit" },
					h.ctx,
				);
			if (stage === "request") assert.equal(h.requests[0].options?.signal?.aborted, true);
			authGate.resolve(auth);
			requestGate.resolve(response());
			assert.deepEqual(await result, { cancel: true });
			assert.equal(h.requests.length, stage === "auth" ? 0 : 1);
			assert.deepEqual(h.notifications, []);
			assert.deepEqual(h.setModels, []);
			assert.deepEqual(h.thinkingLevels, []);
			random.mockReturnValue(0.99);
			h.registry.getApiKeyAndHeaders.mockResolvedValue(auth);
			h.produce(async () => response());
			assert.ok((await h.run())?.compaction, "next operation has fresh cancellation ownership");
			assert.equal(h.requests.at(-1)?.model.id, "b");
		});
	}
}

test("cancelled split history never starts the turn-prefix request", async () => {
	const h = setup();
	const gate = deferred<AssistantMessage>();
	h.produce(() => gate.promise);
	const controller = new AbortController();
	const result = h.run({
		signal: controller.signal,
		preparation: preparation({
			isSplitTurn: true,
			turnPrefixMessages: [{ role: "user", content: "Prefix", timestamp: 1 }],
		}),
	});
	await vi.waitFor(() => assert.equal(h.requests.length, 1));
	controller.abort();
	gate.resolve(response());
	assert.deepEqual(await result, { cancel: true });
	assert.equal(h.requests.length, 1);
	assert.deepEqual(h.notifications, []);
});

test("old finally does not clear a newer operation's shutdown ownership", async () => {
	const h = setup();
	const auth = await h.registry.getApiKeyAndHeaders();
	const oldAuth = deferred<typeof auth>();
	const newAuth = deferred<typeof auth>();
	h.registry.getApiKeyAndHeaders
		.mockReturnValueOnce(oldAuth.promise)
		.mockReturnValueOnce(newAuth.promise);
	const oldResult = h.run();
	await h.events.get("session_start")?.[0]?.({ reason: "resume" }, h.ctx);
	const newResult = h.run();
	oldAuth.resolve(auth);
	assert.deepEqual(await oldResult, { cancel: true });
	await h.events.get("session_shutdown")?.[0]?.({ reason: "reload" }, h.ctx);
	newAuth.resolve(auth);
	assert.deepEqual(await newResult, { cancel: true });
	assert.deepEqual(h.requests, []);
	assert.deepEqual(h.notifications, []);
});

test("settled operation releases shutdown ownership", async () => {
	const h = setup();
	await h.run();
	const signal = h.requests[0].options?.signal;
	await h.events.get("session_shutdown")?.[0]?.({ reason: "reload" }, h.ctx);
	assert.equal(signal?.aborted, false);
});

test("auth rejection after abort cancels rather than falling back", async () => {
	const h = setup();
	let reject!: (reason: Error) => void;
	h.registry.getApiKeyAndHeaders.mockReturnValue(
		new Promise((_resolve, fail) => {
			reject = fail;
		}),
	);
	const controller = new AbortController();
	const result = h.run({ signal: controller.signal });
	controller.abort();
	reject(new Error("secret"));
	assert.deepEqual(await result, { cancel: true });
	assert.deepEqual(h.notifications, []);
});

test("compaction leaves existing main alias rate-limit attribution intact", async () => {
	const h = setup({ main: ["summary/a", "summary/b"], compact: "summary/b" });
	vi.spyOn(Math, "random").mockReturnValue(0);
	await h.commands.get("ma")?.handler("main", h.ctx);
	(h.ctx as { model?: Model<Api> }).model = model("a");
	await h.run();
	assert.equal(h.setModels.length, 1);
	await h.events.get("after_provider_response")?.[0]?.(
		{ status: 429, headers: { "retry-after": "60" } },
		h.ctx,
	);
	assert.deepEqual(
		h.setModels.map((entry) => (entry as Model<Api>).id),
		["a", "b"],
	);
	assert.match(h.notifications.at(-1)?.message ?? "", /rate limited/u);
	assert.deepEqual(h.thinkingLevels, []);
	assert.deepEqual(JSON.parse(readFileSync(path.join(directory, "model-alias.json"), "utf8")), {
		aliases: { main: ["summary/a", "summary/b"], compact: "summary/b" },
	});
});
