import type { FileOperations } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import compactionPrompt from "../src/compaction-prompt.js";
import type { PromptResolution } from "../src/prompt-file.js";

type SummaryCall = {
	messages: unknown[];
	reserveTokens: number;
	apiKey: string | undefined;
	headers: Record<string, string> | undefined;
	instructions: string | undefined;
	previousSummary: string | undefined;
	baseUrl: string | undefined;
};

function fileOps(overrides: Partial<Record<keyof FileOperations, string[]>> = {}): FileOperations {
	return {
		read: new Set(overrides.read ?? []),
		written: new Set(overrides.written ?? []),
		edited: new Set(overrides.edited ?? []),
	};
}

function preparation(overrides: Record<string, unknown> = {}) {
	return {
		firstKeptEntryId: "entry-9",
		messagesToSummarize: [{ role: "user", content: "earlier work" }],
		turnPrefixMessages: [],
		isSplitTurn: false,
		tokensBefore: 120_000,
		fileOps: fileOps(),
		settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
		...overrides,
	};
}

function compactEvent(overrides: Record<string, unknown> = {}) {
	return {
		type: "session_before_compact",
		preparation: preparation(),
		branchEntries: [],
		reason: "threshold",
		willRetry: false,
		signal: new AbortController().signal,
		...overrides,
	};
}

function setup(
	options: {
		resolution?: PromptResolution;
		summary?: string;
		summaryError?: Error;
		model?: unknown;
		auth?: unknown;
		ctxOverrides?: Record<string, unknown>;
	} = {},
) {
	const calls: SummaryCall[] = [];
	const mock = createMockPi();
	const resolution: PromptResolution =
		options.resolution ??
		({
			prompt: { scope: "user", path: "/agent/compaction.md", text: "Preserve user wording." },
			errors: [],
		} satisfies PromptResolution);

	compactionPrompt(mock.pi, {
		resolvePrompt: () => resolution,
		generateSummary: (async (
			messages: unknown[],
			model: { baseUrl?: string },
			reserveTokens: number,
			apiKey: string | undefined,
			headers: Record<string, string> | undefined,
			_signal: unknown,
			instructions: string | undefined,
			previousSummary: string | undefined,
		) => {
			calls.push({
				messages,
				reserveTokens,
				apiKey,
				headers,
				instructions,
				previousSummary,
				baseUrl: model.baseUrl,
			});
			if (options.summaryError) throw options.summaryError;
			return {
				text: options.summary ?? "## Goal\nShip it.",
				usage: { input: 10, output: 5, totalTokens: 15 },
			};
		}) as never,
	});

	const mockCtx = createMockContext({
		mode: "tui",
		hasUI: true,
		model:
			options.model === undefined
				? { provider: "anthropic", id: "claude-sonnet-5", maxTokens: 8192 }
				: options.model,
		modelRegistry: {
			getApiKeyAndHeaders: async () =>
				options.auth ?? { ok: true, apiKey: "key-1", headers: { "x-a": "1" } },
		},
		thinkingLevel: "off",
		...options.ctxOverrides,
	});

	const handler = mock.events.get("session_before_compact")?.[0];
	if (!handler) throw new Error("session_before_compact handler was not registered");
	return { calls, ctx: mockCtx.ctx, notifications: mockCtx.notifications, handler };
}

describe("session_before_compact", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	test("injects the configured prompt as the summarization instructions", async () => {
		const { calls, handler, ctx } = setup();

		const result = (await handler(compactEvent(), ctx)) as { compaction: { summary: string } };

		expect(calls).toHaveLength(1);
		expect(calls[0]?.instructions).toBe("Preserve user wording.");
		expect(result.compaction.summary).toBe("## Goal\nShip it.");
	});

	test("appends /compact instructions after the configured prompt", async () => {
		const { calls, handler, ctx } = setup();

		await handler(compactEvent({ customInstructions: "Focus on the auth bug." }), ctx);

		expect(calls[0]?.instructions).toBe("Preserve user wording.\n\nFocus on the auth bug.");
	});

	test("returns the compaction boundary and token count from the preparation", async () => {
		const { handler, ctx } = setup();

		const result = (await handler(compactEvent(), ctx)) as {
			compaction: { firstKeptEntryId: string; tokensBefore: number; usage: unknown };
		};

		expect(result.compaction.firstKeptEntryId).toBe("entry-9");
		expect(result.compaction.tokensBefore).toBe(120_000);
		expect(result.compaction.usage).toEqual({ input: 10, output: 5, totalTokens: 15 });
	});

	test("passes the reserve token budget and previous summary through to Pi", async () => {
		const { calls, handler, ctx } = setup();

		await handler(
			compactEvent({ preparation: preparation({ previousSummary: "## Goal\nEarlier." }) }),
			ctx,
		);

		expect(calls[0]?.reserveTokens).toBe(16_384);
		expect(calls[0]?.previousSummary).toBe("## Goal\nEarlier.");
	});

	test("appends the deterministic file lists to the summary", async () => {
		const { handler, ctx } = setup();

		const result = (await handler(
			compactEvent({
				preparation: preparation({
					fileOps: fileOps({
						read: ["src/read-only.ts", "src/edited.ts"],
						edited: ["src/edited.ts"],
						written: ["src/new.ts"],
					}),
				}),
			}),
			ctx,
		)) as { compaction: { summary: string; details: unknown } };

		expect(result.compaction.summary).toBe(
			"## Goal\nShip it.\n\n<read-files>\nsrc/read-only.ts\n</read-files>\n\n<modified-files>\nsrc/edited.ts\nsrc/new.ts\n</modified-files>",
		);
		expect(result.compaction.details).toEqual({
			readFiles: ["src/read-only.ts"],
			modifiedFiles: ["src/edited.ts", "src/new.ts"],
		});
	});

	test("summarizes the split-turn prefix together with the history", async () => {
		const { calls, handler, ctx } = setup();

		await handler(
			compactEvent({
				preparation: preparation({
					messagesToSummarize: [{ role: "user", content: "history" }],
					turnPrefixMessages: [{ role: "user", content: "prefix" }],
					isSplitTurn: true,
				}),
			}),
			ctx,
		);

		expect(calls[0]?.messages).toEqual([
			{ role: "user", content: "history" },
			{ role: "user", content: "prefix" },
		]);
	});

	test("drops headers marked for deletion and applies the resolved base URL", async () => {
		const { calls, handler, ctx } = setup({
			auth: {
				ok: true,
				apiKey: "key-1",
				headers: { keep: "yes", remove: null },
				baseUrl: "https://proxy.example",
			},
		});

		await handler(compactEvent(), ctx);

		expect(calls[0]?.headers).toEqual({ keep: "yes" });
		expect(calls[0]?.baseUrl).toBe("https://proxy.example");
	});

	test("defers to Pi's default compaction when no prompt file is configured", async () => {
		const { calls, handler, ctx } = setup({ resolution: { errors: [] } });

		const result = await handler(compactEvent({ customInstructions: "Focus here." }), ctx);

		expect(result).toBeUndefined();
		expect(calls).toHaveLength(0);
	});

	test("reports a prompt read failure and defers to Pi's default compaction", async () => {
		const { handler, ctx, notifications } = setup({
			resolution: { errors: ["Could not read /agent/compaction.md: EACCES"] },
		});

		const result = await handler(compactEvent(), ctx);

		expect(result).toBeUndefined();
		expect(notifications.map((entry) => entry.message)).toContain(
			"Could not read /agent/compaction.md: EACCES",
		);
	});

	test("defers to Pi's default compaction when the session has no model", async () => {
		const { calls, handler, ctx, notifications } = setup({ model: null });

		const result = await handler(compactEvent(), ctx);

		expect(result).toBeUndefined();
		expect(calls).toHaveLength(0);
		expect(notifications.map((entry) => entry.message)).toContain(
			"No active model for compaction; using Pi's default summary.",
		);
	});

	test("defers to Pi's default compaction when credentials cannot be resolved", async () => {
		const { calls, handler, ctx, notifications } = setup({
			auth: { ok: false, error: "no api key" },
		});

		const result = await handler(compactEvent(), ctx);

		expect(result).toBeUndefined();
		expect(calls).toHaveLength(0);
		expect(notifications.map((entry) => entry.message)).toContain(
			"Could not resolve credentials (no api key); using Pi's default summary.",
		);
	});

	test("defers to Pi's default compaction when summarization fails", async () => {
		const { handler, ctx, notifications } = setup({ summaryError: new Error("stream dropped") });

		const result = await handler(compactEvent(), ctx);

		expect(result).toBeUndefined();
		expect(notifications.map((entry) => entry.message)).toContain(
			"Compaction prompt failed (stream dropped); using Pi's default summary.",
		);
	});

	test("defers to Pi's default compaction when the summary is empty", async () => {
		const { handler, ctx, notifications } = setup({ summary: "   \n  " });

		const result = await handler(compactEvent(), ctx);

		expect(result).toBeUndefined();
		expect(notifications.map((entry) => entry.message)).toContain(
			"Compaction prompt produced an empty summary; using Pi's default summary.",
		);
	});

	test("stays silent and returns nothing once the compaction is aborted", async () => {
		const controller = new AbortController();
		const { handler, ctx, notifications } = setup({ summaryError: new Error("aborted") });

		const before = notifications.length;
		controller.abort();
		const result = await handler(compactEvent({ signal: controller.signal }), ctx);

		expect(result).toBeUndefined();
		expect(notifications.length).toBe(before);
	});

	test("summarizes nothing when the span has no messages", async () => {
		const { calls, handler, ctx } = setup();

		const result = await handler(
			compactEvent({
				preparation: preparation({ messagesToSummarize: [], turnPrefixMessages: [] }),
			}),
			ctx,
		);

		expect(result).toBeUndefined();
		expect(calls).toHaveLength(0);
	});
});
