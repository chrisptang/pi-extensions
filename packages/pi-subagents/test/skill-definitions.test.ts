import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import {
	discoverAllSkills,
	discoverPrimarySkills,
	normalizeSkillName,
	skillDirectories,
} from "../src/skill-definitions.js";
import { SkillRegistry } from "../src/skill-registry.js";

let root: string;
let project: string;
let previousAgentDir: string | undefined;

beforeEach(() => {
	root = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-skills-"));
	project = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-project-"));
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
});

afterEach(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(root, { recursive: true, force: true });
	rmSync(project, { recursive: true, force: true });
});

/** Write `<directory>/<name>/SKILL.md`, the only shape discovery scans. */
function writeSkill(directory: string, name: string, content: string): string {
	const skillDir = path.join(directory, name);
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(path.join(skillDir, "SKILL.md"), content, "utf8");
	return skillDir;
}

function piSkills(): string {
	return path.join(root, "skills");
}

test("skill directories are ordered project, pi, claude, agents", () => {
	const directories = skillDirectories(project).map((entry) => entry.kind);
	assert.deepEqual(directories, ["project", "pi", "claude", "agents"]);
	assert.equal(skillDirectories(project)[0].directory, path.join(project, ".pi", "skills"));
});

test("discovery reads name, description, body, and base directory", () => {
	const dir = writeSkill(
		piSkills(),
		"deploy",
		"---\nname: deploy\ndescription: Ships the build.\n---\n\nStep one.\n",
	);
	const { skills } = discoverPrimarySkills(project);
	const deploy = skills.get("deploy");
	assert.ok(deploy);
	assert.equal(deploy.description, "Ships the build.");
	assert.equal(deploy.body, "Step one.");
	assert.equal(deploy.baseDir, dir);
	assert.equal(deploy.origin, "pi");
});

test("the directory name supplies the skill name when frontmatter omits it", () => {
	writeSkill(piSkills(), "reviewer", "---\ndescription: Reviews.\n---\n\nBody.\n");
	const { skills } = discoverPrimarySkills(project);
	assert.ok(skills.get("reviewer"));
});

test("names are matched case-insensitively and validated", () => {
	writeSkill(piSkills(), "Deploy", "---\nname: DEPLOY\n---\n\nBody.\n");
	const { skills } = discoverPrimarySkills(project);
	assert.ok(skills.get("deploy"));
	assert.equal(normalizeSkillName("  DePloY "), "deploy");
	assert.equal(normalizeSkillName("bad name"), undefined);
	// Dots appear in real skill names, unlike agent names.
	assert.equal(normalizeSkillName("lark.suit"), "lark.suit");
});

test("project skills take precedence over the pi directory", () => {
	writeSkill(piSkills(), "deploy", "---\ndescription: Global.\n---\n\nGlobal body.\n");
	writeSkill(
		path.join(project, ".pi", "skills"),
		"deploy",
		"---\ndescription: Local.\n---\n\nLocal body.\n",
	);
	const { skills } = discoverPrimarySkills(project);
	assert.equal(skills.get("deploy")?.description, "Local.");
	assert.equal(skills.get("deploy")?.origin, "project");
});

test("Claude allowed-tools names map onto Pi child tools", () => {
	writeSkill(
		piSkills(),
		"builder",
		"---\nallowed-tools: [Read, Glob, Grep, Bash, Write]\n---\n\nBody.\n",
	);
	const { skills } = discoverPrimarySkills(project);
	const builder = skills.get("builder");
	// Glob is Claude's name for Pi's find.
	assert.deepEqual(builder?.tools, ["read", "find", "grep", "bash", "write"]);
	assert.equal(builder?.toolsDeclared, true);
	assert.deepEqual(builder?.unsupportedTools, []);
});

test("scoped and comma-separated allowed-tools reduce to base names", () => {
	writeSkill(
		piSkills(),
		"scoped",
		'---\nallowed-tools: Bash(git:*), Bash(du:*), "Read(*)", Glob(*)\n---\n\nBody.\n',
	);
	const { skills } = discoverPrimarySkills(project);
	// The commas inside each scope must not split the list.
	assert.deepEqual(skills.get("scoped")?.tools, ["bash", "read", "find"]);
});

test("tools with no Pi equivalent are reported rather than silently kept", () => {
	writeSkill(
		piSkills(),
		"delegating",
		"---\nallowed-tools: [Read, Task(code-reviewer-java), AskUserQuestion]\n---\n\nBody.\n",
	);
	const { skills } = discoverPrimarySkills(project);
	const delegating = skills.get("delegating");
	assert.deepEqual(delegating?.tools, ["read"]);
	assert.deepEqual(delegating?.unsupportedTools, ["Task(code-reviewer-java)", "AskUserQuestion"]);
});

test("model inherit is treated as no declared model, whatever its casing", () => {
	writeSkill(piSkills(), "inheriting", "---\nmodel: inherit\n---\n\nBody.\n");
	writeSkill(piSkills(), "shouting", "---\nmodel: INHERIT\n---\n\nBody.\n");
	writeSkill(piSkills(), "pinned", "---\nmodel: haiku\n---\n\nBody.\n");
	const { skills } = discoverPrimarySkills(project);
	// Declaring no model is what makes the spawn fall back to the main model.
	assert.equal(skills.get("inheriting")?.model, undefined);
	assert.equal(skills.get("shouting")?.model, undefined);
	assert.equal(skills.get("pinned")?.model, "haiku");
});

test("disable-model-invocation is recorded and hides a skill from the roster", () => {
	writeSkill(piSkills(), "hidden", "---\ndisable-model-invocation: true\n---\n\nBody.\n");
	writeSkill(piSkills(), "shown", "---\ndescription: Visible.\n---\n\nBody.\n");
	const { skills } = discoverPrimarySkills(project);
	assert.equal(skills.get("hidden")?.disableModelInvocation, true);

	const registry = new SkillRegistry(discoverPrimarySkills, discoverAllSkills);
	registry.reset(project);
	assert.deepEqual(
		registry.listPrimary().map((skill) => skill.name),
		["shown"],
	);
	// Hidden from the roster, but still reachable when named explicitly.
	assert.ok(registry.find("hidden"));
});

test("a Claude Code fork skill parses with agent and other unknown fields ignored", () => {
	// The frontmatter shape Claude Code writes for a forked slash skill.
	writeSkill(
		piSkills(),
		"xm-gitcommit",
		[
			"---",
			"name: xm-gitcommit",
			"allowed-tools: Bash(git add:*), Bash(git status:*), Bash(git commit:*), Bash(git push:*)",
			"description: Commit and push.",
			"slash: true",
			"model: haiku",
			"user-invocable: true",
			"content: fork",
			"agent: general-purpose",
			"disable-model-invocation: true",
			"---",
			"",
			"Commit the pending changes.",
		].join("\n"),
	);
	const { skills, diagnostics } = discoverPrimarySkills(project);
	const skill = skills.get("xm-gitcommit");
	assert.ok(skill);
	assert.deepEqual(diagnostics, []);
	assert.equal(skill.fork, true);
	assert.equal(skill.model, "haiku");
	assert.deepEqual(skill.tools, ["bash"]);
	assert.equal(skill.disableModelInvocation, true);
	// `agent` names a Claude Code agent; the child runs on the skill body alone.
	assert.equal("agent" in skill, false);
});

test("content: fork is recorded and any other content value is not a fork", () => {
	writeSkill(piSkills(), "forked", "---\ncontent: fork\n---\n\nBody.\n");
	writeSkill(piSkills(), "inline", "---\ncontent: inline\n---\n\nBody.\n");
	writeSkill(piSkills(), "plain", "---\ndescription: Plain.\n---\n\nBody.\n");
	const { skills } = discoverPrimarySkills(project);
	assert.equal(skills.get("forked")?.fork, true);
	assert.equal(skills.get("inline")?.fork, false);
	assert.equal(skills.get("plain")?.fork, false);
});

test("skills without SKILL.md and empty bodies are skipped", () => {
	mkdirSync(path.join(piSkills(), "not-a-skill"), { recursive: true });
	writeSkill(piSkills(), "empty", "---\ndescription: Nothing.\n---\n\n");
	const { skills, diagnostics } = discoverPrimarySkills(project);
	assert.equal(skills.get("not-a-skill"), undefined);
	assert.equal(skills.get("empty"), undefined);
	assert.ok(diagnostics.some((line) => line.includes("empty body")));
});

test("symlinked skill directories are discovered", () => {
	const target = writeSkill(
		path.join(root, "shared"),
		"linked",
		"---\ndescription: Linked.\n---\n\nBody.\n",
	);
	mkdirSync(piSkills(), { recursive: true });
	symlinkSync(target, path.join(piSkills(), "linked"), "dir");
	const { skills } = discoverPrimarySkills(project);
	assert.equal(skills.get("linked")?.description, "Linked.");
});

test("the registry only scans fallback directories on a primary miss", () => {
	writeSkill(piSkills(), "primary", "---\ndescription: Primary.\n---\n\nBody.\n");
	let allScans = 0;
	const registry = new SkillRegistry(discoverPrimarySkills, (cwd) => {
		allScans++;
		return discoverAllSkills(cwd);
	});
	registry.reset(project);
	assert.ok(registry.find("primary"));
	assert.equal(allScans, 0);
	assert.equal(registry.find("absent"), undefined);
	assert.equal(allScans, 1);
});
