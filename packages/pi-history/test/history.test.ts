import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import history from "../src/history.js";
import { historyFilePath } from "../src/store.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
	while (temporaryDirectories.length > 0) {
		const directory = temporaryDirectories.pop();
		if (directory) rmSync(directory, { force: true, recursive: true });
	}
});

function workspace(entries?: string[]): string {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-history-ext-"));
	temporaryDirectories.push(directory);
	if (entries) {
		const file = historyFilePath(directory);
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, JSON.stringify({ entries }), "utf8");
	}
	return directory;
}

const stored = (cwd: string): string[] =>
	JSON.parse(readFileSync(historyFilePath(cwd), "utf8")).entries;

type Harness = ReturnType<typeof createMockPi>;

const startSession = async (harness: Harness, ctx: unknown) =>
	harness.events.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, ctx);

const sendInput = async (harness: Harness, text: string, ctx: unknown, source = "interactive") =>
	harness.events.get("input")?.[0]?.({ type: "input", text, source }, ctx);

/** A context that records the editor factory the extension installs. */
function recordingContext(cwd: string, overrides: Record<string, unknown> = {}) {
	const created = createMockContext({ cwd, mode: "tui", hasUI: true, ...overrides });
	let factory: unknown;
	(created.ctx as { ui: Record<string, unknown> }).ui.setEditorComponent = (value: unknown) => {
		factory = value;
	};
	return {
		...created,
		get editorFactory() {
			return factory;
		},
	};
}

test("registers the history command and its event handlers", () => {
	const harness = createMockPi();
	history(harness.pi);
	assert.deepEqual([...harness.commands.keys()], ["history"]);
	assert.equal(harness.events.get("session_start")?.length, 1);
	assert.equal(harness.events.get("input")?.length, 1);
});

test("a typed prompt is appended to the project history", async () => {
	const cwd = workspace();
	const harness = createMockPi();
	history(harness.pi);
	const { ctx } = createMockContext({ cwd, hasUI: true, mode: "tui" });
	await sendInput(harness, "build the thing", ctx);
	assert.deepEqual(stored(cwd), ["build the thing"]);
});

test("the input handler passes the prompt through unchanged", async () => {
	const cwd = workspace();
	const harness = createMockPi();
	history(harness.pi);
	const { ctx } = createMockContext({ cwd, hasUI: true, mode: "tui" });
	assert.deepEqual(await sendInput(harness, "hello", ctx), { action: "continue" });
});

test("non-interactive input is not recorded", async () => {
	const cwd = workspace();
	const harness = createMockPi();
	history(harness.pi);
	const { ctx } = createMockContext({ cwd, hasUI: true, mode: "tui" });
	await sendInput(harness, "from an extension", ctx, "extension");
	await sendInput(harness, "from rpc", ctx, "rpc");
	assert.throws(() => stored(cwd));
});

test("a malformed history file warns once instead of on every prompt", async () => {
	const cwd = workspace();
	mkdirSync(path.dirname(historyFilePath(cwd)), { recursive: true });
	writeFileSync(historyFilePath(cwd), "{ broken", "utf8");
	const harness = createMockPi();
	history(harness.pi);
	const { ctx, notifications } = createMockContext({ cwd, hasUI: true, mode: "tui" });
	await sendInput(harness, "one", ctx);
	await sendInput(harness, "two", ctx);
	const warnings = notifications.filter((entry) => entry.level === "warning");
	assert.equal(warnings.length, 1);
	assert.match(warnings[0]?.message ?? "", /not recording prompts/);
	// The unreadable file is left exactly as it was found.
	assert.equal(readFileSync(historyFilePath(cwd), "utf8"), "{ broken");
});

test("session start installs an editor factory when history exists", async () => {
	const cwd = workspace(["oldest", "newest"]);
	const harness = createMockPi();
	history(harness.pi);
	const context = recordingContext(cwd);
	await startSession(harness, context.ctx);
	assert.equal(typeof context.editorFactory, "function");
});

test("no editor is installed when there is nothing to restore", async () => {
	const cwd = workspace();
	const harness = createMockPi();
	history(harness.pi);
	const context = recordingContext(cwd);
	await startSession(harness, context.ctx);
	assert.equal(context.editorFactory, undefined);
});

test("a non-TUI session never touches the editor", async () => {
	const cwd = workspace(["stored"]);
	const harness = createMockPi();
	history(harness.pi);
	const context = recordingContext(cwd, { mode: "print", hasUI: false });
	await startSession(harness, context.ctx);
	assert.equal(context.editorFactory, undefined);
});

test("a non-TUI session still records prompts", async () => {
	const cwd = workspace();
	const harness = createMockPi();
	history(harness.pi);
	const { ctx } = createMockContext({ cwd, mode: "print", hasUI: false });
	await sendInput(harness, "headless", ctx);
	assert.deepEqual(stored(cwd), ["headless"]);
});

test("prompts recorded in one session are restored in the next", async () => {
	const cwd = workspace();
	const first = createMockPi();
	history(first.pi);
	const { ctx } = createMockContext({ cwd, hasUI: true, mode: "tui" });
	await sendInput(first, "earlier prompt", ctx);

	// A fresh extension instance stands in for a brand new Pi session.
	const second = createMockPi();
	history(second.pi);
	const context = recordingContext(cwd);
	await startSession(second, context.ctx);
	assert.equal(typeof context.editorFactory, "function");
});

test("/history reports the stored count and path", async () => {
	const cwd = workspace(["a", "b"]);
	const harness = createMockPi();
	history(harness.pi);
	const { ctx, notifications } = createMockContext({ cwd, hasUI: true, mode: "tui" });
	await harness.commands.get("history")?.handler("", ctx);
	assert.match(notifications[0]?.message ?? "", /2 prompt\(s\)/);
	assert.match(notifications[0]?.message ?? "", /max 1000/);
	assert.match(notifications[0]?.message ?? "", /pi-history\.json/);
});

test("/history rejects arguments instead of ignoring them", async () => {
	const cwd = workspace();
	const harness = createMockPi();
	history(harness.pi);
	const { ctx, notifications } = createMockContext({ cwd, hasUI: true, mode: "tui" });
	await harness.commands.get("history")?.handler("clear", ctx);
	assert.equal(notifications[0]?.level, "error");
	assert.match(notifications[0]?.message ?? "", /takes no arguments/);
});

test("/history reports an unreadable file as an error", async () => {
	const cwd = workspace();
	mkdirSync(path.dirname(historyFilePath(cwd)), { recursive: true });
	writeFileSync(historyFilePath(cwd), "{ broken", "utf8");
	const harness = createMockPi();
	history(harness.pi);
	const { ctx, notifications } = createMockContext({ cwd, hasUI: true, mode: "tui" });
	await harness.commands.get("history")?.handler("", ctx);
	assert.ok(notifications.some((entry) => entry.level === "error"));
});

test("/history is silent in modes with no UI", async () => {
	const cwd = workspace(["a"]);
	const harness = createMockPi();
	history(harness.pi);
	const { ctx, notifications } = createMockContext({ cwd, mode: "print", hasUI: false });
	await harness.commands.get("history")?.handler("", ctx);
	assert.equal(notifications.length, 0);
});
