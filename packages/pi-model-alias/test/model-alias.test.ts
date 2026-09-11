import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import modelAlias from "../src/model-alias.js";

const temporaryDirectories: string[] = [];
let previousAgentDir: string | undefined;

beforeEach(() => {
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
});

afterEach(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	while (temporaryDirectories.length > 0) {
		const directory = temporaryDirectories.pop();
		if (directory) rmSync(directory, { force: true, recursive: true });
	}
});

/** Point Pi's agent dir at a temporary directory holding the given config. */
function useAgentDir(contents: object): string {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-model-alias-ext-"));
	temporaryDirectories.push(directory);
	writeFileSync(path.join(directory, "model-alias.json"), JSON.stringify(contents), "utf8");
	process.env.PI_CODING_AGENT_DIR = directory;
	return directory;
}

const model = (provider: string, id: string) => ({ provider, id }) as never;

function registryFor(available: Array<{ provider: string; id: string }>, unauthed: string[] = []) {
	return {
		find: (provider: string, modelId: string) =>
			available.find((entry) => entry.provider === provider && entry.id === modelId) as never,
		hasConfiguredAuth: (candidate: { provider: string }) => !unauthed.includes(candidate.provider),
		getApiKeyAndHeaders: async () => ({ ok: false, error: "missing" }),
		getAvailable: () => available as never[],
		getAll: () => available as never[],
		isUsingOAuth: () => false,
	};
}

test("registers the alias and reload commands", () => {
	useAgentDir({ aliases: { fast: "local/a" } });
	const harness = createMockPi();
	modelAlias(harness.pi);
	assert.deepEqual([...harness.commands.keys()].sort(), ["ma", "model-alias-reload"]);
});

test("/ma switches to the aliased model", async () => {
	useAgentDir({ aliases: { fast: "local/a" } });
	const harness = createMockPi();
	modelAlias(harness.pi);
	const { ctx, notifications } = createMockContext({
		modelRegistry: registryFor([{ provider: "local", id: "a" }]),
	});

	await harness.commands.get("ma")?.handler("fast", ctx);

	assert.deepEqual(harness.setModels, [{ provider: "local", id: "a" }]);
	assert.match(notifications.at(-1)?.message ?? "", /local\/a/u);
});

test("/ma applies a configured thinking level", async () => {
	useAgentDir({ aliases: { fast: { models: ["local/a"], thinkingLevel: "high" } } });
	const harness = createMockPi();
	modelAlias(harness.pi);
	const { ctx } = createMockContext({
		modelRegistry: registryFor([{ provider: "local", id: "a" }]),
	});

	await harness.commands.get("ma")?.handler("fast", ctx);

	assert.deepEqual(harness.thinkingLevels, ["high"]);
});

test("/ma reports a candidate count when the alias has several usable models", async () => {
	useAgentDir({ aliases: { fast: ["local/a", "local/b"] } });
	const harness = createMockPi();
	modelAlias(harness.pi);
	const { ctx, notifications } = createMockContext({
		modelRegistry: registryFor([
			{ provider: "local", id: "a" },
			{ provider: "local", id: "b" },
		]),
	});

	await harness.commands.get("ma")?.handler("fast", ctx);

	assert.match(notifications.at(-1)?.message ?? "", /1 of 2/u);
});

test("/ma reports an unknown alias without switching", async () => {
	useAgentDir({ aliases: { fast: "local/a" } });
	const harness = createMockPi();
	modelAlias(harness.pi);
	const { ctx, notifications } = createMockContext({
		modelRegistry: registryFor([{ provider: "local", id: "a" }]),
	});

	await harness.commands.get("ma")?.handler("nope", ctx);

	assert.deepEqual(harness.setModels, []);
	assert.equal(notifications.at(-1)?.level, "error");
});

test("/ma reports when no candidate has usable credentials", async () => {
	useAgentDir({ aliases: { fast: "local/a" } });
	const harness = createMockPi();
	modelAlias(harness.pi);
	const { ctx, notifications } = createMockContext({
		modelRegistry: registryFor([{ provider: "local", id: "a" }], ["local"]),
	});

	await harness.commands.get("ma")?.handler("fast", ctx);

	assert.deepEqual(harness.setModels, []);
	assert.equal(notifications.at(-1)?.level, "error");
});

test("/ma with no argument lists the configured aliases", async () => {
	useAgentDir({ aliases: { fast: "local/a", slow: "local/b" } });
	const harness = createMockPi();
	modelAlias(harness.pi);
	const { ctx, notifications } = createMockContext({
		modelRegistry: registryFor([{ provider: "local", id: "a" }]),
	});

	await harness.commands.get("ma")?.handler("", ctx);

	assert.deepEqual(harness.setModels, []);
	assert.match(notifications.at(-1)?.message ?? "", /fast/u);
	assert.match(notifications.at(-1)?.message ?? "", /slow/u);
});

test("argument completions describe single and multi-candidate aliases", () => {
	useAgentDir({ aliases: { fast: "local/a", pool: ["local/a", "local/b"] } });
	const harness = createMockPi();
	modelAlias(harness.pi);
	const completions = harness.commands.get("ma")?.getArgumentCompletions?.("") as Array<{
		value: string;
		description: string;
	}>;

	assert.equal(completions.find((item) => item.value === "fast")?.description, "local/a");
	assert.equal(
		completions.find((item) => item.value === "pool")?.description,
		"2 candidates (random)",
	);
});

test("a skill override switches the model and restores it once the agent settles", async () => {
	useAgentDir({ aliases: { fast: "local/b" }, skills: { review: "fast" } });
	const harness = createMockPi();
	modelAlias(harness.pi);
	const registry = registryFor([
		{ provider: "local", id: "a" },
		{ provider: "local", id: "b" },
	]);
	const { ctx } = createMockContext({
		model: model("local", "a"),
		thinkingLevel: "medium",
		modelRegistry: registry,
	});

	const result = await harness.events.get("input")?.[0]?.({ text: "/skill:review" }, ctx);

	// The input continues to normal skill expansion rather than being handled here.
	assert.deepEqual(result, { action: "continue" });
	assert.deepEqual(harness.setModels, [{ provider: "local", id: "b" }]);

	await harness.events.get("agent_settled")?.[0]?.({}, ctx);

	assert.deepEqual(harness.setModels.at(-1), { provider: "local", id: "a" });
	assert.deepEqual(harness.thinkingLevels.at(-1), "medium");
});

test("an unconfigured skill leaves the model untouched", async () => {
	useAgentDir({ skills: { review: "local/b" } });
	const harness = createMockPi();
	modelAlias(harness.pi);
	const { ctx } = createMockContext({
		model: model("local", "a"),
		modelRegistry: registryFor([{ provider: "local", id: "b" }]),
	});

	await harness.events.get("input")?.[0]?.({ text: "/skill:other" }, ctx);

	assert.deepEqual(harness.setModels, []);
});

test("a skill already on its target model does not switch or schedule a restore", async () => {
	useAgentDir({ skills: { review: "local/a" } });
	const harness = createMockPi();
	modelAlias(harness.pi);
	const { ctx } = createMockContext({
		model: model("local", "a"),
		modelRegistry: registryFor([{ provider: "local", id: "a" }]),
	});

	await harness.events.get("input")?.[0]?.({ text: "/skill:review" }, ctx);
	await harness.events.get("agent_settled")?.[0]?.({}, ctx);

	assert.deepEqual(harness.setModels, []);
});

test("a skill with no usable candidate warns and keeps the current model", async () => {
	useAgentDir({ skills: { review: "local/b" } });
	const harness = createMockPi();
	modelAlias(harness.pi);
	const { ctx, notifications } = createMockContext({
		model: model("local", "a"),
		modelRegistry: registryFor([{ provider: "local", id: "b" }], ["local"]),
	});

	await harness.events.get("input")?.[0]?.({ text: "/skill:review" }, ctx);

	assert.deepEqual(harness.setModels, []);
	assert.equal(notifications.at(-1)?.level, "warning");
});

test("ordinary input is ignored", async () => {
	useAgentDir({ skills: { review: "local/b" } });
	const harness = createMockPi();
	modelAlias(harness.pi);
	const { ctx } = createMockContext({
		model: model("local", "a"),
		modelRegistry: registryFor([{ provider: "local", id: "b" }]),
	});

	const result = await harness.events.get("input")?.[0]?.({ text: "hello there" }, ctx);

	assert.deepEqual(result, { action: "continue" });
	assert.deepEqual(harness.setModels, []);
});

test("a replaced session discards a pending restore", async () => {
	useAgentDir({ skills: { review: "local/b" } });
	const harness = createMockPi();
	modelAlias(harness.pi);
	const { ctx } = createMockContext({
		model: model("local", "a"),
		modelRegistry: registryFor([
			{ provider: "local", id: "a" },
			{ provider: "local", id: "b" },
		]),
	});

	await harness.events.get("input")?.[0]?.({ text: "/skill:review" }, ctx);
	await harness.events.get("session_start")?.[0]?.({ reason: "new" }, ctx);
	await harness.events.get("agent_settled")?.[0]?.({}, ctx);

	// Only the skill switch happened; the stale restore was dropped with the session.
	assert.deepEqual(harness.setModels, [{ provider: "local", id: "b" }]);
});

test("the reload command re-reads the configuration file", async () => {
	const directory = useAgentDir({ aliases: { fast: "local/a" } });
	const harness = createMockPi();
	modelAlias(harness.pi);
	const { ctx, notifications } = createMockContext({
		modelRegistry: registryFor([{ provider: "local", id: "a" }]),
	});

	await harness.commands.get("ma")?.handler("", ctx);
	writeFileSync(
		path.join(directory, "model-alias.json"),
		JSON.stringify({ aliases: { fast: "local/a", extra: "local/a" } }),
		"utf8",
	);
	await harness.commands.get("model-alias-reload")?.handler("", ctx);

	assert.match(notifications.at(-1)?.message ?? "", /2 aliases/u);
});
