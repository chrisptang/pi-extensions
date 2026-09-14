#!/usr/bin/env node
/**
 * One-off import of Pi session logs into the analytics database.
 *
 * Extension events carry no session identity, so sessions, active days and streaks cannot be
 * collected live. Pi's own session log does record them, and every assistant message in it carries
 * the provider's usage counters, which makes it the only source of token history predating the
 * analytics token support.
 *
 * The import is idempotent: sessions are keyed by their session ID and replaced on re-run.
 *
 * Usage:
 *   node scripts/backfill-sessions.mjs [--dry-run] [--sessions <dir>] [--database <file>]
 *                                      [--include <substring>] [--exclude <substring>]
 */
import { chmod, mkdir, readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const HOME = os.homedir();
const SCHEMA_VERSION = 2;

/**
 * Reads the table definitions out of the extension source so the script cannot drift from the
 * schema the extension itself creates.
 */
async function readSchema() {
	const source = path.join(
		path.dirname(fileURLToPath(import.meta.url)),
		"..",
		"src",
		"storage",
		"database.ts",
	);
	const text = await readFile(source, "utf8");
	const match = text.match(/const SCHEMA = `([\s\S]*?)`;/u);
	if (!match?.[1]) throw new Error(`Could not read the analytics schema from ${source}`);
	return match[1];
}

function parseArguments(argv) {
	const options = {
		dryRun: false,
		sessionsDir: path.join(HOME, ".pi", "agent", "sessions"),
		databasePath: path.join(HOME, ".pi", "agent", "pi-analytics.db"),
		include: [],
		exclude: [],
	};
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (flag === "--dry-run") {
			options.dryRun = true;
		} else if (flag === "--help" || flag === "-h") {
			options.help = true;
		} else if (flag === "--sessions") {
			options.sessionsDir = expect(flag, value);
			index += 1;
		} else if (flag === "--database") {
			options.databasePath = expect(flag, value);
			index += 1;
		} else if (flag === "--include") {
			options.include.push(expect(flag, value));
			index += 1;
		} else if (flag === "--exclude") {
			options.exclude.push(expect(flag, value));
			index += 1;
		} else {
			throw new Error(`Unknown argument: ${flag}`);
		}
	}
	return options;
}

function expect(flag, value) {
	if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
	return value;
}

/** Reads one session log, returning its session row or undefined when it holds no usage. */
async function readSession(file) {
	const raw = await readFile(file, "utf8");
	let id;
	let cwd;
	let startedAtMs;
	let endedAtMs;
	let llmCalls = 0;
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			// A session log can end mid-write if Pi was killed; skip the torn line.
			continue;
		}
		const at = Date.parse(entry.timestamp ?? "");
		if (Number.isFinite(at)) {
			startedAtMs = startedAtMs === undefined ? at : Math.min(startedAtMs, at);
			endedAtMs = endedAtMs === undefined ? at : Math.max(endedAtMs, at);
		}
		if (entry.type === "session") {
			id = entry.id;
			cwd = entry.cwd;
			continue;
		}
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		const counters = entry.message.usage;
		if (!counters) continue;
		llmCalls += 1;
		usage.input += number(counters.input);
		usage.output += number(counters.output);
		usage.cacheRead += number(counters.cacheRead);
		usage.cacheWrite += number(counters.cacheWrite);
		usage.cost += number(counters.cost?.total);
	}

	if (!id || startedAtMs === undefined || endedAtMs === undefined) return undefined;
	return {
		id,
		// Only the basename is stored; the analytics database never records full paths.
		project: cwd ? path.basename(cwd) : "unknown",
		startedAtMs,
		endedAtMs,
		llmCalls,
		usage,
	};
}

function number(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

async function collectFiles(root) {
	const files = [];
	for (const entry of await readdir(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const directory = path.join(root, entry.name);
		for (const file of await readdir(directory)) {
			if (file.endsWith(".jsonl")) files.push(path.join(directory, file));
		}
	}
	return files.sort();
}

function matches(session, { include, exclude }) {
	if (exclude.some((term) => session.project.includes(term))) return false;
	return include.length === 0 || include.some((term) => session.project.includes(term));
}

function writeSessions(databasePath, sessions, schema) {
	const database = new DatabaseSync(databasePath);
	try {
		database.exec("PRAGMA busy_timeout = 5000");
		database.exec("PRAGMA journal_mode = WAL");
		database.exec("PRAGMA foreign_keys = ON");
		// A fresh checkout has no database until Pi runs, so create the schema from the
		// extension's own definition rather than requiring a Pi launch before importing.
		database.exec(schema);
		database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
		const statement = database.prepare(
			`INSERT OR REPLACE INTO sessions (
				id, project, started_at_ms, ended_at_ms, llm_calls,
				input, output, cache_read, cache_write, cost
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		database.exec("BEGIN IMMEDIATE");
		try {
			for (const item of sessions) {
				statement.run(
					item.id,
					item.project,
					item.startedAtMs,
					item.endedAtMs,
					item.llmCalls,
					item.usage.input,
					item.usage.output,
					item.usage.cacheRead,
					item.usage.cacheWrite,
					item.usage.cost,
				);
			}
			database.exec("COMMIT");
		} catch (error) {
			database.exec("ROLLBACK");
			throw error;
		}
	} finally {
		database.close();
	}
}

function summarize(sessions) {
	const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	const days = new Set();
	let llmCalls = 0;
	const projects = new Map();
	for (const item of sessions) {
		llmCalls += item.llmCalls;
		for (const key of Object.keys(totals)) totals[key] += item.usage[key];
		days.add(new Date(item.startedAtMs).toLocaleDateString("sv"));
		projects.set(item.project, (projects.get(item.project) ?? 0) + 1);
	}
	return { totals, days, llmCalls, projects };
}

async function main() {
	const options = parseArguments(process.argv.slice(2));
	if (options.help) {
		console.log(
			"Usage: node scripts/backfill-sessions.mjs [--dry-run] [--sessions <dir>] [--database <file>] [--include <substring>] [--exclude <substring>]",
		);
		return;
	}
	const directory = await stat(options.sessionsDir).catch(() => undefined);
	if (!directory?.isDirectory()) {
		throw new Error(`No session directory at ${options.sessionsDir}`);
	}

	const files = await collectFiles(options.sessionsDir);
	const sessions = [];
	let skipped = 0;
	for (const file of files) {
		const session = await readSession(file);
		if (!session) {
			skipped += 1;
			continue;
		}
		if (!matches(session, options)) continue;
		sessions.push(session);
	}

	const { totals, days, llmCalls, projects } = summarize(sessions);
	console.log(`Session files:   ${files.length}${skipped > 0 ? ` (${skipped} unreadable)` : ""}`);
	console.log(`Sessions:        ${sessions.length}`);
	console.log(`LLM calls:       ${llmCalls}`);
	console.log(`Active days:     ${days.size}`);
	console.log(
		`Tokens:          in ${totals.input} · cacheRead ${totals.cacheRead} · cacheWrite ${totals.cacheWrite} · out ${totals.output}`,
	);
	console.log(`Cost:            $${totals.cost.toFixed(4)}`);
	console.log("Projects:");
	for (const [project, count] of [...projects].sort((left, right) => right[1] - left[1])) {
		console.log(`  ${String(count).padStart(4)}  ${project}`);
	}

	if (options.dryRun) {
		console.log("\nDry run: nothing was written.");
		return;
	}
	if (sessions.length === 0) {
		console.log("\nNothing to import.");
		return;
	}
	await mkdir(path.dirname(options.databasePath), { recursive: true, mode: 0o700 });
	writeSessions(options.databasePath, sessions, await readSchema());
	if (process.platform !== "win32") {
		await chmod(options.databasePath, 0o600).catch(() => undefined);
	}
	console.log(`\nImported ${sessions.length} sessions into ${options.databasePath}`);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
