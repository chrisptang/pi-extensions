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
	assert.deepEqual(
		result.created.map((file) => path.basename(file)),
		["explorer.md", "builder.md"],
	);

	process.env.PI_CODING_AGENT_DIR = directory;
	const { agents, diagnostics } = discoverPrimaryAgents();
	assert.deepEqual(diagnostics, []);
	assert.deepEqual([...agents.keys()].sort(), ["builder", "explorer"]);
	const explorer = agents.get("explorer");
	assert.equal(explorer?.model, "haiku");
	assert.deepEqual(explorer?.tools, ["read", "grep", "find", "ls"]);
	assert.equal(explorer?.origin, "pi");
	assert.ok(explorer?.body.startsWith("You are a read-only codebase explorer."));
	const builder = agents.get("builder");
	assert.equal(builder?.model, "sonnet");
	assert.ok(builder?.tools.includes("edit"));
});

test("never overwrites an edited definition on reseed", () => {
	const target = path.join(directory, "agents");
	seedBuiltinAgents(target);
	const explorer = path.join(target, "explorer.md");
	const edited = fs.readFileSync(explorer, "utf8").replace("model: haiku", "model: my-own-alias");
	fs.writeFileSync(explorer, edited);

	const result = seedBuiltinAgents(target);
	assert.deepEqual(result.created, []);
	assert.deepEqual(result.diagnostics, []);
	assert.equal(fs.readFileSync(explorer, "utf8"), edited);
});

test("reports a diagnostic instead of throwing when the directory is unwritable", () => {
	const target = path.join(directory, "agents");
	// A file where the directory should be makes both mkdir and write fail.
	fs.writeFileSync(target, "not a directory");
	const result = seedBuiltinAgents(target);
	assert.deepEqual(result.created, []);
	assert.equal(result.diagnostics.length, 1);
	assert.match(result.diagnostics[0] ?? "", /Cannot create agent directory/);
});

test("every built-in name is a valid lookup name", () => {
	for (const agent of BUILTIN_AGENTS) {
		assert.match(agent.name, /^[a-z0-9][a-z0-9_-]*$/);
		assert.ok(agent.content.startsWith("---\n"));
	}
});
