import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { isInheritedModel, resolveAgentModel } from "../src/agent-model.js";

let root: string;

beforeEach(() => {
	root = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-model-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function writeAliases(aliases: Record<string, unknown>): void {
	writeFileSync(path.join(root, "model-alias.json"), JSON.stringify({ aliases }), "utf8");
}

const anyModel = { isUsable: () => true };
const noModel = { isUsable: () => false };

test("no requested model keeps the main agent's model", () => {
	assert.deepEqual(resolveAgentModel(undefined, anyModel, { aliasDirectory: root }), {});
});

test("model inherit keeps the main agent's model without reporting a limitation", () => {
	// `inherit` is an explicit request to keep the main model, not a failed alias
	// lookup, so it must resolve as silently as omitting the field entirely.
	for (const requested of ["inherit", "Inherit", "  INHERIT  "]) {
		assert.deepEqual(resolveAgentModel(requested, anyModel, { aliasDirectory: root }), {});
	}
	assert.equal(isInheritedModel("inherit"), true);
	assert.equal(isInheritedModel("haiku"), false);
	assert.equal(isInheritedModel(undefined), false);
});

test("a concrete reference is used when it is usable", () => {
	const result = resolveAgentModel("local/gpt-5.6-luna", anyModel, { aliasDirectory: root });
	assert.equal(result.model, "local/gpt-5.6-luna");
	assert.equal(result.limitation, undefined);
});

test("model IDs keep slashes after the provider", () => {
	const seen: string[] = [];
	resolveAgentModel("openrouter/anthropic/claude-sonnet", {
		isUsable: (provider, modelId) => {
			seen.push(`${provider}|${modelId}`);
			return true;
		},
	});
	assert.deepEqual(seen, ["openrouter|anthropic/claude-sonnet"]);
});

test("an alias resolves through model-alias.json", () => {
	writeAliases({ haiku: "local/gpt-5.6-luna" });
	const result = resolveAgentModel("haiku", anyModel, { aliasDirectory: root });
	assert.equal(result.model, "local/gpt-5.6-luna");
	assert.equal(result.limitation, undefined);
});

test("a multi-candidate alias picks among usable candidates only", () => {
	writeAliases({ sonnet: ["local/a", "local/b", "local/c"] });
	const result = resolveAgentModel(
		"sonnet",
		{ isUsable: (_provider, modelId) => modelId === "c" },
		{ aliasDirectory: root, random: () => 0 },
	);
	// Unusable candidates are dropped before the pick, so "c" is the only option.
	assert.equal(result.model, "local/c");
});

test("the object alias form and a thinking suffix are both accepted", () => {
	writeAliases({ opus: { models: ["local/sol:high"] } });
	const result = resolveAgentModel("opus", anyModel, { aliasDirectory: root });
	assert.equal(result.model, "local/sol");
});

test("alias names are matched case-insensitively", () => {
	writeAliases({ Haiku: "local/luna" });
	assert.equal(resolveAgentModel("HAIKU", anyModel, { aliasDirectory: root }).model, "local/luna");
});

test("an undefined alias falls back with a limitation", () => {
	writeAliases({ opus: "local/sol" });
	const result = resolveAgentModel("haiku", anyModel, { aliasDirectory: root });
	assert.equal(result.model, undefined);
	assert.match(result.limitation ?? "", /not defined/);
});

test("an alias whose candidates are all unusable falls back with a limitation", () => {
	writeAliases({ haiku: ["local/a", "local/b"] });
	const result = resolveAgentModel("haiku", noModel, { aliasDirectory: root });
	assert.equal(result.model, undefined);
	assert.match(result.limitation ?? "", /usable credentials/);
});

test("an unusable concrete reference falls back with a limitation", () => {
	const result = resolveAgentModel("local/missing", noModel, { aliasDirectory: root });
	assert.equal(result.model, undefined);
	assert.match(result.limitation ?? "", /unavailable/);
});

test("a missing or malformed alias file falls back instead of throwing", () => {
	assert.match(
		resolveAgentModel("haiku", anyModel, { aliasDirectory: root }).limitation ?? "",
		/not defined/,
	);
	writeFileSync(path.join(root, "model-alias.json"), "{ not json", "utf8");
	assert.match(
		resolveAgentModel("haiku", anyModel, { aliasDirectory: root }).limitation ?? "",
		/not defined/,
	);
});
