import assert from "node:assert/strict";
import fs from "node:fs";
import { dirname, join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	type BeforeAgentStartEvent,
	type BuildSystemPromptOptions,
	createExtensionRuntime,
	type Extension,
	type ExtensionAPI,
	type ExtensionContext,
	ExtensionRunner,
	getAgentDir,
	type ModelRegistry,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { describe, it, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import gptDiscipline, {
	GPT_DISCIPLINE_RULES,
	isGptModel,
	SECTION_NAME,
} from "../src/gpt-discipline.js";

function emitBeforeAgentStart(
	mock: ReturnType<typeof createMockPi>,
	event: BeforeAgentStartEvent,
	ctx: ExtensionContext,
) {
	const handlers = mock.events.get("before_agent_start") ?? [];
	for (const handler of handlers) {
		handler(event, ctx);
	}
}

describe("pi-gpt-discipline", () => {
	describe("isGptModel", () => {
		it("detects GPT-family models", () => {
			assert.equal(isGptModel("gpt-6.1-sol"), true);
			assert.equal(isGptModel("gpt-6.1-sol(xhigh)"), true);
			assert.equal(isGptModel("gpt-5.6-sol"), true);
			assert.equal(isGptModel("gpt-5.6-terra(xhigh)"), true);
			assert.equal(isGptModel("gpt-4o"), true);
			assert.equal(isGptModel("openai/gpt-4.5-preview"), true);
			assert.equal(isGptModel("omen-alpha"), true);
		});

		it("rejects non-GPT models", () => {
			assert.equal(isGptModel("claude-opus-5-5"), false);
			assert.equal(isGptModel("claude-sonnet-5.5"), false);
			assert.equal(isGptModel("deepseek-v4-pro"), false);
			assert.equal(isGptModel("devin/swe-2"), false);
			assert.equal(isGptModel("gemini-3.8-flash-high"), false);
			assert.equal(isGptModel(undefined), false);
			assert.equal(isGptModel(""), false);
		});
	});

	describe("effective prompt through Pi's runner", () => {
		for (const scenario of [
			"structured",
			"earlier override",
			"later override",
			"forced",
			"empty forced",
		]) {
			it(`preserves discipline and ordinary-turn stability with ${scenario} prompts`, async () => {
				const mock = createMockPi();
				const pi = mock.pi as ExtensionAPI;
				const appendInstructions = () =>
					pi.on("before_agent_start", (event) => ({
						systemPrompt: `${event.systemPrompt}\n\nadditional instructions`,
					}));
				if (scenario === "earlier override") appendInstructions();
				gptDiscipline(mock.pi);
				if (scenario === "later override") appendInstructions();

				let rendered = "";
				pi.on("before_agent_start", (event) => {
					rendered = event.systemPrompt;
				});
				const ctx = createMockContext().ctx as ExtensionContext;
				const runner = new ExtensionRunner(
					[
						{
							path: "test",
							resolvedPath: "test",
							sourceInfo: { path: "test", source: "test", scope: "temporary", origin: "top-level" },
							handlers: mock.events as Extension["handlers"],
							tools: new Map(),
							commands: new Map(),
							flags: new Map(),
							shortcuts: new Map(),
							messageRenderers: new Map(),
						},
					],
					createExtensionRuntime(),
					"/test",
					SessionManager.inMemory("/test"),
					{} as ModelRegistry,
				);
				vi.spyOn(runner, "createContext").mockReturnValue(ctx);
				const errors: unknown[] = [];
				runner.onError((error) => errors.push(error));
				const options: BuildSystemPromptOptions = {
					cwd: "/test",
					selectedTools: ["read"],
					sections: { existing: "existing instructions" },
					...(scenario === "forced" ? { forceSystemPrompt: "custom instructions" } : {}),
					...(scenario === "empty forced" ? { forceSystemPrompt: "" } : {}),
				};
				try {
					let firstGptPrompt: string | undefined;
					for (const id of ["gpt-6.1-sol(xhigh)", "claude-opus-5-5", "gpt-6.1-sol(xhigh)"]) {
						ctx.model = { id, provider: "local" } as Model<Api>;
						const result = await runner.emitBeforeAgentStart("test", undefined, options);
						assert.deepEqual(errors, []);
						assert.deepEqual(result.systemPromptOptions.selectedTools, ["read"]);
						assert.equal(result.systemPromptOptions.sections.existing, "existing instructions");
						assert.equal(rendered.split("<gpt_discipline>").length - 1, isGptModel(id) ? 1 : 0);
						if (isGptModel(id)) {
							assert.ok(rendered.includes(GPT_DISCIPLINE_RULES));
							firstGptPrompt ??= rendered;
							assert.equal(rendered, firstGptPrompt);
						}
						if (scenario.includes("override"))
							assert.ok(rendered.includes("additional instructions"));
						if (scenario === "forced") assert.ok(rendered.startsWith("custom instructions"));
						if (scenario === "empty forced" && !isGptModel(id)) assert.equal(rendered, "");
						const previous = rendered;
						await runner.emitBeforeAgentStart("next ordinary turn", undefined, options);
						assert.equal(rendered, previous);
					}
				} finally {
					runner.invalidate();
				}
			});
		}
	});

	for (const mode of ["rpc", "json"] as const) {
		it(`reports prompt read failures in ${mode} mode without writing stdout`, () => {
			const userFile = join(getAgentDir(), "system-prompts", "gpt-discipline.md");
			const read = fs.readFileSync;
			vi.spyOn(fs, "readFileSync").mockImplementation((...args: Parameters<typeof read>) => {
				if (args[0] === userFile) throw Object.assign(new Error("denied"), { code: "EACCES" });
				return read(...args);
			});
			const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
			const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
			const mock = createMockPi();
			gptDiscipline(mock.pi);
			const context = createMockContext({ mode });
			for (const handler of mock.events.get("session_start") ?? []) {
				handler({ type: "session_start", reason: "startup" }, context.ctx);
			}
			assert.equal(stdout.mock.calls.length, 0);
			assert.equal(stderr.mock.calls.length, mode === "json" ? 1 : 0);
			assert.equal(context.notifications.length, mode === "rpc" ? 1 : 0);
			if (mode === "rpc") assert.equal(context.notifications[0]?.level, "warning");
		});
	}

	it("loads custom rules at session start and refreshes them only at the next session start", () => {
		const agentDir = fs.mkdtempSync(join(getAgentDir(), "gpt-prompts-"));
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		const userFile = join(agentDir, "system-prompts", "gpt-discipline.md");
		const mock = createMockPi();
		gptDiscipline(mock.pi);
		const ctx = createMockContext({
			model: { id: "gpt-4o", provider: "local" } as Model<Api>,
		}).ctx as ExtensionContext;
		const start = () => {
			for (const handler of mock.events.get("session_start") ?? []) {
				handler({ type: "session_start", reason: "resume" }, ctx);
			}
		};
		const event = {
			type: "before_agent_start",
			messageType: "user",
			prompt: "test",
			systemPromptOptions: { cwd: ctx.cwd, sections: {}, forceSystemPrompt: "keep this" },
		} as unknown as BeforeAgentStartEvent;
		try {
			fs.mkdirSync(dirname(userFile), { recursive: true });
			fs.writeFileSync(userFile, "first custom rules");
			start();
			emitBeforeAgentStart(mock, event, ctx);
			assert.equal(event.systemPromptOptions.sections[SECTION_NAME], "first custom rules");
			const first = event.systemPromptOptions.forceSystemPrompt;
			assert.ok(first?.includes("first custom rules"));
			assert.ok(!first?.includes(GPT_DISCIPLINE_RULES));

			fs.writeFileSync(userFile, "updated custom rules");
			emitBeforeAgentStart(mock, event, ctx);
			assert.equal(event.systemPromptOptions.forceSystemPrompt, first);
			start();
			emitBeforeAgentStart(mock, event, ctx);
			assert.equal(event.systemPromptOptions.sections[SECTION_NAME], "updated custom rules");
			assert.ok(!event.systemPromptOptions.forceSystemPrompt?.includes("first custom rules"));
			assert.ok(event.systemPromptOptions.forceSystemPrompt?.includes("updated custom rules"));

			ctx.model = { id: "claude-opus-5-5", provider: "anthropic" } as Model<Api>;
			emitBeforeAgentStart(mock, event, ctx);
			assert.equal(event.systemPromptOptions.forceSystemPrompt, "keep this");
			fs.unlinkSync(userFile);
			start();
			ctx.model = { id: "gpt-4o", provider: "local" } as Model<Api>;
			emitBeforeAgentStart(mock, event, ctx);
			assert.equal(event.systemPromptOptions.sections[SECTION_NAME], GPT_DISCIPLINE_RULES);
		} finally {
			vi.unstubAllEnvs();
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	describe("lifecycle hook before_agent_start", () => {
		it("injects gpt_discipline section when GPT model is active", () => {
			const mock = createMockPi();
			gptDiscipline(mock.pi);

			const mockModel = {
				id: "gpt-6.1-sol(xhigh)",
				provider: "local",
			} as unknown as Model<Api>;

			const { ctx } = createMockContext({ model: mockModel });
			const event = {
				type: "before_agent_start",
				messageType: "user",
				prompt: "Fix bug",
				images: [],
				systemPromptOptions: {
					cwd: "/test",
					sections: {
						existing: "some instructions",
					},
				},
			} as unknown as BeforeAgentStartEvent;

			emitBeforeAgentStart(mock, event, ctx);

			assert.equal(event.systemPromptOptions.sections?.[SECTION_NAME], GPT_DISCIPLINE_RULES);
			assert.equal(event.systemPromptOptions.sections?.existing, "some instructions");
		});

		it("removes gpt_discipline section when switching to Claude Opus", () => {
			const mock = createMockPi();
			gptDiscipline(mock.pi);

			const opusModel = {
				id: "claude-opus-5-5",
				provider: "anthropic",
			} as unknown as Model<Api>;

			const { ctx } = createMockContext({ model: opusModel });
			const event = {
				type: "before_agent_start",
				messageType: "user",
				prompt: "Write code",
				images: [],
				systemPromptOptions: {
					cwd: "/test",
					sections: {
						[SECTION_NAME]: GPT_DISCIPLINE_RULES,
						opus_guidance: "be thoughtful",
					},
				},
			} as unknown as BeforeAgentStartEvent;

			emitBeforeAgentStart(mock, event, ctx);

			assert.equal(event.systemPromptOptions.sections?.[SECTION_NAME], undefined);
			assert.equal(event.systemPromptOptions.sections?.opus_guidance, "be thoughtful");
		});

		it("deduplicates its forced-prompt block and removes only that block on a model switch", () => {
			const mock = createMockPi();
			gptDiscipline(mock.pi);
			const ctx = createMockContext({
				model: { id: "gpt-4o", provider: "local" } as Model<Api>,
			}).ctx as ExtensionContext;
			const original = "custom instructions\n\n<other_section>keep this</other_section>\n";
			const event = {
				type: "before_agent_start",
				messageType: "user",
				prompt: "test",
				systemPromptOptions: { cwd: "/test", sections: {}, forceSystemPrompt: original },
			} as unknown as BeforeAgentStartEvent;
			emitBeforeAgentStart(mock, event, ctx);
			const injected = event.systemPromptOptions.forceSystemPrompt;
			assert.ok(injected?.includes(GPT_DISCIPLINE_RULES));
			emitBeforeAgentStart(mock, event, ctx);
			assert.equal(event.systemPromptOptions.forceSystemPrompt, injected);
			ctx.model = { id: "claude-opus-5-5", provider: "anthropic" } as Model<Api>;
			emitBeforeAgentStart(mock, event, ctx);
			assert.equal(event.systemPromptOptions.forceSystemPrompt, original);
			assert.equal(event.systemPromptOptions.sections[SECTION_NAME], undefined);
		});

		it("initializes sections object if undefined", () => {
			const mock = createMockPi();
			gptDiscipline(mock.pi);

			const gptModel = {
				id: "gpt-5.6-sol",
				provider: "local",
			} as unknown as Model<Api>;

			const { ctx } = createMockContext({ model: gptModel });
			const event = {
				type: "before_agent_start",
				messageType: "user",
				prompt: "Refactor",
				images: [],
				systemPromptOptions: {
					cwd: "/test",
				},
			} as unknown as BeforeAgentStartEvent;

			emitBeforeAgentStart(mock, event, ctx);

			assert.equal(event.systemPromptOptions.sections?.[SECTION_NAME], GPT_DISCIPLINE_RULES);
		});
	});
});
