import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ActiveGoal } from "./persistence.js";

export const GOAL_ARCHIVE_DIRECTORY = join(".pi", "pi-goals");

const MAX_SLUG_LENGTH = 48;
const FRONTMATTER_FENCE = "---";

export interface GoalArchiveEntry {
	file: string;
	goalId?: string;
	status?: string;
	objective?: string;
	startedAt?: string;
	updatedAt?: string;
}

/**
 * Archive files are a human-readable record, never an activation source. Reading one
 * back must go through /goal <objective> so goal_confirm still gates persistence.
 */
export function goalArchiveDirectory(cwd: string) {
	return join(cwd, GOAL_ARCHIVE_DIRECTORY);
}

export function goalSlug(objective: string) {
	const normalized = objective
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^\p{Letter}\p{Number}]+/gu, "-")
		.replace(/^-+|-+$/gu, "");
	if (!normalized) return "goal";
	return [...normalized].slice(0, MAX_SLUG_LENGTH).join("").replace(/-+$/u, "") || "goal";
}

export function goalArchiveDate(timestamp: number) {
	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) return goalArchiveDate(Date.now());
	const month = `${date.getMonth() + 1}`.padStart(2, "0");
	const day = `${date.getDate()}`.padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

/** Resolves `{date}-{slug}.md`, suffixing `-2`, `-3`, … only when a different goal owns the name. */
export function resolveGoalArchiveFile(cwd: string, goal: ActiveGoal) {
	const directory = goalArchiveDirectory(cwd);
	const base = `${goalArchiveDate(goal.startedAt)}-${goalSlug(goal.text)}`;
	for (let attempt = 1; ; attempt += 1) {
		const file = join(directory, attempt === 1 ? `${base}.md` : `${base}-${attempt}.md`);
		const existingId = readGoalId(file);
		if (existingId === undefined || existingId === goal.id) return file;
	}
}

function readGoalId(file: string) {
	const existing = readFileIfPresent(file);
	if (existing === undefined) return undefined;
	return parseFrontmatter(existing).fields.goal_id ?? "";
}

export function renderGoalArchive(goal: ActiveGoal) {
	return `${renderFrontmatter(goalFrontmatter(goal))}\n# Goal\n\n${goal.text.trim()}\n`;
}

/**
 * Rewrites only the frontmatter so notes appended to the body by hand survive
 * every later status change.
 */
export function patchGoalArchiveFrontmatter(existing: string, goal: ActiveGoal) {
	const { body } = parseFrontmatter(existing);
	return `${renderFrontmatter(goalFrontmatter(goal))}${body}`;
}

function goalFrontmatter(goal: ActiveGoal): Array<[string, string]> {
	const fields: Array<[string, string]> = [
		["goal_id", goal.id],
		["status", goal.status],
		["started_at", new Date(goal.startedAt).toISOString()],
		["updated_at", new Date(goal.updatedAt).toISOString()],
		["iteration", `${goal.iteration}`],
		["tokens_used", `${Math.round(goal.tokensUsed)}`],
	];
	if (goal.tokenBudget !== undefined) fields.push(["token_budget", `${goal.tokenBudget}`]);
	fields.push(["time_used_seconds", `${Math.round(goal.timeUsedSeconds)}`]);
	if (goal.safetyPauseCause) fields.push(["safety_pause_cause", goal.safetyPauseCause]);
	if (goal.waiting?.reason) fields.push(["waiting", goal.waiting.reason]);
	fields.push(["objective", goal.text]);
	return fields;
}

function renderFrontmatter(fields: Array<[string, string]>) {
	const lines = fields.map(([key, value]) => `${key}: ${quoteYaml(value)}`);
	return `${FRONTMATTER_FENCE}\n${lines.join("\n")}\n${FRONTMATTER_FENCE}\n`;
}

/** Every value is emitted as a double-quoted scalar, so no objective can forge a YAML key. */
function quoteYaml(value: string) {
	const escaped = value
		.replace(/\\/gu, "\\\\")
		.replace(/"/gu, '\\"')
		.replace(/\r/gu, "\\r")
		.replace(/\n/gu, "\\n")
		.replace(/\t/gu, "\\t");
	return `"${escaped}"`;
}

export function parseFrontmatter(content: string) {
	const fields: Record<string, string> = {};
	if (!content.startsWith(`${FRONTMATTER_FENCE}\n`)) return { fields, body: content };
	const end = content.indexOf(`\n${FRONTMATTER_FENCE}\n`, FRONTMATTER_FENCE.length);
	if (end === -1) return { fields, body: content };
	const block = content.slice(FRONTMATTER_FENCE.length + 1, end);
	for (const line of block.split("\n")) {
		const match = /^([A-Za-z0-9_]+):\s*(.*)$/u.exec(line);
		if (match?.[1]) fields[match[1]] = unquoteYaml(match[2] ?? "");
	}
	return { fields, body: content.slice(end + FRONTMATTER_FENCE.length + 2) };
}

function unquoteYaml(value: string) {
	const trimmed = value.trim();
	if (!trimmed.startsWith('"') || !trimmed.endsWith('"') || trimmed.length < 2) return trimmed;
	return trimmed
		.slice(1, -1)
		.replace(/\\n/gu, "\n")
		.replace(/\\r/gu, "\r")
		.replace(/\\t/gu, "\t")
		.replace(/\\"/gu, '"')
		.replace(/\\\\/gu, "\\");
}

/** Writes the first snapshot for a newly confirmed goal. Returns the file it wrote. */
export function writeGoalArchiveSnapshot(cwd: string, goal: ActiveGoal) {
	const file = resolveGoalArchiveFile(cwd, goal);
	const existing = readFileIfPresent(file);
	writeFileAtomic(
		file,
		existing === undefined ? renderGoalArchive(goal) : patchGoalArchiveFrontmatter(existing, goal),
	);
	return file;
}

/** Refreshes frontmatter for a goal already on disk. Missing files are re-created. */
export function updateGoalArchiveFrontmatter(cwd: string, goal: ActiveGoal) {
	const file = findGoalArchiveFile(cwd, goal.id);
	if (!file) return undefined;
	const existing = readFileIfPresent(file);
	if (existing === undefined) return undefined;
	const next = patchGoalArchiveFrontmatter(existing, goal);
	if (next === existing) return file;
	writeFileAtomic(file, next);
	return file;
}

export function findGoalArchiveFile(cwd: string, goalId: string) {
	for (const file of archiveFiles(cwd)) {
		if (readGoalId(file) === goalId) return file;
	}
	return undefined;
}

export function listGoalArchive(cwd: string): GoalArchiveEntry[] {
	const entries = archiveFiles(cwd).map((file) => {
		const content = readFileIfPresent(file) ?? "";
		const { fields } = parseFrontmatter(content);
		return {
			file,
			goalId: fields.goal_id,
			status: fields.status,
			objective: fields.objective,
			startedAt: fields.started_at,
			updatedAt: fields.updated_at,
		};
	});
	return entries.sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""));
}

function archiveFiles(cwd: string) {
	const directory = goalArchiveDirectory(cwd);
	let names: string[];
	try {
		names = readdirSync(directory);
	} catch {
		return [];
	}
	return names
		.filter((name) => name.endsWith(".md"))
		.sort()
		.map((name) => join(directory, name));
}

function readFileIfPresent(file: string) {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
}

function writeFileAtomic(file: string, content: string) {
	mkdirSync(join(file, ".."), { recursive: true });
	const temporary = `${file}.${process.pid}.tmp`;
	writeFileSync(temporary, content);
	renameSync(temporary, file);
}
