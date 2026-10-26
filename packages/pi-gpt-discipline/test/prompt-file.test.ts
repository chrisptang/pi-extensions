import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { GPT_DISCIPLINE_RULES, resolvePrompt } from "../src/prompt-file.js";

describe("GPT discipline prompt files", () => {
	let root: string;
	let cwd: string;
	let agentDir: string;
	let userFile: string;
	let projectFile: string;

	beforeEach(() => {
		root = fs.mkdtempSync(join(tmpdir(), "pi-gpt-prompts-"));
		cwd = join(root, "project");
		agentDir = join(root, "agent");
		userFile = join(agentDir, "system-prompts", "gpt-discipline.md");
		projectFile = join(cwd, ".pi", "system-prompts", "gpt-discipline.md");
	});
	afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

	for (const scenario of [
		{
			name: "user wins over trusted project",
			user: "user",
			project: "project",
			trusted: true,
			expected: "user",
		},
		{
			name: "trusted project wins over built-in",
			project: "project",
			trusted: true,
			expected: "project",
		},
		{
			name: "untrusted project is ignored",
			project: "project",
			trusted: false,
			expected: GPT_DISCIPLINE_RULES,
		},
		{
			name: "user applies in untrusted projects",
			user: "user",
			project: "project",
			trusted: false,
			expected: "user",
		},
		{
			name: "empty user falls through",
			user: " \n\t",
			project: "project",
			trusted: true,
			expected: "project",
		},
		{
			name: "empty project falls through",
			project: " \n",
			trusted: true,
			expected: GPT_DISCIPLINE_RULES,
		},
		{
			name: "surrounding whitespace is trimmed",
			user: "\n  custom rules\n\n",
			trusted: true,
			expected: "custom rules",
		},
	]) {
		it(scenario.name, () => {
			for (const [file, text] of [
				[userFile, scenario.user],
				[projectFile, scenario.project],
			] as const) {
				if (text === undefined) continue;
				fs.mkdirSync(dirname(file), { recursive: true });
				fs.writeFileSync(file, text);
			}
			const result = resolvePrompt({ cwd, agentDir, projectTrusted: scenario.trusted });
			assert.equal(result.text, scenario.expected);
			assert.deepEqual(result.errors, []);
		});
	}

	it("falls back to the bundled eight rules without creating directories", () => {
		assert.equal(resolvePrompt({ cwd, agentDir, projectTrusted: true }).text, GPT_DISCIPLINE_RULES);
		assert.equal(GPT_DISCIPLINE_RULES.match(/^\d\. 【/gm)?.length, 8);
		assert.deepEqual(fs.readdirSync(root), []);
	});

	it("ignores old locations and directories at the expected file path", () => {
		fs.mkdirSync(userFile, { recursive: true });
		fs.mkdirSync(dirname(projectFile), { recursive: true });
		fs.writeFileSync(join(agentDir, "gpt-discipline.md"), "old user rules");
		fs.writeFileSync(join(cwd, ".pi", "gpt-discipline.md"), "old project rules");
		assert.deepEqual(resolvePrompt({ cwd, agentDir, projectTrusted: true }), {
			text: GPT_DISCIPLINE_RULES,
			errors: [],
		});
	});

	it("treats a non-directory path component as an absent override", () => {
		fs.mkdirSync(agentDir, { recursive: true });
		fs.writeFileSync(join(agentDir, "system-prompts"), "not a directory");
		assert.deepEqual(resolvePrompt({ cwd, agentDir, projectTrusted: true }), {
			text: GPT_DISCIPLINE_RULES,
			errors: [],
		});
	});

	it("reports read failures, uses the next scope, and never overwrites the file", () => {
		for (const file of [userFile, projectFile]) {
			fs.mkdirSync(dirname(file), { recursive: true });
			fs.writeFileSync(file, file === userFile ? "user rules" : "project rules");
		}
		const read = fs.readFileSync;
		vi.spyOn(fs, "readFileSync").mockImplementation((...args: Parameters<typeof read>) => {
			if (args[0] === userFile) throw Object.assign(new Error("denied"), { code: "EACCES" });
			return read(...args);
		});
		const result = resolvePrompt({ cwd, agentDir, projectTrusted: true });
		assert.equal(result.text, "project rules");
		assert.equal(result.errors.length, 1);
		assert.match(result.errors[0] ?? "", /user.*EACCES/);
		assert.equal(read(userFile, "utf8"), "user rules");
	});
});
