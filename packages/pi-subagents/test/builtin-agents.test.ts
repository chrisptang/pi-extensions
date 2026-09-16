import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { discoverPrimaryAgents } from "../src/agent-definitions.js";
import { BUILTIN_AGENTS, seedBuiltinAgents } from "../src/builtin-agents.js";

let directory: string;

beforeEach(() => {
	directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-seed-"));
});

afterEach(() => {
	fs.rmSync(directory, { recursive: true, force: true });
	delete process.env.PI_CODING_AGENT_DIR;
});

test("seeds the built-in definitions and parses them back", () => {
	const target = path.join(directory, "agents");
	const result = seedBuiltinAgents(target);
	assert.deepEqual(result.diagnostics, []);
	assert.deepEqual(result.backups, []);
	assert.deepEqual(
		result.created.map((file) => path.basename(file)),
		["explorer.md", "builder.md", "architect.md"],
	);

	process.env.PI_CODING_AGENT_DIR = directory;
	const { agents, diagnostics } = discoverPrimaryAgents();
	assert.deepEqual(diagnostics, []);
	assert.deepEqual([...agents.keys()].sort(), ["architect", "builder", "explorer"]);
	const explorer = agents.get("explorer");
	assert.equal(explorer?.model, "haiku");
	assert.deepEqual(explorer?.tools, ["read", "grep", "find", "ls", "bash"]);
	assert.equal(explorer?.origin, "pi");
	assert.ok(explorer?.body.startsWith("You are a read-only codebase explorer."));
	const builder = agents.get("builder");
	assert.equal(builder?.model, "sonnet");
	assert.ok(builder?.tools.includes("edit"));
	// The architect describes the main session: no child model, no child tools.
	const architect = agents.get("architect");
	assert.equal(architect?.role, "main");
	assert.equal(architect?.model, undefined);
	assert.equal(architect?.thinkingLevel, undefined);
	assert.ok(architect?.body.includes("`explorer`") && architect.body.includes("`builder`"));
	assert.equal(explorer?.role, "subagent");
});

test("replaces a stale definition so an upgrade always lands", () => {
	const target = path.join(directory, "agents");
	seedBuiltinAgents(target);
	const explorer = path.join(target, "explorer.md");
	const stale = fs.readFileSync(explorer, "utf8").replace("model: haiku", "model: my-own-alias");
	fs.writeFileSync(explorer, stale);

	const result = seedBuiltinAgents(target);
	assert.deepEqual(result.created, []);
	assert.deepEqual(
		result.updated.map((file) => path.basename(file)),
		["explorer.md"],
	);
	const shipped = BUILTIN_AGENTS.find((agent) => agent.name === "explorer")?.content;
	assert.equal(fs.readFileSync(explorer, "utf8"), shipped);

	// The displaced contents are recoverable, and the replacement is announced.
	assert.deepEqual(
		result.backups.map((file) => path.basename(file)),
		["explorer.md.bak"],
	);
	assert.equal(fs.readFileSync(`${explorer}.bak`, "utf8"), stale);
	assert.equal(result.diagnostics.length, 1);
	assert.match(result.diagnostics[0] ?? "", /Replaced built-in agent .*explorer\.md/);
	assert.match(result.diagnostics[0] ?? "", /explorer\.md\.bak/);
});

test("a backup holds the last displaced version, not one file per load", () => {
	const target = path.join(directory, "agents");
	seedBuiltinAgents(target);
	const explorer = path.join(target, "explorer.md");
	fs.writeFileSync(explorer, "first edit");
	seedBuiltinAgents(target);
	fs.writeFileSync(explorer, "second edit");
	seedBuiltinAgents(target);

	assert.equal(fs.readFileSync(`${explorer}.bak`, "utf8"), "second edit");
	const backups = fs.readdirSync(target).filter((name) => name.endsWith(".bak"));
	assert.deepEqual(backups, ["explorer.md.bak"]);
});

test("a backup is never loaded as a definition", () => {
	const target = path.join(directory, "agents");
	seedBuiltinAgents(target);
	fs.writeFileSync(path.join(target, "explorer.md"), "---\nname: explorer\n---\n\nMine.");
	seedBuiltinAgents(target);

	process.env.PI_CODING_AGENT_DIR = directory;
	const { agents, diagnostics } = discoverPrimaryAgents();
	assert.deepEqual(diagnostics, []);
	assert.deepEqual([...agents.keys()].sort(), ["architect", "builder", "explorer"]);
});

test("leaves the user file in place when the backup cannot be written", () => {
	const target = path.join(directory, "agents");
	seedBuiltinAgents(target);
	const explorer = path.join(target, "explorer.md");
	fs.writeFileSync(explorer, "my own version");
	// A directory where the backup file should go makes the backup write fail.
	fs.mkdirSync(`${explorer}.bak`);

	const result = seedBuiltinAgents(target);
	assert.deepEqual(result.updated, []);
	assert.deepEqual(result.backups, []);
	assert.equal(result.diagnostics.length, 1);
	assert.match(result.diagnostics[0] ?? "", /Cannot back up agent/);
	assert.equal(fs.readFileSync(explorer, "utf8"), "my own version");
});

test("rewrites nothing when every definition is already current", () => {
	const target = path.join(directory, "agents");
	seedBuiltinAgents(target);
	const before = fs.statSync(path.join(target, "explorer.md")).mtimeMs;

	const result = seedBuiltinAgents(target);
	assert.deepEqual(result.created, []);
	assert.deepEqual(result.updated, []);
	assert.deepEqual(result.backups, []);
	assert.deepEqual(result.diagnostics, []);
	assert.equal(fs.statSync(path.join(target, "explorer.md")).mtimeMs, before);
});

test("reports a diagnostic instead of throwing when the directory is unwritable", () => {
	const target = path.join(directory, "agents");
	// A file where the directory should be makes both mkdir and write fail.
	fs.writeFileSync(target, "not a directory");
	const result = seedBuiltinAgents(target);
	assert.deepEqual(result.created, []);
	assert.deepEqual(result.updated, []);
	assert.deepEqual(result.backups, []);
	assert.equal(result.diagnostics.length, 1);
	assert.match(result.diagnostics[0] ?? "", /Cannot create agent directory/);
});

test("every built-in name is a valid lookup name", () => {
	for (const agent of BUILTIN_AGENTS) {
		assert.match(agent.name, /^[a-z0-9][a-z0-9_-]*$/);
		assert.ok(agent.content.startsWith("---\n"));
	}
});
