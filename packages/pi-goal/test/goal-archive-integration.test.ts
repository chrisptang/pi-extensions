import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { registerGoalCommand } from "../src/command-registration.js";
import { GoalCommandController } from "../src/commands.js";
import { goalArchiveDirectory, listGoalArchive, parseFrontmatter } from "../src/goal-archive.js";
import { GoalRuntime } from "../src/runtime.js";

const workspaces: string[] = [];

afterEach(() => {
	for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
});

function fixture(overrides: Record<string, unknown> = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "pi-goal-confirm-"));
	workspaces.push(cwd);
	const mock = createMockPi({ activeTools: ["goal_confirm", "goal_complete", "goal_blocked"] });
	const runtime = new GoalRuntime(mock.pi);
	const commands = new GoalCommandController(runtime);
	registerGoalCommand(mock.pi, runtime, commands);
	const context = createMockContext({ mode: "tui", cwd, confirm: async () => true, ...overrides });
	const command = mock.commands.get("goal");
	const tool = mock.tools.find((item) => item.name === "goal_confirm");
	assert.ok(command && tool);
	const execute = tool.execute as (...args: unknown[]) => Promise<unknown>;
	return {
		...mock,
		...context,
		cwd,
		runtime,
		run: (text: string) => command.handler(text, context.ctx),
		confirm: (objective = "Ship the login fix with regression tests") => {
			const message = mock.sentMessages.at(-1)?.message as { content: string };
			return execute(
				"approval",
				{ request_id: /Request ID: (\S+)/.exec(message.content)?.[1], objective },
				undefined,
				undefined,
				context.ctx,
			);
		},
	};
}

function archiveFile(cwd: string) {
	const directory = goalArchiveDirectory(cwd);
	const names = readdirSync(directory).filter((name) => name.endsWith(".md"));
	assert.equal(names.length, 1);
	return join(directory, names[0] as string);
}

test("a confirmed goal is archived under .pi/pi-goals", async () => {
	const f = fixture();
	await f.run("--tokens 100k initial objective");
	assert.equal(existsSync(goalArchiveDirectory(f.cwd)), false);

	const result = (await f.confirm()) as { details: { archive?: string } };

	const file = archiveFile(f.cwd);
	assert.equal(result.details.archive, file);
	const { fields, body } = parseFrontmatter(readFileSync(file, "utf8"));
	assert.equal(fields.goal_id, f.runtime.activeGoal?.id);
	assert.equal(fields.status, "active");
	assert.equal(fields.token_budget, "100000");
	assert.equal(fields.objective, "Ship the login fix with regression tests");
	assert.match(body, /Ship the login fix with regression tests/u);
});

test("a rejected goal writes nothing", async () => {
	const f = fixture({ confirm: async () => false });
	await f.run("initial objective");
	await f.confirm();

	assert.equal(f.runtime.activeGoal, undefined);
	assert.equal(existsSync(goalArchiveDirectory(f.cwd)), false);
});

test("later status changes refresh frontmatter but keep the body", async () => {
	const f = fixture();
	await f.run("initial objective");
	await f.confirm();
	const file = archiveFile(f.cwd);
	writeFileSync(file, `${readFileSync(file, "utf8")}\n## Notes\n\nmanual context\n`);

	await f.run("pause");

	const { fields, body } = parseFrontmatter(readFileSync(file, "utf8"));
	assert.equal(fields.status, "paused");
	assert.match(body, /manual context/u);
	assert.equal(readdirSync(goalArchiveDirectory(f.cwd)).length, 1);
});

test("an unwritable archive warns but still activates the goal", async () => {
	const f = fixture();
	writeFileSync(join(f.cwd, ".pi"), "not a directory");
	await f.run("initial objective");

	const result = (await f.confirm()) as { details: { archive?: string } };

	assert.equal(f.runtime.activeGoal?.status, "active");
	assert.equal(result.details.archive, undefined);
	assert.ok(
		f.notifications.some((entry) => /markdown record could not be written/u.test(entry.message)),
	);
});

test("/goal --list reports archived goals and the empty case", async () => {
	const f = fixture();
	await f.run("--list");
	assert.match(f.notifications.at(-1)?.message ?? "", /No archived goals/u);

	await f.run("initial objective");
	await f.confirm();
	await f.run("-l");

	const listing = f.notifications.at(-1)?.message ?? "";
	assert.match(listing, /1 archived goal/u);
	assert.match(listing, /Ship the login fix with regression tests/u);
	assert.match(listing, /active/u);
});

test("clearing a goal leaves its record intact and does not touch a later goal", async () => {
	const f = fixture();
	await f.run("initial objective");
	await f.confirm("First objective with acceptance criteria");
	const first = archiveFile(f.cwd);
	await f.run("clear");

	const afterClear = readFileSync(first, "utf8");
	assert.match(afterClear, /First objective with acceptance criteria/u);

	await f.run("second objective");
	await f.confirm("Second objective with acceptance criteria");

	assert.equal(readFileSync(first, "utf8"), afterClear);
	assert.equal(readdirSync(goalArchiveDirectory(f.cwd)).length, 2);
	assert.equal(listGoalArchive(f.cwd).length, 2);
});
