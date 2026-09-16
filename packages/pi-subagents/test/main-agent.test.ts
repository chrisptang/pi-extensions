import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import type { AgentDefinition } from "../src/agent-definitions.js";
import { AgentRegistry } from "../src/agent-registry.js";
import { loadMainAgentSettings, type MainAgentSettings } from "../src/main-agent.js";
import { SkillRegistry } from "../src/skill-registry.js";
import subagents, { type SubagentsDependencies } from "../src/subagents.js";

type Mock = ReturnType<typeof createMockPi>;
type Context = ReturnType<typeof createMockContext>;

type SystemPromptHandler = (
	event: { systemPrompt: string },
	ctx: unknown,
) => { systemPrompt?: string } | undefined;

let root: string;
const activeSessions: Array<{ mock: Mock; context: Context }> = [];

beforeEach(() => {
	root = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-main-"));
});

afterEach(async () => {
	for (const session of activeSessions.splice(0)) {
		await emit(session.mock, "session_shutdown", { reason: "quit" }, session.context.ctx);
	}
	rmSync(root, { recursive: true, force: true });
});

test("settings: a missing file is silent, a valid one names the agent, a broken one reports", () => {
	const file = path.join(root, "subagents.json");
	assert.deepEqual(loadMainAgentSettings(file), { source: file, diagnostics: [] });

	writeFileSync(file, '{ "mainAgent": " Architect " }');
	assert.equal(loadMainAgentSettings(file).mainAgent, " Architect ".trim());

	writeFileSync(file, "{ not json");
	assert.match(loadMainAgentSettings(file).diagnostics[0] ?? "", /not valid JSON/);

	writeFileSync(file, '{ "mainAgent": 7 }');
	assert.match(loadMainAgentSettings(file).diagnostics[0] ?? "", /invalid mainAgent/);

	writeFileSync(file, "[]");
	assert.match(loadMainAgentSettings(file).diagnostics[0] ?? "", /JSON object/);

	writeFileSync(file, "{}");
	assert.deepEqual(loadMainAgentSettings(file), { source: file, diagnostics: [] });
});

test("mainAgent joins the system prompt every turn and is reported by /agents", async () => {
	const { mock, context } = await setup({
		agents: registry(architect()),
		mainAgent: { settings: settings("architect") },
	});

	const result = beforeAgentStart(mock, "Base prompt.");
	assert.equal(result?.systemPrompt, "Base prompt.\n\nYou are the architect.");
	// Every turn, not only the first, so compaction cannot drop the persona.
	assert.equal(
		beforeAgentStart(mock, "Later prompt.")?.systemPrompt,
		"Later prompt.\n\nYou are the architect.",
	);

	await mock.commands.get("agents")?.handler("", context.ctx);
	const notice = context.notifications.at(-1)?.message ?? "";
	assert.match(notice, /architect .*\[main\]/);
	assert.match(notice, /Main agent: architect \(\/agents\/architect\.md\)/);
});

test("a main-role definition is hidden from the spawn roster and refused as a child", async () => {
	const { mock, context } = await setup({
		agents: registry(architect(), definition({ name: "explorer" })),
		mainAgent: { settings: settings("architect") },
	});

	const spawn = spawnTool(mock);
	const roster = spawn.parameters.properties?.agent?.description ?? "";
	assert.match(roster, /explorer \(explorer description\)/);
	assert.doesNotMatch(roster, /architect/);

	await assert.rejects(
		spawn.execute(
			"spawn",
			{ task: "x", description: "x", agent: "architect" },
			undefined,
			undefined,
			context.ctx,
		),
		/role: main; it describes the main session and cannot run as a child/,
	);
});

test("--agent overrides the settings file, and none disables it", async () => {
	const lead = definition({ name: "lead", role: "main", body: "You are the lead." });
	const { mock: overridden } = await setup(
		{ agents: registry(architect(), lead), mainAgent: { settings: settings("architect") } },
		{ agent: "lead" },
	);
	assert.equal(beforeAgentStart(overridden, "P")?.systemPrompt, "P\n\nYou are the lead.");

	const { mock: disabled, context } = await setup(
		{ agents: registry(architect()), mainAgent: { settings: settings("architect") } },
		{ agent: "none" },
	);
	assert.equal(beforeAgentStart(disabled, "P"), undefined);
	await disabled.commands.get("agents")?.handler("", context.ctx);
	assert.match(
		context.notifications.at(-1)?.message ?? "",
		/Main agent: none \(set mainAgent in .*subagents\.json/,
	);
});

test("an unknown or subagent-role name warns and leaves the prompt alone", async () => {
	const unknown = await setup({
		agents: registry(architect()),
		mainAgent: { settings: settings("ghost") },
	});
	assert.equal(beforeAgentStart(unknown.mock, "P"), undefined);
	assert.match(
		unknown.context.notifications.at(-1)?.message ?? "",
		/Main agent "ghost" is not defined/,
	);

	const child = await setup({
		agents: registry(definition({ name: "explorer" })),
		mainAgent: { settings: settings("explorer") },
	});
	assert.equal(beforeAgentStart(child.mock, "P"), undefined);
	assert.match(
		child.context.notifications.at(-1)?.message ?? "",
		/explorer.*is a subagent definition.*add role: main/,
	);
});

test("settings diagnostics warn at session start and stay visible in /agents", async () => {
	const { mock, context } = await setup({
		agents: registry(architect()),
		mainAgent: {
			settings: {
				source: "/x/subagents.json",
				diagnostics: ["Settings file /x/subagents.json is not valid JSON: boom"],
			},
		},
	});
	assert.equal(context.notifications.length, 1);
	assert.match(context.notifications[0]?.message ?? "", /not valid JSON: boom/);
	// The broken file names no agent, so the session runs plain.
	assert.equal(beforeAgentStart(mock, "P"), undefined);
	await mock.commands.get("agents")?.handler("", context.ctx);
	assert.match(
		context.notifications.at(-1)?.message ?? "",
		/Diagnostics:\n\s+Settings file .*not valid JSON: boom/,
	);
});

test("model and thinking level apply to fresh sessions only", async () => {
	const model = { provider: "test-provider", id: "strong" };
	const { mock, context } = await setup(
		{
			agents: registry(architect({ model: "test-provider/strong", thinkingLevel: "high" })),
			mainAgent: {
				settings: settings("architect"),
				modelLookup: () => ({
					isUsable: (provider, id) => provider === "test-provider" && id === "strong",
				}),
			},
		},
		{},
		{ modelRegistry: { find: () => model, hasConfiguredAuth: () => true } },
	);
	assert.deepEqual(mock.setModels, [model]);
	assert.deepEqual(mock.thinkingLevels, ["high"]);

	await emit(mock, "session_start", { reason: "resume" }, context.ctx);
	assert.equal(mock.setModels.length, 1);
	await emit(mock, "session_start", { reason: "new" }, context.ctx);
	assert.equal(mock.setModels.length, 2);
});

test("an unavailable model is reported and the session keeps its own", async () => {
	const { mock, context } = await setup({
		agents: registry(architect({ model: "test-provider/missing" })),
		mainAgent: {
			settings: settings("architect"),
			modelLookup: () => ({ isUsable: () => false }),
		},
	});
	assert.deepEqual(mock.setModels, []);
	assert.match(
		context.notifications.at(-1)?.message ?? "",
		/test-provider\/missing is unavailable/,
	);
	// The persona still applies; only the model fell back.
	assert.match(beforeAgentStart(mock, "P")?.systemPrompt ?? "", /You are the architect/);
});

function settings(mainAgent: string): MainAgentSettings {
	return { mainAgent, source: path.join(root, "subagents.json"), diagnostics: [] };
}

function architect(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
	return definition({
		name: "architect",
		role: "main",
		body: "You are the architect.",
		...overrides,
	});
}

function definition(overrides: Partial<AgentDefinition> & { name: string }): AgentDefinition {
	return {
		description: `${overrides.name} description`,
		role: "subagent",
		body: `You are ${overrides.name}.`,
		tools: ["read", "grep"],
		source: `/agents/${overrides.name}.md`,
		origin: "pi",
		...overrides,
	};
}

function registry(...definitions: AgentDefinition[]): AgentRegistry {
	const load = () => ({
		agents: new Map(definitions.map((entry) => [entry.name, entry])),
		diagnostics: [],
	});
	return new AgentRegistry(load, load);
}

async function setup(
	dependencies: SubagentsDependencies,
	flags: Record<string, string> = {},
	contextOverrides: Record<string, unknown> = {},
) {
	const mock = createMockPi();
	const context = createMockContext({
		model: { provider: "test-provider", id: "test-model" },
		modelRegistry: {
			getProviderAuthStatus: () => ({ configured: true, source: "environment" as const }),
			getRegisteredProviderIds: () => [],
		},
		...contextOverrides,
	});
	const empty = () => ({ skills: new Map(), diagnostics: [] });
	subagents(mock.pi, {
		seedAgents: () => undefined,
		skills: new SkillRegistry(empty, empty),
		...dependencies,
	});
	// Pi assigns CLI values after load and before the first session starts.
	for (const [name, value] of Object.entries(flags)) {
		const flag = mock.flags.get(name);
		assert.ok(flag, `flag ${name} is not registered`);
		flag.value = value;
	}
	await emit(mock, "session_start", { reason: "startup" }, context.ctx);
	activeSessions.push({ mock, context });
	return { mock, context };
}

async function emit(mock: Mock, event: string, payload: unknown, context: unknown): Promise<void> {
	for (const handler of mock.events.get(event) ?? []) await handler(payload, context);
}

function beforeAgentStart(mock: Mock, systemPrompt: string): { systemPrompt?: string } | undefined {
	const handlers = (mock.events.get("before_agent_start") ??
		[]) as unknown as SystemPromptHandler[];
	assert.equal(handlers.length, 1);
	return handlers[0]?.({ systemPrompt }, {});
}

function spawnTool(mock: Mock) {
	const tools = mock.tools as unknown as Array<{
		name: string;
		parameters: { properties?: Record<string, { description?: string }> };
		execute: (
			id: string,
			params: Record<string, unknown>,
			signal: undefined,
			onUpdate: undefined,
			ctx: unknown,
		) => Promise<unknown>;
	}>;
	const spawn = tools.find((candidate) => candidate.name === "subagent_spawn");
	assert.ok(spawn);
	return spawn;
}
