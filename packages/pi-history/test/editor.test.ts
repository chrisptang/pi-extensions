import assert from "node:assert/strict";
import { test, vi } from "vitest";

/**
 * Pi's real `CustomEditor` needs a live terminal, so the class is replaced with a
 * spy that records what the factory seeds. The base class's own history
 * semantics are Pi's and are not re-tested here; what matters is that this
 * package feeds it every stored prompt, oldest first.
 */
const constructed: Array<{ args: unknown[]; seeded: string[] }> = [];

vi.mock("@earendil-works/pi-coding-agent", () => ({
	CustomEditor: class {
		seeded: string[] = [];
		constructor(...args: unknown[]) {
			constructed.push({ args, seeded: this.seeded });
		}
		addToHistory(text: string) {
			this.seeded.push(text);
		}
	},
}));

const { createHistoryEditorFactory } = await import("../src/editor.js");

test("stored prompts are replayed oldest first", () => {
	constructed.length = 0;
	const factory = createHistoryEditorFactory(["oldest", "middle", "newest"]);
	factory({} as never, {} as never, {} as never);
	assert.deepEqual(constructed[0]?.seeded, ["oldest", "middle", "newest"]);
});

test("the editor receives Pi's tui, theme, and keybindings unchanged", () => {
	constructed.length = 0;
	const tui = { id: "tui" };
	const theme = { id: "theme" };
	const keybindings = { id: "keybindings" };
	const factory = createHistoryEditorFactory(["only"]);
	factory(tui as never, theme as never, keybindings as never);
	assert.deepEqual(constructed[0]?.args, [tui, theme, keybindings]);
});

test("an empty history still produces a usable editor", () => {
	constructed.length = 0;
	const factory = createHistoryEditorFactory([]);
	const editor = factory({} as never, {} as never, {} as never);
	assert.ok(editor);
	assert.deepEqual(constructed[0]?.seeded, []);
});
