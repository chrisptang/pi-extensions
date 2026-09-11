import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import {
	agentDirectories,
	discoverPrimaryAgents,
	normalizeAgentName,
	piAgentDirectory,
} from "../src/agent-definitions.js";
import { BUILTIN_AGENTS, seedBuiltinAgents } from "../src/builtin-agents.js";

let root: string;
let previousAgentDir: string | undefined;

beforeEach(() => {
	root = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agents-"));
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
});

afterEach(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(root, { recursive: true, force: true });
});

function writeAgent(directory: string, file: string, content: string): void {
	mkdirSync(directory, { recursive: true });
	writeFileSync(path.join(directory, file), content, "utf8");
}

test("piAgentDirectory honours PI_CODING_AGENT_DIR", () => {
	assert.equal(piAgentDirectory(), path.resolve(root));
	assert.equal(agentDirectories()[0].directory, path.join(path.resolve(root), "agents"));
});

test("primary discovery reads name, description, model, tools, and body", () => {
	writeAgent(
		path.join(root, "agents"),
		"explorer.md",
		"---\nname: explorer\ndescription: Reads code.\nmodel: haiku\ntools: read, grep\n---\n\nBody text.\n",
	);
	const { agents } = discoverPrimaryAgents();
	const explorer = agents.get("explorer");
	assert.ok(explorer);
	assert.equal(explorer.description, "Reads code.");
	assert.equal(explorer.model, "haiku");
	assert.deepEqual(explorer.tools, ["read", "grep"]);
	assert.equal(explorer.body, "Body text.");
	assert.equal(explorer.origin, "pi");
});

test("agent names are matched case-insensitively", () => {
	writeAgent(path.join(root, "agents"), "Explorer.md", "---\nname: EXPLORER\n---\n\nBody.\n");
	const { agents } = discoverPrimaryAgents();
	assert.ok(agents.get("explorer"));
	assert.equal(normalizeAgentName("  ExPlOrEr "), "explorer");
	assert.equal(normalizeAgentName("bad name"), undefined);
});

test("the filename supplies the name when frontmatter omits it", () => {
	writeAgent(path.join(root, "agents"), "reviewer.md", "Just a body.\n");
	const { agents } = discoverPrimaryAgents();
	const reviewer = agents.get("reviewer");
	assert.ok(reviewer);
	// Without a description the name stands in, so the roster line is never empty.
	assert.equal(reviewer.description, "reviewer");
});

test("unavailable tools are dropped with a diagnostic", () => {
	writeAgent(
		path.join(root, "agents"),
		"odd.md",
		"---\nname: odd\ntools: read, teleport\n---\n\nBody.\n",
	);
	const { agents, diagnostics } = discoverPrimaryAgents();
	assert.deepEqual(agents.get("odd")?.tools, ["read"]);
	assert.ok(diagnostics.some((line) => line.includes("teleport")));
});

test("an empty body is rejected", () => {
	writeAgent(path.join(root, "agents"), "hollow.md", "---\nname: hollow\n---\n\n\n");
	const { agents, diagnostics } = discoverPrimaryAgents();
	assert.equal(agents.get("hollow"), undefined);
	assert.ok(diagnostics.some((line) => line.includes("empty body")));
});

test("primary discovery ignores the optional lookup directories", () => {
	// discoverPrimaryAgents must never reach into ~/.claude or ~/.agents.
	assert.deepEqual([...discoverPrimaryAgents().agents.keys()], []);
});

test("seeding writes both built-ins and never overwrites user edits", () => {
	const directory = path.join(root, "agents");
	const first = seedBuiltinAgents(directory);
	assert.deepEqual(first.created.map((file) => path.basename(file)).sort(), [
		"builder.md",
		"explorer.md",
	]);
	assert.deepEqual(first.diagnostics, []);

	writeFileSync(path.join(directory, "explorer.md"), "---\nname: explorer\n---\n\nMine.\n", "utf8");
	const second = seedBuiltinAgents(directory);
	assert.deepEqual(second.created, []);
	assert.equal(discoverPrimaryAgents().agents.get("explorer")?.body, "Mine.");
});

test("the seeded built-ins parse into usable definitions", () => {
	seedBuiltinAgents(path.join(root, "agents"));
	const { agents, diagnostics } = discoverPrimaryAgents();
	assert.deepEqual(diagnostics, []);
	for (const builtin of BUILTIN_AGENTS) {
		const definition = agents.get(builtin.name);
		assert.ok(definition, `${builtin.name} should parse`);
		assert.ok(definition.description.length > 0);
		assert.ok(definition.tools.length > 0);
	}
	assert.equal(agents.get("explorer")?.model, "haiku");
	assert.equal(agents.get("builder")?.model, "sonnet");
	// The explorer must stay read-only, or delegation stops being safe by default.
	assert.deepEqual(agents.get("explorer")?.tools, ["read", "grep", "find", "ls"]);
});
