import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "vitest";
import { loadAliases, parseModelReference, resolveAlias } from "../src/aliases.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
	while (temporaryDirectories.length > 0) {
		const directory = temporaryDirectories.pop();
		if (directory) rmSync(directory, { force: true, recursive: true });
	}
});

function agentDirWith(contents: string | object): string {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-model-alias-"));
	temporaryDirectories.push(directory);
	const body = typeof contents === "string" ? contents : JSON.stringify(contents);
	writeFileSync(path.join(directory, "model-alias.json"), body, "utf8");
	return directory;
}

/** Model ids may contain slashes, so only the first one separates the provider. */
test("parseModelReference splits on the first slash only", () => {
	assert.deepEqual(parseModelReference("anthropic/claude-sonnet-4-5"), {
		provider: "anthropic",
		modelId: "claude-sonnet-4-5",
	});
	assert.deepEqual(parseModelReference("openrouter/anthropic/claude-sonnet"), {
		provider: "openrouter",
		modelId: "anthropic/claude-sonnet",
	});
	assert.equal(parseModelReference("no-slash"), undefined);
	assert.equal(parseModelReference("anthropic/"), undefined);
	assert.equal(parseModelReference("/claude"), undefined);
});

test("loadAliases returns empty maps when the file is absent", () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-model-alias-"));
	temporaryDirectories.push(directory);
	const loaded = loadAliases(directory);
	assert.equal(loaded.aliases.size, 0);
	assert.equal(loaded.skills.size, 0);
});

test("loadAliases warns and ignores a malformed file instead of throwing", () => {
	const warnings: string[] = [];
	const loaded = loadAliases(agentDirWith("{ not json"), (message) => warnings.push(message));
	assert.equal(loaded.aliases.size, 0);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /not valid JSON/u);
});

test("loadAliases accepts string, array, and object entry forms", () => {
	const loaded = loadAliases(
		agentDirWith({
			aliases: {
				single: "local/a",
				list: ["local/a", "local/b"],
				object: { models: ["local/a"], thinkingLevel: "low" },
				legacy: { model: "local/b" },
			},
		}),
	);
	assert.deepEqual(loaded.aliases.get("single"), { models: ["local/a"], thinkingLevel: undefined });
	assert.deepEqual(loaded.aliases.get("list")?.models, ["local/a", "local/b"]);
	assert.equal(loaded.aliases.get("object")?.thinkingLevel, "low");
	assert.deepEqual(loaded.aliases.get("legacy")?.models, ["local/b"]);
});

test("loadAliases reads a trailing thinking-level suffix", () => {
	const loaded = loadAliases(
		agentDirWith({ aliases: { high: "local/a:high", plain: "local/b", bogus: "local/c:nope" } }),
	);
	assert.equal(loaded.aliases.get("high")?.thinkingLevel, "high");
	assert.deepEqual(loaded.aliases.get("high")?.models, ["local/a"]);
	assert.equal(loaded.aliases.get("plain")?.thinkingLevel, undefined);
	// An unrecognized suffix is not a thinking level, so it stays part of the id.
	assert.deepEqual(loaded.aliases.get("bogus")?.models, ["local/c:nope"]);
});

test("loadAliases strips a thinking-level suffix from the single-value model field", () => {
	const loaded = loadAliases(
		agentDirWith({
			aliases: {
				suffix: { model: "local/a:high" },
				// An explicit field wins over a suffix rather than being overwritten by it.
				both: { model: "local/a:high", thinkingLevel: "low" },
				// A per-candidate suffix in a list applies to whichever candidate is picked.
				list: ["local/a:low", "local/b:max"],
			},
		}),
	);
	assert.deepEqual(loaded.aliases.get("suffix"), { models: ["local/a"], thinkingLevel: "high" });
	assert.equal(loaded.aliases.get("both")?.thinkingLevel, "low");
	assert.deepEqual(loaded.aliases.get("list")?.models, ["local/a", "local/b"]);
	assert.equal(loaded.aliases.get("list")?.thinkingLevel, "max");
});

test("loadAliases ignores an unrecognized thinkingLevel field", () => {
	const loaded = loadAliases(
		agentDirWith({ aliases: { bogus: { models: ["local/a"], thinkingLevel: "nope" } } }),
	);
	assert.deepEqual(loaded.aliases.get("bogus"), { models: ["local/a"], thinkingLevel: undefined });
});

test("loadAliases rejects invalid references, empty arrays, and bare alias names in aliases", () => {
	const warnings: string[] = [];
	const loaded = loadAliases(
		agentDirWith({
			aliases: { bad: "not-a-reference", empty: [], aliasTarget: "other", good: "local/a" },
		}),
		(message) => warnings.push(message),
	);
	assert.deepEqual([...loaded.aliases.keys()], ["good"]);
	assert.equal(warnings.length, 3);
});

test("loadAliases allows a bare alias name only as a single skill target", () => {
	const warnings: string[] = [];
	const loaded = loadAliases(
		agentDirWith({
			aliases: { fast: ["local/a", "local/b"] },
			skills: { review: "fast", direct: "local/a", mixed: ["fast", "local/b"] },
		}),
		(message) => warnings.push(message),
	);
	assert.deepEqual(loaded.skills.get("review")?.models, ["fast"]);
	assert.deepEqual(loaded.skills.get("direct")?.models, ["local/a"]);
	// A candidate list mixing an alias name with references has unclear semantics.
	assert.equal(loaded.skills.get("mixed"), undefined);
	assert.equal(warnings.length, 1);
});

const find = (provider: string, modelId: string) =>
	provider === "missing" ? undefined : ({ provider, id: modelId } as never);
const hasAuth = (model: { provider: string }) => model.provider !== "unauthed";

test("resolveAlias returns the only registered candidate", () => {
	const resolved = resolveAlias({ models: ["local/a"], thinkingLevel: "low" }, { find, hasAuth });
	assert.equal(resolved?.model.id, "a");
	assert.equal(resolved?.thinkingLevel, "low");
	assert.equal(resolved?.candidateCount, 1);
});

test("resolveAlias drops unregistered and uncredentialed candidates", () => {
	const resolved = resolveAlias(
		{ models: ["missing/a", "unauthed/b", "local/c"] },
		{ find, hasAuth },
	);
	assert.equal(resolved?.model.provider, "local");
	assert.equal(resolved?.candidateCount, 1);
});

test("resolveAlias returns undefined when no candidate is usable", () => {
	assert.equal(resolveAlias({ models: ["missing/a"] }, { find, hasAuth }), undefined);
	assert.equal(resolveAlias({ models: ["unauthed/a"] }, { find, hasAuth }), undefined);
});

test("resolveAlias picks every usable candidate across draws", () => {
	const definition = { models: ["local/a", "local/b", "local/c"] };
	const picked = new Set<string>();
	for (let index = 0; index < 600; index += 1) {
		const resolved = resolveAlias(definition, { find, hasAuth });
		assert.ok(resolved);
		picked.add(resolved.model.id);
	}
	assert.deepEqual([...picked].sort(), ["a", "b", "c"]);
});

test("resolveAlias keeps the random index in range at both bounds", () => {
	const definition = { models: ["local/a", "local/b"] };
	assert.equal(resolveAlias(definition, { find, hasAuth, random: () => 0 })?.model.id, "a");
	// A random() result arbitrarily close to 1 must not index past the end.
	const last = resolveAlias(definition, { find, hasAuth, random: () => 0.999_999_999_9 });
	assert.equal(last?.model.id, "b");
});

test("resolveAlias without a credential check keeps every registered candidate", () => {
	const resolved = resolveAlias({ models: ["unauthed/a", "local/b"] }, { find });
	assert.equal(resolved?.candidateCount, 2);
});
