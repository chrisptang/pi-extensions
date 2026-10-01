import { createHash } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export const DEFAULT_MAX_ENTRIES = 1000;

export function historyDatabasePath(): string {
	return join(getAgentDir(), "pi-history.db");
}

export function legacyHistoryPath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "pi-history.json");
}

function projectName(cwd: string): string {
	return basename(resolve(cwd));
}

function openDatabase(): DatabaseSync {
	const path = historyDatabasePath();
	mkdirSync(getAgentDir(), { recursive: true });
	try {
		closeSync(openSync(path, "wx", 0o600));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	const db = new DatabaseSync(path, { timeout: 5000 });
	try {
		chmodSync(path, 0o600);
		db.exec(`CREATE TABLE IF NOT EXISTS entries (
			id INTEGER PRIMARY KEY, project TEXT NOT NULL, prompt TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS entries_project_id ON entries(project, id);
		CREATE TABLE IF NOT EXISTS migrated (source TEXT PRIMARY KEY, digest TEXT NOT NULL);`);
		return db;
	} catch (error) {
		db.close();
		throw error;
	}
}

function entriesFor(db: DatabaseSync, project: string): string[] {
	return (
		db.prepare("SELECT prompt FROM entries WHERE project = ? ORDER BY id").all(project) as {
			prompt: string;
		}[]
	).map((row) => row.prompt);
}

function trimEntries(db: DatabaseSync, project: string, maxEntries: number): void {
	db.prepare(`DELETE FROM entries WHERE project = ? AND id NOT IN (
		SELECT id FROM entries WHERE project = ? ORDER BY id DESC LIMIT ?
	)`).run(project, project, Math.max(1, maxEntries));
}

function parseLegacy(raw: string, path: string): string[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(`malformed history at ${path}`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
		throw new Error(`malformed history at ${path}: expected a JSON object`);
	const entries = (parsed as Record<string, unknown>).entries;
	if (entries !== undefined && !Array.isArray(entries))
		throw new Error(`malformed history at ${path}: "entries" must be an array`);
	return (entries ?? []).filter(
		(entry): entry is string => typeof entry === "string" && entry.trim() !== "",
	);
}

function migrateLegacy(cwd: string, warn?: (message: string) => void): void {
	const source = resolve(legacyHistoryPath(cwd));
	let raw: string;
	try {
		raw = readFileSync(source, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	const entries = parseLegacy(raw, source);
	const digest = createHash("sha256").update(raw).digest("hex");
	const db = openDatabase();
	try {
		db.exec("BEGIN IMMEDIATE");
		try {
			const migrated = db.prepare("SELECT digest FROM migrated WHERE source = ?").get(source) as
				| { digest: string }
				| undefined;
			if (migrated) {
				if (migrated.digest !== digest)
					throw new Error(`legacy history changed after migration at ${source}`);
			} else {
				const insert = db.prepare("INSERT INTO entries(project, prompt) VALUES (?, ?)");
				for (const entry of entries) insert.run(projectName(cwd), entry);
				trimEntries(db, projectName(cwd), DEFAULT_MAX_ENTRIES);
				db.prepare("INSERT INTO migrated(source, digest) VALUES (?, ?)").run(source, digest);
			}
			if (readFileSync(source, "utf8") !== raw)
				throw new Error(`legacy history changed during migration at ${source}`);
			db.exec("COMMIT");
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	} finally {
		db.close();
	}
	// Only remove the exact bytes imported. A changed source needs manual resolution,
	// rather than silently losing prompts added by an older running Pi process.
	try {
		if (readFileSync(source, "utf8") !== raw)
			throw new Error(`legacy history changed after migration at ${source}`);
		rmSync(source);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") {
			const message = `pi-history: could not remove migrated legacy file at ${source}: ${describe(error)}`;
			if (warn) warn(message);
			else console.warn(message);
		}
	}
}

export function loadHistory(
	cwd: string,
	warn?: (message: string) => void,
): { entries: string[]; malformed: boolean } {
	try {
		migrateLegacy(cwd, warn);
		if (!existsSync(historyDatabasePath())) return { entries: [], malformed: false };
		const db = openDatabase();
		try {
			return { entries: entriesFor(db, projectName(cwd)), malformed: false };
		} finally {
			db.close();
		}
	} catch (error) {
		warn?.(`pi-history: could not read history: ${describe(error)}`);
		return { entries: [], malformed: true };
	}
}

export function appendHistory(
	cwd: string,
	prompt: string,
	maxEntries: number = DEFAULT_MAX_ENTRIES,
	warn?: (message: string) => void,
): string[] | undefined {
	const trimmed = prompt.trim();
	if (!trimmed) return undefined;
	migrateLegacy(cwd, warn);
	const db = openDatabase();
	try {
		const project = projectName(cwd);
		db.exec("BEGIN IMMEDIATE");
		try {
			const last = db
				.prepare("SELECT prompt FROM entries WHERE project = ? ORDER BY id DESC LIMIT 1")
				.get(project) as { prompt: string } | undefined;
			if (last?.prompt === trimmed) {
				db.exec("COMMIT");
				return undefined;
			}
			db.prepare("INSERT INTO entries(project, prompt) VALUES (?, ?)").run(project, trimmed);
			trimEntries(db, project, maxEntries);
			const entries = entriesFor(db, project);
			db.exec("COMMIT");
			return entries;
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	} finally {
		db.close();
	}
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
