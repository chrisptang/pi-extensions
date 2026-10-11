import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { DatabaseSync } from "../src/storage/sqlite.js";

test("SQLite statements normalize missing rows and preserve positional values", () => {
	const database = new DatabaseSync(":memory:");
	try {
		database.exec("CREATE TABLE entries (id INTEGER PRIMARY KEY, prompt TEXT, rank REAL)");
		const select = database.prepare("SELECT prompt, rank FROM entries WHERE id = ?");
		assert.equal(select.get(1), undefined);
		assert.deepEqual(select.all(1), []);
		const insert = database.prepare("INSERT INTO entries VALUES (?, ?, ?)");
		assert.equal(insert.run(1, "hello", 1.5), undefined);
		insert.run(2, null, 0);
		assert.deepEqual({ ...select.get(1) }, { prompt: "hello", rank: 1.5 });
		assert.deepEqual({ ...select.get(2) }, { prompt: null, rank: 0 });
	} finally {
		database.close();
	}
});

test("SQLite preserves the busy timeout and Node's default foreign-key enforcement", () => {
	const database = new DatabaseSync(":memory:", { timeout: 123 });
	try {
		assert.equal(database.prepare("PRAGMA busy_timeout").get()?.timeout, 123);
		assert.equal(database.prepare("PRAGMA foreign_keys").get()?.foreign_keys, 1);
		database.exec(`
			CREATE TABLE parent (id INTEGER PRIMARY KEY);
			CREATE TABLE child (parent_id INTEGER REFERENCES parent(id) ON DELETE CASCADE);
			INSERT INTO parent VALUES (1);
			INSERT INTO child VALUES (1);
		`);
		assert.throws(() => database.prepare("INSERT INTO child VALUES (?)").run(2), /FOREIGN KEY/i);
		database.prepare("DELETE FROM parent WHERE id = ?").run(1);
		assert.deepEqual(database.prepare("SELECT * FROM child").all(), []);
	} finally {
		database.close();
	}
});

test("SQLite executes statement batches and rolls back explicit and uncommitted transactions", () => {
	const directory = mkdtempSync(path.join(tmpdir(), "pi-analytics-sqlite-"));
	const file = path.join(directory, "test.db");
	try {
		const database = new DatabaseSync(file);
		try {
			assert.equal(database.prepare("PRAGMA busy_timeout").get()?.timeout, 0);
			database.exec(
				"CREATE TABLE entries (id INTEGER); BEGIN; INSERT INTO entries VALUES (1); COMMIT;",
			);
			database.exec("BEGIN IMMEDIATE; INSERT INTO entries VALUES (2); ROLLBACK;");
			assert.deepEqual(
				database
					.prepare("SELECT id FROM entries")
					.all()
					.map((row) => row.id),
				[1],
			);
			database.exec("BEGIN IMMEDIATE; INSERT INTO entries VALUES (3);");
		} finally {
			database.close();
		}
		const reopened = new DatabaseSync(file);
		try {
			assert.deepEqual(
				reopened
					.prepare("SELECT id FROM entries")
					.all()
					.map((row) => row.id),
				[1],
			);
		} finally {
			reopened.close();
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
