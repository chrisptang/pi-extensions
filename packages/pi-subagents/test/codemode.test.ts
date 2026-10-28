import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	createAgentSession,
	createCodemodeExtension,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { SkillRegistry } from "../src/skill-registry.js";
import type { ChildRequest } from "../src/types.js";

let directory: string;

beforeEach(() => {
	directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-codemode-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", directory);
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(directory, { recursive: true, force: true });
});

for (const codemode of [undefined, true, false]) {
	test(`codemode=${codemode} reaches plain, explorer, builder, skill, and fork children`, async () => {
		// Import after setting the agent directory; never seed the user's real definitions.
		vi.resetModules();
		const { default: subagents } = await import("../src/subagents.js");
		const file = path.join(directory, "subagents.json");
		if (codemode !== undefined) writeFileSync(file, JSON.stringify({ codemode, unknown: 1 }));
		const requests: ChildRequest[] = [];
		const mock = createMockPi();
		const context = createMockContext({
			model: { provider: "test-provider", id: "test-model" },
			modelRegistry: {
				getProviderAuthStatus: () => ({ configured: true, source: "environment" }),
				getRegisteredProviderIds: () => [],
				find: () => ({ contextWindow: 200_000 }),
			},
		});
		const skill = {
			name: "audit",
			description: "Audit",
			body: "Read the code.",
			baseDir: directory,
			tools: ["read"],
			toolsDeclared: true,
			unsupportedTools: [],
			disableModelInvocation: false,
			fork: true,
			source: path.join(directory, "SKILL.md"),
			origin: "pi" as const,
		};
		const load = () => ({ skills: new Map([[skill.name, skill]]), diagnostics: [] });
		subagents(mock.pi, {
			skills: new SkillRegistry(load, load),
			runChild: async (request) => {
				requests.push(request);
				return { state: "completed", result: "done", limitations: [], truncated: false };
			},
		});
		const emit = async (name: string, event: unknown) => {
			for (const handler of mock.events.get(name) ?? []) await handler(event, context.ctx);
		};
		const execute = async (name: string, params: Record<string, unknown>) => {
			const tool = mock.tools.find((entry) => entry.name === name);
			assert.ok(tool && typeof tool.execute === "function");
			return tool.execute("test", params, undefined, undefined, context.ctx);
		};
		try {
			await emit("session_start", { reason: "startup" });
			for (const agent of [undefined, "explorer", "builder"]) {
				const spawned = await execute("subagent_spawn", {
					task: "Read the code.",
					description: "read",
					...(agent ? { agent } : {}),
				});
				const details = spawned.details as { jobId: string };
				await execute("subagent_wait", { jobId: details.jobId });
			}
			const spawned = await execute("skill_run", { name: "audit", description: "audit" });
			await execute("subagent_wait", { jobId: (spawned.details as { jobId: string }).jobId });
			await emit("input", { type: "input", text: "/skill:audit", source: "interactive" });
			// Child launch is queued in a microtask; this boundary observes the fork launch too.
			await Promise.resolve();
			assert.equal(requests.length, 5);
			assert.deepEqual(
				requests.map((request) => request.codemode),
				Array(5).fill(codemode !== false),
			);
			assert.deepEqual(
				requests.map((request) => request.tools),
				[
					["read", "grep", "find", "ls"],
					["read", "grep", "find", "ls", "bash"],
					["read", "grep", "find", "ls", "edit", "write", "bash"],
					["read"],
					["read"],
				],
			);
			if (codemode === undefined) assert.equal(existsSync(file), false);
			else assert.equal(readFileSync(file, "utf8"), JSON.stringify({ codemode, unknown: 1 }));

			writeFileSync(file, JSON.stringify({ codemode: codemode === false }));
			await emit("session_start", { reason: "new" });
			const reloaded = await execute("subagent_spawn", { task: "Read.", description: "read" });
			await execute("subagent_wait", { jobId: (reloaded.details as { jobId: string }).jobId });
			assert.equal(requests.at(-1)?.codemode, codemode === false);
		} finally {
			await emit("session_shutdown", { reason: "quit" });
		}
	});
}

for (const mode of ["on", "only"] as const) {
	test(`native codemode ${mode} executes only selected work tools with discovery disabled`, async () => {
		const { buildPiArgs } = await import("../src/process.js");
		const request: ChildRequest = {
			task: "Read.",
			tools: ["read"],
			model: "test-provider/test-model",
			thinkingLevel: "off",
			cwd: directory,
			projectTrusted: false,
			signal: new AbortController().signal,
		};
		const args = buildPiArgs(request);
		const extension = args[args.indexOf("-e") + 1];
		const selected = args[args.indexOf("--tools") + 1];
		assert.ok(extension);
		assert.ok(selected);
		const settingsManager = SettingsManager.inMemory({ codemode: { mode } });
		const resourceLoader = new DefaultResourceLoader({
			cwd: directory,
			agentDir: directory,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			additionalExtensionPaths: [extension],
			extensionFactories: [{ name: "codemode", builtin: true, factory: createCodemodeExtension() }],
		});
		await resourceLoader.reload();
		assert.deepEqual(resourceLoader.getExtensions().errors, []);
		assert.deepEqual(
			resourceLoader.getExtensions().extensions.map((entry) => entry.path),
			["builtin:codemode"],
		);
		const { session } = await createAgentSession({
			cwd: directory,
			agentDir: directory,
			resourceLoader,
			settingsManager,
			sessionManager: SessionManager.inMemory(directory),
			tools: selected.split(","),
		});
		try {
			await session.bindExtensions({});
			assert.deepEqual(session.getCallableToolNames(), ["read"]);
			const codemode = session.agent.state.tools.find((tool) => tool.name === "codemode");
			assert.ok(codemode);
			const file = path.join(directory, "fixture.txt");
			writeFileSync(file, "selected-tool-result");
			const code = `text(ALL_TOOLS.map(tool => tool.name)); text(await tools.read({ path: ${JSON.stringify(file)} }));`;
			session.sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "toolCall", id: "smoke", name: "codemode", arguments: { code } }],
				api: "openai-completions",
				provider: "test-provider",
				model: "test-model",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 0,
			});
			session.refreshContext();
			const result = await codemode.execute("smoke", { code });
			const output = result.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n");
			assert.match(output, /selected-tool-result/u);
			assert.doesNotMatch(output, /Script failed/u);
			assert.deepEqual(session.getActiveToolNames(), ["read", "codemode"]);
		} finally {
			session.dispose();
		}
	});
}
