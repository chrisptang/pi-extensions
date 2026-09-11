import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

/** Default number of prompts retained on disk; the oldest are dropped past this. */
export const DEFAULT_MAX_ENTRIES = 1000;

/**
 * Persisted shape. Entries are ordered oldest first so an append is a push and
 * trimming the oldest is a shift, matching how the file reads chronologically.
 */
export interface HistoryFile {
	entries: string[];
	/** Unrecognized fields are preserved so an older version cannot erase newer data. */
	[key: string]: unknown;
}

/** The project-scoped history path for a workspace. */
export function historyFilePath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "pi-history.json");
}

/**
 * Read the stored prompts, oldest first.
 *
 * A missing file means "no history" rather than an error, and reading never
 * creates the file or its parent directory. A malformed file is reported through
 * `warn` and treated as empty, but is left on disk rather than overwritten, so a
 * later append fails loudly instead of silently discarding the user's history.
 */
export function loadHistory(
	cwd: string,
	warn?: (message: string) => void,
): { entries: string[]; malformed: boolean } {
	const path = historyFilePath(cwd);
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return { entries: [], malformed: false };
		warn?.(`pi-history: could not read ${path}: ${describe(error)}`);
		return { entries: [], malformed: true };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		warn?.(`pi-history: ignoring malformed ${path}: ${describe(error)}`);
		return { entries: [], malformed: true };
	}

	if (!isRecord(parsed)) {
		warn?.(`pi-history: ignoring ${path}: expected a JSON object`);
		return { entries: [], malformed: true };
	}

	const entries = parsed.entries;
	if (entries !== undefined && !Array.isArray(entries)) {
		warn?.(`pi-history: ignoring ${path}: "entries" must be an array`);
		return { entries: [], malformed: true };
	}

	// Drop non-string and blank rows rather than rejecting the whole file, so one
	// bad row cannot cost the user the rest of their history.
	return {
		entries: (entries ?? []).filter(
			(entry): entry is string => typeof entry === "string" && entry.trim() !== "",
		),
		malformed: false,
	};
}

/**
 * Append one prompt and publish the trimmed list atomically.
 *
 * The write starts from the latest file on disk so a concurrent Pi process's
 * entries are not lost, skips a consecutive duplicate the way shell history does,
 * and drops the oldest entries once the list exceeds `maxEntries`. Returns the
 * entries that were written, or `undefined` when nothing needed to be written.
 */
export function appendHistory(
	cwd: string,
	prompt: string,
	maxEntries: number = DEFAULT_MAX_ENTRIES,
): string[] | undefined {
	const trimmed = prompt.trim();
	if (!trimmed) return undefined;

	const path = historyFilePath(cwd);
	// Re-read rather than trusting an in-memory copy: another Pi process in the
	// same workspace may have appended since this session started.
	const { entries, malformed } = loadHistory(cwd);
	if (malformed) {
		// Refuse to publish over a file we could not understand; the caller reports it.
		throw new Error(`refusing to overwrite malformed history at ${path}`);
	}
	if (entries[entries.length - 1] === trimmed) return undefined;

	entries.push(trimmed);
	const overflow = entries.length - Math.max(1, maxEntries);
	if (overflow > 0) entries.splice(0, overflow);

	writeAtomically(path, `${JSON.stringify({ entries }, undefined, "\t")}\n`);
	return entries;
}

/**
 * Publish through a temporary file in the destination directory followed by a
 * rename, so a crashed or concurrent write cannot leave a truncated file behind.
 * Rename is used rather than a hard link because Android SELinux denies hard-link
 * creation to Termux's `untrusted_app` domain.
 */
function writeAtomically(path: string, contents: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporaryPath, contents, "utf8");
		renameSync(temporaryPath, path);
	} catch (error) {
		rmSync(temporaryPath, { force: true });
		throw error;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
