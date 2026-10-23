import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { CreateAgentSessionRuntimeFactory } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";

for (const mode of ["slash", "startup"] as const) {
	test(`real Pi/Jiti ${mode}: fresh history, stable requests, source preservation and reload`, async () => {
		const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-handoff-runtime-")));
		const agentDir = join(directory, "agent");
		const cwd = join(directory, "project");
		const sessionDir = join(directory, "sessions");
		const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
		const oldArgv = process.argv;
		let dispose: (() => Promise<void>) | undefined;
		try {
			await mkdir(agentDir);
			await mkdir(cwd);
			process.env.PI_CODING_AGENT_DIR = agentDir;
			process.argv = ["node", "pi"];
			const pi = await import("@earendil-works/pi-coding-agent");
			const ai = await import("@earendil-works/pi-ai");
			const packagePath = fileURLToPath(new URL("../", import.meta.url));
			for (const [base, text] of [
				[agentDir, "USER_HANDOFF_FOCUS"],
				[join(cwd, ".pi"), "PROJECT_HANDOFF_FOCUS"],
			]) {
				await mkdir(join(base, "system-prompts"), { recursive: true });
				await writeFile(join(base, "system-prompts", "handoff.md"), text);
			}
			const modelRuntime = await pi.ModelRuntime.create({
				authPath: join(agentDir, "auth.json"),
				modelsPath: join(agentDir, "models.json"),
				modelsStorePath: join(agentDir, "models-store.json"),
				allowModelNetwork: false,
			});
			const requests: Message[][] = [];
			modelRuntime.registerProvider("handoff-smoke", {
				api: "openai-completions",
				apiKey: "local-smoke-key",
				baseUrl: "https://unused.invalid",
				models: [
					{
						id: "fixture",
						name: "Fixture",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 100_000,
						maxTokens: 1_000,
					},
				],
				streamSimple(model, context) {
					requests.push(structuredClone(context.messages));
					const stream = ai.createAssistantMessageEventStream();
					const response: AssistantMessage = {
						role: "assistant",
						api: model.api,
						provider: model.provider,
						model: model.id,
						content: [{ type: "text", text: "Please confirm the complete goal and scope." }],
						stopReason: "stop",
						timestamp: Date.now(),
						usage: {
							input: 100,
							output: 10,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 110,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
					};
					queueMicrotask(() => {
						stream.push({ type: "start", partial: response });
						stream.push({ type: "done", reason: "stop", message: response });
						stream.end();
					});
					return stream;
				},
			});
			const model = modelRuntime.getModel("handoff-smoke", "fixture");
			assert.ok(model);
			const source = pi.SessionManager.create(cwd, sessionDir);
			source.appendModelChange(model.provider, model.id);
			source.appendThinkingLevelChange("off");
			const leafId = source.appendMessage({
				role: "user",
				content: [
					{ type: "text", text: "SOURCE_CONTENT_MUST_NOT_BE_COPIED" },
					{ type: "image", mimeType: "image/png", data: "A".repeat(2_000_000) },
				],
				timestamp: Date.now(),
			});
			source.appendSessionInfo("Original mission");
			const sourceFile = source.getSessionFile();
			assert.ok(sourceFile);
			const errors: string[] = [];
			let creations = 0;
			const factory: CreateAgentSessionRuntimeFactory = async (options) => {
				creations++;
				const services = await pi.createAgentSessionServices({
					cwd,
					agentDir,
					modelRuntime,
					settingsManager: pi.SettingsManager.inMemory(
						{
							compaction: { enabled: false },
							packages: mode === "startup" ? [packagePath] : [],
						},
						{ projectTrusted: mode === "startup" },
					),
					extensionFlagValues:
						mode === "startup" ? new Map([["handoff", source.getSessionId()]]) : undefined,
					resourceLoaderOptions: {
						noExtensions: mode === "slash",
						additionalExtensionPaths: mode === "slash" ? [packagePath] : [],
						noSkills: true,
						noPromptTemplates: true,
						noThemes: true,
						noContextFiles: true,
					},
				});
				assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
				const created = await pi.createAgentSessionFromServices({
					services,
					sessionManager: options.sessionManager,
					sessionStartEvent: options.sessionStartEvent,
					model,
					thinkingLevel: "off",
					noTools: "all",
				});
				return { ...created, services, diagnostics: services.diagnostics };
			};
			const runtime = await pi.createAgentSessionRuntime(factory, {
				cwd,
				agentDir,
				sessionManager: mode === "slash" ? source : pi.SessionManager.create(cwd, sessionDir),
			});
			dispose = () => runtime.dispose();
			const bind = async () => {
				const session = runtime.session;
				await session.bindExtensions({
					mode: "tui",
					uiContext: session.extensionRunner.getUIContext(),
					commandContextActions: {
						waitForIdle: () => runtime.session.waitForIdle(),
						newSession: (options) => runtime.newSession(options),
						fork: (id, options) => runtime.fork(id, options),
						navigateTree: (id, options) => runtime.session.navigateTree(id, options),
						switchSession: (path, options) => runtime.switchSession(path, options),
						reload: () => runtime.session.reload(),
					},
					onError: (error) => errors.push(error.error),
				});
			};
			runtime.setRebindSession(bind);
			const before = await readFile(sourceFile, "utf8");
			let settled: (() => void) | undefined;
			const startupSettled = new Promise<void>((resolve) => {
				settled = resolve;
			});
			runtime.session.subscribe((event) => {
				if (event.type === "agent_settled") settled?.();
			});
			await bind();
			if (mode === "slash") await runtime.session.prompt("/handoff");
			else await startupSettled;

			assert.deepEqual(errors, []);
			assert.equal(creations, mode === "slash" ? 2 : 1);
			assert.notEqual(runtime.session.sessionId, source.getSessionId());
			assert.equal(requests.length, 1);
			const first = JSON.stringify(requests[0]);
			assert.ok(first.includes(sourceFile));
			assert.ok(first.includes("Confirm before implementation"));
			assert.ok(
				first.includes(mode === "startup" ? "PROJECT_HANDOFF_FOCUS" : "USER_HANDOFF_FOCUS"),
			);
			assert.ok(
				!first.includes(mode === "startup" ? "USER_HANDOFF_FOCUS" : "PROJECT_HANDOFF_FOCUS"),
			);
			const extra = runtime.session.sessionManager
				.getEntries()
				.find(
					(entry) => entry.type === "custom_message" && entry.customType === "handoff-instructions",
				);
			assert.ok(extra?.type === "custom_message");
			assert.equal(extra.display, false);
			assert.ok(!first.includes("SOURCE_CONTENT_MUST_NOT_BE_COPIED"));
			assert.ok(!first.includes("A".repeat(1_000)));
			assert.ok(first.length < 20_000);
			assert.equal(await readFile(sourceFile, "utf8"), before);
			if (mode === "slash") {
				assert.equal(runtime.session.sessionManager.getHeader()?.parentSession, sourceFile);
				assert.ok(first.includes(source.getLeafId() ?? leafId));
			}
			assert.equal(
				runtime.session.sessionManager
					.getEntries()
					.filter((entry) => entry.type === "custom_message" && entry.customType === "handoff")
					.length,
				1,
			);
			await writeFile(join(agentDir, "system-prompts", "handoff.md"), "REVISED_HANDOFF_FOCUS");
			await writeFile(join(cwd, ".pi", "system-prompts", "handoff.md"), "REVISED_HANDOFF_FOCUS");
			await runtime.session.reload();
			assert.equal(requests.length, 1, "reload must not replay the startup flag");
			assert.deepEqual(errors, []);
			await runtime.session.prompt("I confirm that the goal and scope are complete.");
			assert.equal(requests.length, 2);
			assert.ok(!JSON.stringify(requests[1]).includes("REVISED_HANDOFF_FOCUS"));
			assert.deepEqual(requests[1].slice(0, requests[0].length), requests[0]);
			assert.equal(await readFile(sourceFile, "utf8"), before);
		} finally {
			await dispose?.();
			process.argv = oldArgv;
			if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
			await rm(directory, { recursive: true, force: true });
		}
	});
}
