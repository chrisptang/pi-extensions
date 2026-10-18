import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
	PROMPT_FILE_NAME,
	projectPromptPath,
	resolvePrompt,
	userPromptPath,
} from "../src/prompt-file.js";

function createScopes(options: { project?: string; user?: string } = {}) {
	const root = mkdtempSync(join(tmpdir(), "pi-compaction-prompt-"));
	const cwd = join(root, "workspace");
	const agentDir = join(root, "agent");
	mkdirSync(join(cwd, ".pi", "system-prompts"), { recursive: true });
	mkdirSync(join(agentDir, "system-prompts"), { recursive: true });
	if (options.project !== undefined) {
		writeFileSync(projectPromptPath(cwd), options.project);
	}
	if (options.user !== undefined) {
		writeFileSync(userPromptPath(agentDir), options.user);
	}
	return { cwd, agentDir };
}

function canStillRead(path: string): boolean {
	try {
		readFileSync(path, "utf8");
		return true;
	} catch {
		return false;
	}
}

describe("resolvePrompt", () => {
	test("new paths win within each scope while legacy project files still override user files", () => {
		const { cwd, agentDir } = createScopes({ project: "new project", user: "new user" });
		writeFileSync(join(cwd, ".pi", PROMPT_FILE_NAME), "legacy project");
		writeFileSync(join(agentDir, PROMPT_FILE_NAME), "legacy user");
		expect(resolvePrompt({ cwd, agentDir, projectTrusted: true }).prompt?.text).toBe("new project");
		writeFileSync(projectPromptPath(cwd), " ");
		expect(resolvePrompt({ cwd, agentDir, projectTrusted: true }).prompt?.text).toBe(
			"legacy project",
		);
		expect(resolvePrompt({ cwd, agentDir, projectTrusted: false }).prompt?.text).toBe("new user");
		writeFileSync(userPromptPath(agentDir), " ");
		expect(resolvePrompt({ cwd, agentDir, projectTrusted: false }).prompt?.text).toBe(
			"legacy user",
		);
	});

	test("prefers the project prompt over the user prompt when the project is trusted", () => {
		const { cwd, agentDir } = createScopes({ project: "project rules", user: "user rules" });

		const resolution = resolvePrompt({ cwd, agentDir, projectTrusted: true });

		expect(resolution.errors).toEqual([]);
		expect(resolution.prompt).toEqual({
			scope: "project",
			path: projectPromptPath(cwd),
			text: "project rules",
		});
	});

	test("falls back to the user prompt when the project is untrusted", () => {
		const { cwd, agentDir } = createScopes({ project: "project rules", user: "user rules" });

		const resolution = resolvePrompt({ cwd, agentDir, projectTrusted: false });

		expect(resolution.prompt).toEqual({
			scope: "user",
			path: userPromptPath(agentDir),
			text: "user rules",
		});
	});

	test("falls back to the user prompt when no project prompt exists", () => {
		const { cwd, agentDir } = createScopes({ user: "user rules" });

		const resolution = resolvePrompt({ cwd, agentDir, projectTrusted: true });

		expect(resolution.prompt?.scope).toBe("user");
		expect(resolution.prompt?.text).toBe("user rules");
	});

	test("reports no prompt and no error when neither scope has a file", () => {
		const { cwd, agentDir } = createScopes();

		const resolution = resolvePrompt({ cwd, agentDir, projectTrusted: true });

		expect(resolution.prompt).toBeUndefined();
		expect(resolution.errors).toEqual([]);
	});

	test("treats a whitespace-only project prompt as absent so the user prompt applies", () => {
		const { cwd, agentDir } = createScopes({ project: "  \n\t ", user: "user rules" });

		const resolution = resolvePrompt({ cwd, agentDir, projectTrusted: true });

		expect(resolution.prompt?.scope).toBe("user");
	});

	test("trims surrounding whitespace from the prompt text", () => {
		const { cwd, agentDir } = createScopes({ user: "\n\n## Keep\n- verbatim\n\n" });

		const resolution = resolvePrompt({ cwd, agentDir, projectTrusted: false });

		expect(resolution.prompt?.text).toBe("## Keep\n- verbatim");
	});

	test("treats a directory at the prompt path as absent and uses the next scope", () => {
		const { cwd, agentDir } = createScopes({ user: "user rules" });
		mkdirSync(projectPromptPath(cwd), { recursive: true });

		const resolution = resolvePrompt({ cwd, agentDir, projectTrusted: true });

		expect(resolution.prompt?.scope).toBe("user");
		expect(resolution.errors).toEqual([]);
	});

	test("reports an unreadable prompt file and continues to the next scope", () => {
		const { cwd, agentDir } = createScopes({ project: "project rules", user: "user rules" });
		const projectFile = projectPromptPath(cwd);
		chmodSync(projectFile, 0o000);
		if (canStillRead(projectFile)) return; // A privileged runner ignores the mode bits.

		const resolution = resolvePrompt({ cwd, agentDir, projectTrusted: true });

		expect(resolution.prompt?.scope).toBe("user");
		expect(resolution.errors).toHaveLength(1);
		expect(resolution.errors[0]).toContain(projectFile);
	});

	test("does not create the prompt files or their directories", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-compaction-prompt-"));
		const cwd = join(root, "missing-workspace");
		const agentDir = join(root, "missing-agent");

		const resolution = resolvePrompt({ cwd, agentDir, projectTrusted: true });

		expect(resolution.prompt).toBeUndefined();
		expect(resolution.errors).toEqual([]);
	});
});
