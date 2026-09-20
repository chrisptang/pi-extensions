import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

test("role defaults to subagent, accepts main, and rejects anything else", () => {
	const directory = path.join(root, "agents");
	writeAgent(directory, "plain.md", "---\nname: plain\n---\n\nBody.\n");
	writeAgent(directory, "lead.md", "---\nname: lead\nrole: Main\n---\n\nBody.\n");
	writeAgent(directory, "odd.md", "---\nname: odd\nrole: sidekick\n---\n\nBody.\n");
	const { agents, diagnostics } = discoverPrimaryAgents();
	assert.equal(agents.get("plain")?.role, "subagent");
	assert.equal(agents.get("lead")?.role, "main");
	assert.equal(agents.get("odd")?.role, "subagent");
	assert.ok(diagnostics.some((line) => line.includes("invalid role sidekick")));
});

test("an empty body is rejected", () => {
	writeAgent(path.join(root, "agents"), "hollow.md", "---\nname: hollow\n---\n\n\n");
	const { agents, diagnostics } = discoverPrimaryAgents();
	assert.equal(agents.get("hollow"), undefined);
	assert.ok(diagnostics.some((line) => line.includes("empty body")));
});

test("symlinked definitions are loaded and broken links are skipped", () => {
	// Shared agent trees are commonly linked in one entry at a time, so a
	// symlink to a `.md` file must be read like a regular file.
	const directory = path.join(root, "agents");
	const shared = path.join(root, "shared");
	writeAgent(shared, "reviewer.md", "---\nname: reviewer\n---\n\nLinked body.\n");
	mkdirSync(directory, { recursive: true });
	symlinkSync(path.join(shared, "reviewer.md"), path.join(directory, "reviewer.md"));
	symlinkSync(path.join(shared, "gone.md"), path.join(directory, "gone.md"));
	symlinkSync(shared, path.join(directory, "tree.md"));

	const { agents, diagnostics } = discoverPrimaryAgents();
	assert.equal(agents.get("reviewer")?.body, "Linked body.");
	assert.equal(agents.get("gone"), undefined);
	assert.equal(agents.get("tree"), undefined);
	assert.deepEqual(diagnostics, []);
});

test("primary discovery ignores the optional lookup directories", () => {
	// discoverPrimaryAgents must never reach into ~/.claude or ~/.agents.
	assert.deepEqual([...discoverPrimaryAgents().agents.keys()], []);
});

test("seeding writes the built-ins and restores a replaced one", () => {
	const directory = path.join(root, "agents");
	const first = seedBuiltinAgents(directory);
	assert.deepEqual(first.created.map((file) => path.basename(file)).sort(), [
		"architect.md",
		"builder.md",
		"explorer.md",
	]);
	assert.deepEqual(first.updated, []);
	assert.deepEqual(first.diagnostics, []);

	writeFileSync(path.join(directory, "explorer.md"), "---\nname: explorer\n---\n\nMine.\n", "utf8");
	const second = seedBuiltinAgents(directory);
	assert.deepEqual(second.created, []);
	assert.deepEqual(
		second.updated.map((file) => path.basename(file)),
		["explorer.md"],
	);
	// The built-ins are extension-owned, so the shipped body wins over the edit.
	assert.notEqual(discoverPrimaryAgents().agents.get("explorer")?.body, "Mine.");
});

test("a user-named definition is never touched by seeding", () => {
	const directory = path.join(root, "agents");
	seedBuiltinAgents(directory);
	const mine = path.join(directory, "my-explorer.md");
	const body = "---\nname: my-explorer\n---\n\nMine.\n";
	writeFileSync(mine, body, "utf8");

	const result = seedBuiltinAgents(directory);
	assert.deepEqual(result.updated, []);
	assert.equal(discoverPrimaryAgents().agents.get("my-explorer")?.body, "Mine.");
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
	// The explorer carries bash for the read-only shell toolbox, but never a write tool:
	// its body, not the tool list, is what keeps it read-only.
	assert.deepEqual(agents.get("explorer")?.tools, ["read", "grep", "find", "ls", "bash"]);
	assert.ok(!agents.get("explorer")?.tools.some((tool) => tool === "edit" || tool === "write"));
});
