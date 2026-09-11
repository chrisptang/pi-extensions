import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "vitest";
import { appendHistory, DEFAULT_MAX_ENTRIES, historyFilePath, loadHistory } from "../src/store.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
	while (temporaryDirectories.length > 0) {
		const directory = temporaryDirectories.pop();
		if (directory) rmSync(directory, { force: true, recursive: true });
	}
});

/** A workspace directory, optionally seeded with raw history file contents. */
function workspace(contents?: string): string {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-history-"));
	temporaryDirectories.push(directory);
	if (contents !== undefined) {
		const file = historyFilePath(directory);
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, contents, "utf8");
	}
	return directory;
}

const stored = (cwd: string): string[] =>
	JSON.parse(readFileSync(historyFilePath(cwd), "utf8")).entries;

test("history lives under the project config directory", () => {
	assert.equal(
		historyFilePath("/tmp/project"),
		path.join("/tmp/project", ".pi", "pi-history.json"),
	);
});

test("a missing file loads as empty without creating anything", () => {
	const cwd = workspace();
	assert.deepEqual(loadHistory(cwd), { entries: [], malformed: false });
	assert.equal(existsSync(path.join(cwd, ".pi")), false);
});

test("entries load oldest first", () => {
	const cwd = workspace(JSON.stringify({ entries: ["first", "second"] }));
	assert.deepEqual(loadHistory(cwd).entries, ["first", "second"]);
});

test("malformed JSON is reported and never overwritten", () => {
	const cwd = workspace("{ not json");
	const warnings: string[] = [];
	assert.deepEqual(
		loadHistory(cwd, (message) => warnings.push(message)),
		{
			entries: [],
			malformed: true,
		},
	);
	assert.equal(warnings.length, 1);
	assert.throws(() => appendHistory(cwd, "hello"), /refusing to overwrite/);
	assert.equal(readFileSync(historyFilePath(cwd), "utf8"), "{ not json");
});

test("a non-object document is rejected rather than treated as empty", () => {
	const cwd = workspace(JSON.stringify(["a", "b"]));
	assert.equal(loadHistory(cwd).malformed, true);
});

test("a non-array entries field is rejected", () => {
	const cwd = workspace(JSON.stringify({ entries: "nope" }));
	assert.equal(loadHistory(cwd).malformed, true);
});

test("individual unusable rows are dropped without losing the file", () => {
	const cwd = workspace(JSON.stringify({ entries: ["keep", 42, "  ", null, "also"] }));
	const loaded = loadHistory(cwd);
	assert.equal(loaded.malformed, false);
	assert.deepEqual(loaded.entries, ["keep", "also"]);
});

test("appending creates the file and stores the prompt", () => {
	const cwd = workspace();
	assert.deepEqual(appendHistory(cwd, "first prompt"), ["first prompt"]);
	assert.deepEqual(stored(cwd), ["first prompt"]);
});

test("prompts are trimmed and blank input is ignored", () => {
	const cwd = workspace();
	assert.equal(appendHistory(cwd, "   "), undefined);
	assert.equal(appendHistory(cwd, "\n\t"), undefined);
	assert.equal(existsSync(historyFilePath(cwd)), false);
	appendHistory(cwd, "  padded  ");
	assert.deepEqual(stored(cwd), ["padded"]);
});

test("a consecutive duplicate is skipped but a repeat after another prompt is kept", () => {
	const cwd = workspace();
	appendHistory(cwd, "same");
	assert.equal(appendHistory(cwd, "same"), undefined);
	assert.deepEqual(stored(cwd), ["same"]);
	appendHistory(cwd, "other");
	appendHistory(cwd, "same");
	assert.deepEqual(stored(cwd), ["same", "other", "same"]);
});

test("the oldest entry is dropped once the cap is exceeded", () => {
	const cwd = workspace();
	for (const prompt of ["a", "b", "c", "d"]) appendHistory(cwd, prompt, 3);
	assert.deepEqual(stored(cwd), ["b", "c", "d"]);
});

test("an over-long existing file is trimmed back to the cap on the next append", () => {
	const existing = Array.from({ length: 8 }, (_value, index) => `p${index}`);
	const cwd = workspace(JSON.stringify({ entries: existing }));
	appendHistory(cwd, "new", 3);
	assert.deepEqual(stored(cwd), ["p6", "p7", "new"]);
});

test("the default cap keeps one thousand entries", () => {
	const existing = Array.from({ length: DEFAULT_MAX_ENTRIES }, (_value, index) => `p${index}`);
	const cwd = workspace(JSON.stringify({ entries: existing }));
	const written = appendHistory(cwd, "newest");
	assert.equal(written?.length, DEFAULT_MAX_ENTRIES);
	assert.equal(written?.[DEFAULT_MAX_ENTRIES - 1], "newest");
	assert.equal(written?.[0], "p1");
});

test("appending re-reads the file so a concurrent writer's entries survive", () => {
	const cwd = workspace();
	appendHistory(cwd, "mine");
	// Simulate another Pi process in the same workspace appending meanwhile.
	writeFileSync(historyFilePath(cwd), JSON.stringify({ entries: ["mine", "theirs"] }), "utf8");
	appendHistory(cwd, "later");
	assert.deepEqual(stored(cwd), ["mine", "theirs", "later"]);
});

test("no temporary files are left behind", () => {
	const cwd = workspace();
	appendHistory(cwd, "one");
	appendHistory(cwd, "two");
	assert.deepEqual(readdirSync(path.join(cwd, ".pi")), ["pi-history.json"]);
});
