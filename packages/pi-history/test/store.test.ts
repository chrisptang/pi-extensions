import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, test } from "vitest";

const root = mkdtempSync(path.join(os.tmpdir(), "pi-history-test-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
const { appendHistory, DEFAULT_MAX_ENTRIES, historyDatabasePath, legacyHistoryPath, loadHistory } =
	await import("../src/store.js");

afterAll(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(root, { recursive: true, force: true });
});

function workspace(name = "project", entries?: unknown): string {
	const cwd = path.join(root, String(Math.random()), name);
	mkdirSync(cwd, { recursive: true });
	if (entries !== undefined) legacy(cwd, JSON.stringify({ entries }));
	return cwd;
}

function legacy(cwd: string, contents: string): void {
	const file = legacyHistoryPath(cwd);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, contents);
}

test("missing history does not create files; first append creates only the private database", () => {
	const cwd = workspace();
	assert.deepEqual(loadHistory(cwd), { entries: [], malformed: false });
	assert.equal(existsSync(historyDatabasePath()), false);
	assert.equal(appendHistory(cwd, "   "), undefined);
	assert.equal(existsSync(historyDatabasePath()), false);
	assert.deepEqual(appendHistory(cwd, " first "), ["first"]);
	assert.equal(existsSync(legacyHistoryPath(cwd)), false);
	assert.equal(loadHistory(cwd).entries[0], "first");
	if (process.platform !== "win32") {
		assert.equal(statSync(historyDatabasePath()).mode & 0o777, 0o600);
	}
});

test("same-named projects share history; different names stay isolated", () => {
	const first = workspace("shared");
	const second = workspace("shared");
	const other = workspace("other");
	appendHistory(first, "one");
	appendHistory(second, "two");
	assert.deepEqual(loadHistory(first).entries, ["one", "two"]);
	assert.deepEqual(loadHistory(other).entries, []);
});

test("consecutive duplicates, whitespace, and retention", () => {
	const cwd = workspace("retention");
	appendHistory(cwd, "same");
	assert.equal(appendHistory(cwd, "same"), undefined);
	appendHistory(cwd, "next");
	assert.deepEqual(appendHistory(cwd, "same", 2), ["next", "same"]);
	assert.equal(appendHistory(cwd, "\t"), undefined);
	assert.equal(DEFAULT_MAX_ENTRIES, 1000);
});

test("migration also enforces the thousand-prompt cap", () => {
	const cwd = workspace(
		"import-limit",
		Array.from({ length: 1001 }, (_, i) => `p${i}`),
	);
	const entries = loadHistory(cwd).entries;
	assert.equal(entries.length, DEFAULT_MAX_ENTRIES);
	assert.equal(entries[0], "p1");
});

test("default retention keeps the newest thousand prompts", () => {
	const cwd = workspace(
		"limit",
		Array.from({ length: DEFAULT_MAX_ENTRIES }, (_, i) => `p${i}`),
	);
	const entries = appendHistory(cwd, "newest");
	assert.equal(entries?.length, DEFAULT_MAX_ENTRIES);
	assert.equal(entries?.[0], "p1");
	assert.equal(entries?.at(-1), "newest");
});

test("migrates legacy rows once and removes the original only after import", () => {
	const cwd = workspace("migration", ["old", 12, " ", "second"]);
	assert.deepEqual(loadHistory(cwd), { entries: ["old", "second"], malformed: false });
	assert.equal(existsSync(legacyHistoryPath(cwd)), false);
	assert.deepEqual(appendHistory(cwd, "new"), ["old", "second", "new"]);
	assert.deepEqual(loadHistory(cwd).entries, ["old", "second", "new"]);
});

test("same-named legacy projects each import once, without overwriting existing rows", () => {
	const a = workspace("legacy", ["a"]);
	const b = workspace("legacy", ["b"]);
	appendHistory(a, "new");
	assert.deepEqual(loadHistory(b).entries, ["a", "new", "b"]);
	assert.deepEqual(loadHistory(a).entries, ["a", "new", "b"]);
});

test("malformed legacy JSON is retained and prevents append", () => {
	const cwd = workspace("broken");
	legacy(cwd, "{ broken");
	const warnings: string[] = [];
	assert.equal(loadHistory(cwd, (message) => warnings.push(message)).malformed, true);
	assert.match(warnings[0] ?? "", /malformed/);
	assert.throws(() => appendHistory(cwd, "new"), /malformed/);
	assert.equal(readFileSync(legacyHistoryPath(cwd), "utf8"), "{ broken");
});

test("invalid legacy shape is retained", () => {
	const cwd = workspace("invalid");
	legacy(cwd, JSON.stringify({ entries: "not an array" }));
	assert.equal(loadHistory(cwd).malformed, true);
	assert.equal(existsSync(legacyHistoryPath(cwd)), true);
});

test("a failed legacy import rolls back and leaves its source untouched", () => {
	const cwd = workspace("failure", ["old"]);
	const db = new DatabaseSync(historyDatabasePath());
	try {
		db.exec(
			"CREATE TRIGGER block_import BEFORE INSERT ON entries BEGIN SELECT RAISE(FAIL, 'blocked'); END",
		);
	} finally {
		db.close();
	}
	assert.equal(loadHistory(cwd).malformed, true);
	assert.equal(existsSync(legacyHistoryPath(cwd)), true);
	const check = new DatabaseSync(historyDatabasePath());
	try {
		assert.equal(
			check.prepare("SELECT count(*) AS n FROM entries WHERE project = ?").get("failure")?.n,
			0,
		);
		check.exec("DROP TRIGGER block_import");
	} finally {
		check.close();
	}
	assert.deepEqual(loadHistory(cwd).entries, ["old"]);
});

test("an imported source left behind after a crash is not imported twice", () => {
	const cwd = workspace("retry", ["once"]);
	loadHistory(cwd);
	legacy(cwd, JSON.stringify({ entries: ["once"] }));
	assert.deepEqual(loadHistory(cwd).entries, ["once"]);
	assert.equal(existsSync(legacyHistoryPath(cwd)), false);
	legacy(cwd, JSON.stringify({ entries: ["changed"] }));
	assert.equal(loadHistory(cwd).malformed, true);
	assert.equal(existsSync(legacyHistoryPath(cwd)), true);
});
