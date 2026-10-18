import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { resolveTitlePrompt } from "../src/prompt-file.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scopes() {
	const root = mkdtempSync(join(tmpdir(), "pi-title-prompts-"));
	roots.push(root);
	const cwd = join(root, "workspace");
	const agentDir = join(root, "agent");
	return { cwd, agentDir, projectTrusted: true };
}

function writePrompt(base: string, text: string) {
	mkdirSync(join(base, "system-prompts"), { recursive: true });
	writeFileSync(join(base, "system-prompts", "auto-title.md"), text);
}

test("missing prompt loads create no files or directories", () => {
	const options = scopes();
	assert.equal(resolveTitlePrompt(options), undefined);
	assert.equal(existsSync(options.cwd), false);
	assert.equal(existsSync(options.agentDir), false);
});

test("trusted project prompts override user prompts; untrusted projects are ignored", () => {
	const options = scopes();
	writePrompt(options.agentDir, "user rules");
	writePrompt(join(options.cwd, ".pi"), " project rules ");
	assert.equal(resolveTitlePrompt(options), "project rules");
	assert.equal(resolveTitlePrompt({ ...options, projectTrusted: false }), "user rules");
});

test("absent or blank files fall back to the next scope, then the built-in default", () => {
	const options = scopes();
	writePrompt(options.agentDir, "user rules");
	assert.equal(resolveTitlePrompt(options), "user rules");
	writePrompt(join(options.cwd, ".pi"), "  \n\t");
	assert.equal(resolveTitlePrompt(options), "user rules");
	writePrompt(options.agentDir, " ");
	assert.equal(resolveTitlePrompt(options), undefined);
});

test("read errors warn and fall back; each resolution reads fresh content", () => {
	const options = scopes();
	writePrompt(options.agentDir, "first");
	mkdirSync(join(options.cwd, ".pi", "system-prompts", "auto-title.md"), { recursive: true });
	const warnings: string[] = [];
	assert.equal(
		resolveTitlePrompt({ ...options, warn: (message) => warnings.push(message) }),
		"first",
	);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /Could not read/);
	writePrompt(options.agentDir, "second");
	assert.equal(resolveTitlePrompt({ ...options, projectTrusted: false }), "second");
});
