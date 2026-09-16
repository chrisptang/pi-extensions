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

function setContextModel(ctx: unknown, value: unknown): void {
	(ctx as { model?: unknown }).model = value;
}

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

test("/ma holds the same model across repeated switches", async () => {
	useAgentDir({ aliases: { pool: ["local/a", "local/b", "local/c"] } });
	const harness = createMockPi();
	modelAlias(harness.pi);
	const { ctx } = createMockContext({
		modelRegistry: registryFor([
			{ provider: "local", id: "a" },
			{ provider: "local", id: "b" },
			{ provider: "local", id: "c" },
		]),
	});

	for (let index = 0; index < 30; index += 1) {
		await harness.commands.get("ma")?.handler("pool", ctx);
	}

	const chosen = new Set(harness.setModels.map((entry) => (entry as { id: string }).id));
	assert.equal(chosen.size, 1);
});

test("/ma reports a held model rather than a candidate count", async () => {
	useAgentDir({ aliases: { pool: ["local/a", "local/b"] } });
	const harness = createMockPi();
	modelAlias(harness.pi);
	const { ctx, notifications } = createMockContext({
		modelRegistry: registryFor([
			{ provider: "local", id: "a" },
			{ provider: "local", id: "b" },
		]),
	});

	await harness.commands.get("ma")?.handler("pool", ctx);
	assert.match(notifications.at(-1)?.message ?? "", /1 of 2/u);
	await harness.commands.get("ma")?.handler("pool", ctx);
	assert.match(notifications.at(-1)?.message ?? "", /\(held\)/u);
});

test("a rate limit sidelines the candidate and switches to another", async () => {
	useAgentDir({ aliases: { pool: ["local/a", "local/b"] } });
	const harness = createMockPi();
	modelAlias(harness.pi);
	const registry = registryFor([
		{ provider: "local", id: "a" },
		{ provider: "local", id: "b" },
	]);
	const { ctx, notifications } = createMockContext({ modelRegistry: registry });

	await harness.commands.get("ma")?.handler("pool", ctx);
	const first = harness.setModels.at(-1) as { id: string };
	// The session is on the model the alias just picked, as it would be in a real run.
	setContextModel(ctx, first);

	await harness.events.get("after_provider_response")?.[0]?.(
		{ type: "after_provider_response", status: 429, headers: { "retry-after": "30" } },
		ctx,
	);

	const second = harness.setModels.at(-1) as { id: string };
	assert.notEqual(second.id, first.id);
	assert.match(notifications.at(-1)?.message ?? "", /rate limited \(30s\)/u);
});

test("the sidelined candidate is not drawn again while it cools down", async () => {
	useAgentDir({ aliases: { pool: ["local/a", "local/b"] } });
	const harness = createMockPi();
	modelAlias(harness.pi);
	const { ctx } = createMockContext({
		modelRegistry: registryFor([
			{ provider: "local", id: "a" },
			{ provider: "local", id: "b" },
		]),
	});

	await harness.commands.get("ma")?.handler("pool", ctx);
	const first = harness.setModels.at(-1) as { id: string };
	setContextModel(ctx, first);
	await harness.events.get("after_provider_response")?.[0]?.(
		{ type: "after_provider_response", status: 429, headers: { "retry-after": "300" } },
		ctx,
	);

	const after = harness.setModels.at(-1) as { id: string };
	for (let index = 0; index < 20; index += 1) {
		await harness.commands.get("ma")?.handler("pool", ctx);
		assert.equal((harness.setModels.at(-1) as { id: string }).id, after.id);
	}
});

test("a successful response leaves the model alone", async () => {
	useAgentDir({ aliases: { pool: ["local/a", "local/b"] } });
	const harness = createMockPi();
	modelAlias(harness.pi);
	const { ctx } = createMockContext({
		modelRegistry: registryFor([
			{ provider: "local", id: "a" },
			{ provider: "local", id: "b" },
		]),
	});

	await harness.commands.get("ma")?.handler("pool", ctx);
	setContextModel(ctx, harness.setModels.at(-1));
	await harness.events.get("after_provider_response")?.[0]?.(
		{ type: "after_provider_response", status: 200, headers: {} },
		ctx,
	);

	assert.equal(harness.setModels.length, 1);
});

test("a rate limit on a single-candidate alias warns without switching", async () => {
	useAgentDir({ aliases: { only: "local/a" } });
	const harness = createMockPi();
	modelAlias(harness.pi);
	const { ctx, notifications } = createMockContext({
		modelRegistry: registryFor([{ provider: "local", id: "a" }]),
	});

	await harness.commands.get("ma")?.handler("only", ctx);
	setContextModel(ctx, harness.setModels.at(-1));
	await harness.events.get("after_provider_response")?.[0]?.(
		{ type: "after_provider_response", status: 429, headers: {} },
		ctx,
	);

	assert.equal(harness.setModels.length, 1);
	assert.match(notifications.at(-1)?.message ?? "", /no other candidate/u);
});

/** A limit hit after the user moved off the alias must not be blamed on the alias. */
test("a rate limit on a model the alias did not select is ignored", async () => {
	useAgentDir({ aliases: { pool: ["local/a", "local/b"] } });
	const harness = createMockPi();
	modelAlias(harness.pi);
	const { ctx } = createMockContext({
		modelRegistry: registryFor([
			{ provider: "local", id: "a" },
			{ provider: "local", id: "b" },
		]),
	});

	await harness.commands.get("ma")?.handler("pool", ctx);
	setContextModel(ctx, { provider: "other", id: "z" });
	await harness.events.get("after_provider_response")?.[0]?.(
		{ type: "after_provider_response", status: 429, headers: {} },
		ctx,
	);

	assert.equal(harness.setModels.length, 1);
});

test("a rate limit before any alias switch is ignored", async () => {
	useAgentDir({ aliases: { pool: ["local/a", "local/b"] } });
	const harness = createMockPi();
	modelAlias(harness.pi);
	const { ctx } = createMockContext({
		modelRegistry: registryFor([{ provider: "local", id: "a" }]),
	});

	await harness.events.get("after_provider_response")?.[0]?.(
		{ type: "after_provider_response", status: 429, headers: {} },
		ctx,
	);

	assert.deepEqual(harness.setModels, []);
});

test("a skill pointing at an alias shares that alias's held model", async () => {
	useAgentDir({ aliases: { pool: ["local/a", "local/b"] }, skills: { review: "pool" } });
	const harness = createMockPi();
	modelAlias(harness.pi);
	const { ctx } = createMockContext({
		model: model("local", "z"),
		modelRegistry: registryFor([
			{ provider: "local", id: "a" },
			{ provider: "local", id: "b" },
			{ provider: "local", id: "z" },
		]),
	});

	await harness.commands.get("ma")?.handler("pool", ctx);
	const held = harness.setModels.at(-1) as { id: string };
	await harness.events.get("input")?.[0]?.({ text: "/skill:review" }, ctx);

	assert.equal((harness.setModels.at(-1) as { id: string }).id, held.id);
});

test("a skill with inline candidates holds its own model across runs", async () => {
	useAgentDir({ skills: { review: ["local/a", "local/b", "local/c"] } });
	const harness = createMockPi();
	modelAlias(harness.pi);
	const registry = registryFor([
		{ provider: "local", id: "a" },
		{ provider: "local", id: "b" },
		{ provider: "local", id: "c" },
		{ provider: "local", id: "z" },
	]);

	const picks = new Set<string>();
	for (let index = 0; index < 20; index += 1) {
		const { ctx } = createMockContext({ model: model("local", "z"), modelRegistry: registry });
		await harness.events.get("input")?.[0]?.({ text: "/skill:review" }, ctx);
		picks.add((harness.setModels.at(-1) as { id: string }).id);
		await harness.events.get("agent_settled")?.[0]?.({}, ctx);
	}

	assert.deepEqual([...picks], [...picks].slice(0, 1));
});

test("a new session releases held models and cooldowns", async () => {
	useAgentDir({ aliases: { pool: ["local/a", "local/b"] } });
	const harness = createMockPi();
	modelAlias(harness.pi);
	const { ctx } = createMockContext({
		modelRegistry: registryFor([
			{ provider: "local", id: "a" },
			{ provider: "local", id: "b" },
		]),
	});

	await harness.commands.get("ma")?.handler("pool", ctx);
	setContextModel(ctx, harness.setModels.at(-1));
	await harness.events.get("after_provider_response")?.[0]?.(
		{ type: "after_provider_response", status: 429, headers: { "retry-after": "600" } },
		ctx,
	);
	await harness.events.get("session_start")?.[0]?.({ reason: "new" }, ctx);

	// With the cooldown cleared, both candidates are eligible again.
	const seen = new Set<string>();
	for (let index = 0; index < 200; index += 1) {
		await harness.events.get("session_start")?.[0]?.({ reason: "new" }, ctx);
		await harness.commands.get("ma")?.handler("pool", ctx);
		seen.add((harness.setModels.at(-1) as { id: string }).id);
	}
	assert.deepEqual([...seen].sort(), ["a", "b"]);
});

test("reloading the configuration releases held models", async () => {
	const directory = useAgentDir({ aliases: { pool: ["local/a", "local/b"] } });
	const harness = createMockPi();
	modelAlias(harness.pi);
	const { ctx } = createMockContext({
		modelRegistry: registryFor([
			{ provider: "local", id: "a" },
			{ provider: "local", id: "b" },
		]),
	});

	const seen = new Set<string>();
	for (let index = 0; index < 200; index += 1) {
		await harness.commands.get("ma")?.handler("pool", ctx);
		seen.add((harness.setModels.at(-1) as { id: string }).id);
		writeFileSync(
			path.join(directory, "model-alias.json"),
			JSON.stringify({ aliases: { pool: ["local/a", "local/b"] } }),
			"utf8",
		);
		await harness.commands.get("model-alias-reload")?.handler("", ctx);
	}
	assert.deepEqual([...seen].sort(), ["a", "b"]);
});

/** Run the extension's startup handler with a synthesized `pi --model <value>` argv. */
async function startupWithCliModel(
	harness: ReturnType<typeof createMockPi>,
	ctx: unknown,
	args: string[],
) {
	const previous = process.argv;
	process.argv = ["/usr/bin/node", "/usr/bin/pi", ...args];
	try {
		await harness.events.get("session_start")?.[0]?.({ reason: "startup" }, ctx);
	} finally {
		process.argv = previous;
	}
}

test("pi --model <alias> starts the session on the aliased model", async () => {
	useAgentDir({ aliases: { sonnet: "local/terra" } });
	const harness = createMockPi();
	modelAlias(harness.pi);
	const { ctx, notifications } = createMockContext({
		modelRegistry: registryFor([
			{ provider: "local", id: "terra" },
			{ provider: "bedrock", id: "claude-sonnet" },
		]),
	});
	// Pi's own fuzzy match landed on an unrelated model that merely contains the name.
	setContextModel(ctx, model("bedrock", "claude-sonnet"));

	await startupWithCliModel(harness, ctx, ["--model", "sonnet"]);

	assert.deepEqual(harness.setModels, [{ provider: "local", id: "terra" }]);
	assert.match(notifications.at(-1)?.message ?? "", /local\/terra/u);
});

test("pi --model <alias> applies the alias thinking level", async () => {
	useAgentDir({ aliases: { deep: "local/a:high" } });
	const harness = createMockPi();
	modelAlias(harness.pi);
	const { ctx } = createMockContext({
		modelRegistry: registryFor([{ provider: "local", id: "a" }]),
	});
	setContextModel(ctx, model("local", "other"));

	await startupWithCliModel(harness, ctx, ["--model", "deep"]);

	assert.deepEqual(harness.setModels, [{ provider: "local", id: "a" }]);
	assert.deepEqual(harness.thinkingLevels, ["high"]);
});

test("pi --model <alias> holds its pick so a later /ma stays on it", async () => {
	useAgentDir({ aliases: { pool: ["local/a", "local/b"] } });
	const harness = createMockPi();
	modelAlias(harness.pi);
	const { ctx } = createMockContext({
		modelRegistry: registryFor([
			{ provider: "local", id: "a" },
			{ provider: "local", id: "b" },
		]),
	});
	setContextModel(ctx, model("local", "other"));

	await startupWithCliModel(harness, ctx, ["--model", "pool"]);
	const startupPick = harness.setModels.at(-1);
	for (let index = 0; index < 50; index += 1) {
		await harness.commands.get("ma")?.handler("pool", ctx);
		assert.deepEqual(harness.setModels.at(-1), startupPick);
	}
});

test("pi --model <model-id> leaves a non-alias value to Pi", async () => {
	useAgentDir({ aliases: { sonnet: "local/terra" } });
	const harness = createMockPi();
	modelAlias(harness.pi);
	const { ctx } = createMockContext({
		modelRegistry: registryFor([{ provider: "local", id: "a" }]),
	});
	setContextModel(ctx, model("local", "a"));

	await startupWithCliModel(harness, ctx, ["--model", "local/a"]);

	assert.deepEqual(harness.setModels, []);
});

test("pi --model <alias> does not re-switch when Pi already picked the same model", async () => {
	useAgentDir({ aliases: { sonnet: "local/terra" } });
	const harness = createMockPi();
	modelAlias(harness.pi);
	const { ctx } = createMockContext({
		modelRegistry: registryFor([{ provider: "local", id: "terra" }]),
	});
	setContextModel(ctx, model("local", "terra"));

	await startupWithCliModel(harness, ctx, ["--model", "sonnet"]);

	assert.deepEqual(harness.setModels, []);
});

test("pi --model <alias> keeps the current model when no candidate is usable", async () => {
	useAgentDir({ aliases: { sonnet: "local/terra" } });
	const harness = createMockPi();
	modelAlias(harness.pi);
	const { ctx, notifications } = createMockContext({
		modelRegistry: registryFor([{ provider: "local", id: "terra" }], ["local"]),
	});
	setContextModel(ctx, model("other", "fallback"));

	await startupWithCliModel(harness, ctx, ["--model", "sonnet"]);

	assert.deepEqual(harness.setModels, []);
	assert.equal(notifications.at(-1)?.level, "warning");
});

test("a session replacement does not re-apply the startup --model flag", async () => {
	useAgentDir({ aliases: { sonnet: "local/terra" } });
	const harness = createMockPi();
	modelAlias(harness.pi);
	const { ctx } = createMockContext({
		modelRegistry: registryFor([{ provider: "local", id: "terra" }]),
	});
	setContextModel(ctx, model("local", "chosen-later"));

	const previous = process.argv;
	process.argv = ["/usr/bin/node", "/usr/bin/pi", "--model", "sonnet"];
	try {
		await harness.events.get("session_start")?.[0]?.({ reason: "new" }, ctx);
	} finally {
		process.argv = previous;
	}

	assert.deepEqual(harness.setModels, []);
});

test("/new re-applies the model of the outgoing session", async () => {
	useAgentDir({ aliases: {} });
	const harness = createMockPi();
	modelAlias(harness.pi);
	const { ctx, notifications } = createMockContext({
		model: model("local", "chosen"),
		thinkingLevel: "high",
		modelRegistry: registryFor([{ provider: "local", id: "chosen" }]),
	});

	await harness.events.get("session_before_switch")?.[0]?.({ reason: "new" }, ctx);
	// The replacement session comes up on the settings default.
	setContextModel(ctx, model("local", "default"));
	await harness.events.get("session_start")?.[0]?.({ reason: "new" }, ctx);

	assert.deepEqual(harness.setModels, [{ provider: "local", id: "chosen" }]);
	assert.deepEqual(harness.thinkingLevels, ["high"]);
	assert.equal(notifications.length, 0);
});

test("/new leaves the model alone when the new session already matches", async () => {
	useAgentDir({ aliases: {} });
	const harness = createMockPi();
	modelAlias(harness.pi);
	const { ctx } = createMockContext({
		model: model("local", "chosen"),
		modelRegistry: registryFor([{ provider: "local", id: "chosen" }]),
	});

	await harness.events.get("session_before_switch")?.[0]?.({ reason: "new" }, ctx);
	await harness.events.get("session_start")?.[0]?.({ reason: "new" }, ctx);

	assert.deepEqual(harness.setModels, []);
});

test("the carried model is consumed by a single session start", async () => {
	useAgentDir({ aliases: {} });
	const harness = createMockPi();
	modelAlias(harness.pi);
	const { ctx } = createMockContext({
		model: model("local", "chosen"),
		modelRegistry: registryFor([{ provider: "local", id: "chosen" }]),
	});

	await harness.events.get("session_before_switch")?.[0]?.({ reason: "new" }, ctx);
	setContextModel(ctx, model("local", "default"));
	await harness.events.get("session_start")?.[0]?.({ reason: "new" }, ctx);
	setContextModel(ctx, model("local", "default"));
	await harness.events.get("session_start")?.[0]?.({ reason: "new" }, ctx);

	assert.deepEqual(harness.setModels, [{ provider: "local", id: "chosen" }]);
});

test("resuming a session does not carry the model over", async () => {
	useAgentDir({ aliases: {} });
	const harness = createMockPi();
	modelAlias(harness.pi);
	const { ctx } = createMockContext({
		model: model("local", "chosen"),
		modelRegistry: registryFor([{ provider: "local", id: "chosen" }]),
	});

	await harness.events.get("session_before_switch")?.[0]?.({ reason: "resume" }, ctx);
	setContextModel(ctx, model("local", "restored"));
	await harness.events.get("session_start")?.[0]?.({ reason: "resume" }, ctx);

	assert.deepEqual(harness.setModels, []);
});
