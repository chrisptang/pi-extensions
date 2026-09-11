import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, test } from "vitest";
import {
	findGoalArchiveFile,
	goalArchiveDirectory,
	goalSlug,
	listGoalArchive,
	parseFrontmatter,
	renderGoalArchive,
	resolveGoalArchiveFile,
	updateGoalArchiveFrontmatter,
	writeGoalArchiveSnapshot,
} from "../src/goal-archive.js";
import type { ActiveGoal } from "../src/persistence.js";

const workspaces: string[] = [];

afterEach(() => {
	for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
});

function workspace() {
	const directory = mkdtempSync(join(tmpdir(), "pi-goal-archive-"));
	workspaces.push(directory);
	return directory;
}

function goal(overrides: Partial<ActiveGoal> = {}): ActiveGoal {
	return {
		id: "goal-1",
		text: "Ship the release",
		status: "active",
		startedAt: Date.parse("2026-09-11T02:00:00.000Z"),
		updatedAt: Date.parse("2026-09-11T02:00:00.000Z"),
		iteration: 0,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		baselineTokens: 0,
		automaticModelTurns: 0,
		toolFreeRepeatCount: 0,
		...overrides,
	};
}

test("slugs stay readable and bounded", () => {
	assert.equal(goalSlug("Ship the Release!"), "ship-the-release");
	assert.equal(goalSlug("  ***  "), "goal");
	assert.equal(goalSlug(""), "goal");
	assert.equal(goalSlug("修复登录缺陷"), "修复登录缺陷");
	assert.equal(goalSlug("a".repeat(200)).length, 48);
	assert.ok(!goalSlug(`${"a".repeat(47)} tail`).endsWith("-"));
});

test("snapshot writes {date}-{slug}.md with the objective in the body", () => {
	const cwd = workspace();
	const file = writeGoalArchiveSnapshot(cwd, goal());

	assert.equal(basename(file), "2026-09-11-ship-the-release.md");
	const { fields, body } = parseFrontmatter(readFileSync(file, "utf8"));
	assert.equal(fields.goal_id, "goal-1");
	assert.equal(fields.status, "active");
	assert.equal(fields.objective, "Ship the release");
	assert.match(body, /# Goal\n\nShip the release/u);
});

test("a different goal on the same day and slug gets a numbered file", () => {
	const cwd = workspace();
	const first = writeGoalArchiveSnapshot(cwd, goal());
	const second = writeGoalArchiveSnapshot(cwd, goal({ id: "goal-2" }));

	assert.notEqual(first, second);
	assert.equal(basename(second), "2026-09-11-ship-the-release-2.md");
});

test("re-snapshotting the same goal reuses its file", () => {
	const cwd = workspace();
	const first = writeGoalArchiveSnapshot(cwd, goal());
	const again = writeGoalArchiveSnapshot(cwd, goal({ status: "paused" }));

	assert.equal(first, again);
	assert.equal(listGoalArchive(cwd).length, 1);
});

test("frontmatter updates preserve hand-written body notes", () => {
	const cwd = workspace();
	const file = writeGoalArchiveSnapshot(cwd, goal());
	writeFileSync(file, `${readFileSync(file, "utf8")}\n## Notes\n\nchecked with the team\n`);

	const updated = updateGoalArchiveFrontmatter(
		cwd,
		goal({
			status: "complete",
			iteration: 4,
			tokensUsed: 1_234.6,
			updatedAt: Date.parse("2026-09-11T05:00:00.000Z"),
		}),
	);

	assert.equal(updated, file);
	const { fields, body } = parseFrontmatter(readFileSync(file, "utf8"));
	assert.equal(fields.status, "complete");
	assert.equal(fields.iteration, "4");
	assert.equal(fields.tokens_used, "1235");
	assert.equal(fields.updated_at, "2026-09-11T05:00:00.000Z");
	assert.match(body, /checked with the team/u);
});

test("frontmatter updates are a no-op when the goal was never archived", () => {
	const cwd = workspace();
	assert.equal(updateGoalArchiveFrontmatter(cwd, goal()), undefined);
	assert.deepEqual(listGoalArchive(cwd), []);
});

test("objectives cannot forge frontmatter keys", () => {
	const cwd = workspace();
	const file = writeGoalArchiveSnapshot(
		cwd,
		goal({ text: 'evil"\nstatus: complete\ninjected: yes' }),
	);

	const { fields } = parseFrontmatter(readFileSync(file, "utf8"));
	assert.equal(fields.status, "active");
	assert.equal(fields.injected, undefined);
	assert.equal(fields.objective, 'evil"\nstatus: complete\ninjected: yes');
});

test("listing reports newest first and ignores unrelated files", () => {
	const cwd = workspace();
	writeGoalArchiveSnapshot(cwd, goal({ id: "older", text: "older goal" }));
	writeGoalArchiveSnapshot(
		cwd,
		goal({ id: "newer", text: "newer goal", updatedAt: Date.parse("2026-09-11T09:00:00.000Z") }),
	);
	writeFileSync(join(goalArchiveDirectory(cwd), "README.txt"), "ignored");

	const entries = listGoalArchive(cwd);
	assert.deepEqual(
		entries.map((entry) => entry.goalId),
		["newer", "older"],
	);
	assert.equal(entries[0]?.objective, "newer goal");
});

test("archive lookups tolerate a missing directory and malformed files", () => {
	const cwd = workspace();
	assert.deepEqual(listGoalArchive(cwd), []);
	assert.equal(findGoalArchiveFile(cwd, "goal-1"), undefined);

	mkdirSync(goalArchiveDirectory(cwd), { recursive: true });
	writeFileSync(join(goalArchiveDirectory(cwd), "broken.md"), "no frontmatter here");
	assert.deepEqual(
		listGoalArchive(cwd).map((entry) => entry.goalId),
		[undefined],
	);
	assert.equal(findGoalArchiveFile(cwd, "goal-1"), undefined);
});

test("rendering is stable for a goal with a budget and a wait", () => {
	const rendered = renderGoalArchive(
		goal({ tokenBudget: 100_000, waiting: { reason: "rate limit", resumeAt: 0 } }),
	);
	const { fields } = parseFrontmatter(rendered);

	assert.equal(fields.token_budget, "100000");
	assert.equal(fields.waiting, "rate limit");
});

test("resolution returns the existing file for a known goal id", () => {
	const cwd = workspace();
	const file = writeGoalArchiveSnapshot(cwd, goal());
	assert.equal(resolveGoalArchiveFile(cwd, goal({ text: "Ship the release" })), file);
});
