import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";

const model = { provider: "openai", id: "test-model" };
const assistant = {
	role: "assistant",
	provider: model.provider,
	model: model.id,
	content: [],
	stopReason: "stop",
	usage: { output: 200 },
};

type FooterFactory = (
	tui: { requestRender(): void },
	theme: { fg(role: string, text: string): string },
	data: {
		getGitBranch(): null;
		getExtensionStatuses(): ReadonlyMap<string, string>;
		onBranchChange(): () => void;
	},
) => { render(width: number): string[]; dispose(): void };

async function setup(
	t: { onTestFinished(callback: () => void | Promise<void>): void },
	mode: "tui" | "rpc" | "print" | "json" = "tui",
) {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-starship-speed-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	writeFileSync(join(agentDir, "pi-starship.toml"), "format = '$speed'\n");
	vi.resetModules();
	const { default: piStarship } = await import("../src/pi-starship.js");
	let now = 0;
	const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
	const mock = createMockPi();
	piStarship(mock.pi);
	const context = createMockContext({ mode, model });
	async function emit(name: string, event = {}, ctx: ExtensionContext = context.ctx) {
		for (const handler of mock.events.get(name) ?? []) await handler(event, ctx);
	}
	await emit("session_start");
	let renders = 0;
	const footers: ReturnType<FooterFactory>[] = [];
	function mount(owner = context) {
		const footer = (owner.footer as FooterFactory)(
			{
				requestRender() {
					renders += 1;
				},
			},
			{ fg: (_role, text) => text },
			{
				getGitBranch: () => null,
				getExtensionStatuses: () => new Map(),
				onBranchChange: () => () => undefined,
			},
		);
		footers.push(footer);
		return footer;
	}
	t.onTestFinished(async () => {
		await emit("session_shutdown");
		for (const footer of footers) footer.dispose();
		clock.mockRestore();
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(agentDir, { recursive: true, force: true });
	});
	return {
		context,
		emit,
		mount,
		setTime(value: number) {
			now = value;
		},
		get renders() {
			return renders;
		},
		content: (ctx?: ExtensionContext) =>
			emit(
				"message_update",
				{
					message: assistant,
					assistantMessageEvent: { type: "text_delta", delta: "hello", partial: assistant },
				},
				ctx,
			),
	};
}

function text(footer: ReturnType<FooterFactory>): string {
	return stripVTControlCharacters(footer.render(200).join("\n")).trim();
}

test("speed footer updates on first content and final usage, resetting for each request", async (t) => {
	const runtime = await setup(t);
	const footer = runtime.mount();
	assert.equal(text(footer), "TTFT — · — tok/s");
	await runtime.emit("before_provider_request");
	runtime.setTime(500);
	await runtime.emit("after_provider_response", { status: 200 });
	await runtime.emit("provider_stream_event", { data: { type: "start" } });
	await runtime.emit("message_update", {
		message: assistant,
		assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: assistant },
	});
	for (const identity of [{ model: "other" }, { provider: "other" }]) {
		const message = { ...assistant, ...identity };
		await runtime.emit("message_update", {
			message,
			assistantMessageEvent: { type: "text_delta", delta: "ignored", partial: message },
		});
		await runtime.emit("message_end", { message });
	}
	assert.equal(text(footer), "TTFT — · — tok/s");
	const rendersBefore = runtime.renders;
	runtime.setTime(1250);
	await runtime.content();
	assert.ok(runtime.renders > rendersBefore);
	assert.equal(text(footer), "TTFT 1.25s · — tok/s");
	runtime.setTime(3000);
	await runtime.content();
	runtime.setTime(4000);
	await runtime.emit("message_end", {
		message: { ...assistant, usage: { ...assistant.usage, reasoning: 100 } },
	});
	await runtime.emit("agent_end");
	await runtime.emit("agent_settled");
	runtime.setTime(9000);
	await runtime.content();
	await runtime.emit("message_end", { message: assistant });
	assert.equal(text(footer), "TTFT 1.25s · 50.0 tok/s");
	runtime.setTime(100_000);
	await runtime.emit("before_provider_request");
	assert.equal(text(footer), "TTFT — · — tok/s");
	runtime.setTime(100_500);
	await runtime.content();
	runtime.setTime(102_000);
	await runtime.emit("message_end", { message: { ...assistant, stopReason: "toolUse" } });
	assert.equal(text(footer), "TTFT 0.50s · 100.0 tok/s");
});

test("TTFT accepts nonempty content across every normalized content event", async (t) => {
	const runtime = await setup(t);
	const footer = runtime.mount();
	for (const [type, content, delta, expected] of [
		["text_start", [{ type: "text", text: "hello" }], "", true],
		["text_delta", [], " ", true],
		["text_end", [{ type: "text", text: "hello" }], "", true],
		["thinking_start", [{ type: "thinking", thinking: "reason" }], "", true],
		["thinking_delta", [], "reason", true],
		["thinking_end", [{ type: "thinking", thinking: "reason" }], "", true],
		[
			"thinking_start",
			[{ type: "thinking", thinking: "", redacted: true, thinkingSignature: "opaque" }],
			"",
			true,
		],
		["toolcall_start", [{ type: "toolCall", id: "call", name: "read", arguments: {} }], "", true],
		["toolcall_delta", [], "{", true],
		["toolcall_end", [{ type: "toolCall", id: "call", name: "read", arguments: {} }], "", true],
		["text_start", [{ type: "text", text: "" }], "", false],
		...[
			"text_start",
			"thinking_start",
			"toolcall_start",
			"text_delta",
			"thinking_delta",
			"toolcall_delta",
			"text_end",
			"thinking_end",
		].map((type) => [type, [], "", false] as const),
	] as const) {
		runtime.setTime(0);
		await runtime.emit("before_provider_request");
		runtime.setTime(500);
		const partial = { ...assistant, content };
		await runtime.emit("message_update", {
			message: partial,
			assistantMessageEvent: { type, contentIndex: 0, partial, delta },
		});
		assert.equal(text(footer), expected ? "TTFT 0.50s · — tok/s" : "TTFT — · — tok/s", type);
	}
});

test("completion status and usage determine whether throughput is available", async (t) => {
	const runtime = await setup(t);
	const footer = runtime.mount();
	for (const [stopReason, output, duration, expected] of [
		...["error", "aborted", "pending", "deferred"].map(
			(reason) => [reason, 200, 1000, "TTFT — · — tok/s"] as const,
		),
		...[undefined, -1, Number.NaN, Number.POSITIVE_INFINITY].map(
			(output) => ["stop", output, 1000, "TTFT 0.00s · — tok/s"] as const,
		),
		["stop", 200, 0, "TTFT 0.00s · — tok/s"],
		["stop", 0, 1000, "TTFT 0.00s · 0.0 tok/s"],
		["length", 200, 1000, "TTFT 0.00s · 200.0 tok/s"],
	] as const) {
		runtime.setTime(0);
		await runtime.emit("before_provider_request");
		await runtime.content();
		runtime.setTime(duration);
		await runtime.emit("message_end", { message: { ...assistant, stopReason, usage: { output } } });
		await runtime.emit("agent_settled");
		assert.equal(text(footer), expected);
	}
	runtime.setTime(0);
	await runtime.emit("before_provider_request");
	runtime.setTime(1000);
	await runtime.emit("message_end", { message: assistant });
	assert.equal(text(footer), "TTFT — · 200.0 tok/s");
});

test("model changes, cancellation, tree navigation and footer disposal clear speed", async (t) => {
	const runtime = await setup(t);
	let footer = runtime.mount();
	await runtime.emit("before_provider_request");
	runtime.setTime(500);
	await runtime.content();
	await runtime.emit("model_select", { model: { ...model, id: "other" } });
	await runtime.emit("message_end", { message: assistant });
	assert.equal(text(footer), "TTFT — · — tok/s");
	await runtime.emit("before_provider_request");
	runtime.setTime(1000);
	await runtime.content();
	await runtime.emit("agent_settled");
	assert.equal(text(footer), "TTFT — · — tok/s");
	await runtime.emit("before_provider_request");
	runtime.setTime(1500);
	await runtime.content();
	await runtime.emit("session_tree");
	footer.dispose();
	footer = runtime.mount();
	assert.equal(text(footer), "TTFT — · — tok/s");
	await runtime.emit("before_provider_request");
	runtime.setTime(2000);
	await runtime.content();
	footer.dispose();
	await runtime.emit("message_end", { message: assistant });
	assert.equal(text(footer), "TTFT — · — tok/s");
});

test("session replacement rejects all late speed events from the previous session", async (t) => {
	const runtime = await setup(t);
	const oldFooter = runtime.mount();
	await runtime.emit("before_provider_request");
	runtime.setTime(500);
	await runtime.content();
	const next = createMockContext({ mode: "tui", model });
	await runtime.emit("session_start", {}, next.ctx);
	const nextFooter = runtime.mount(next);
	oldFooter.dispose();
	await runtime.emit("before_provider_request", {}, next.ctx);
	await runtime.emit("before_provider_request");
	await runtime.content();
	await runtime.emit("message_end", { message: assistant });
	await runtime.emit("model_select");
	await runtime.emit("agent_settled");
	await runtime.emit("session_shutdown");
	assert.equal(text(nextFooter), "TTFT — · — tok/s");
	runtime.setTime(1000);
	await runtime.content(next.ctx);
	runtime.setTime(2500);
	await runtime.emit("message_end", { message: assistant }, next.ctx);
	assert.equal(text(nextFooter), "TTFT 0.50s · 100.0 tok/s");
	await runtime.emit("session_shutdown", {}, next.ctx);
	assert.equal(next.footer, undefined);
});

for (const mode of ["print", "json", "rpc"] as const) {
	test(`speed events install no footer or notifications in ${mode} mode`, async (t) => {
		const runtime = await setup(t, mode);
		await runtime.emit("before_provider_request");
		runtime.setTime(1000);
		await runtime.content();
		runtime.setTime(4000);
		await runtime.emit("message_end", { message: assistant });
		assert.equal(runtime.context.footer, undefined);
		assert.deepEqual(runtime.context.notifications, []);
		await runtime.emit("session_shutdown");
	});
}
