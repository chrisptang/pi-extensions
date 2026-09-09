import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRegistry,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

const root = await mkdtemp(join(tmpdir(), "goal-clarification-smoke-"));
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = root;
let session;
let modelRuntime;
const text = (message) =>
	typeof message.content === "string"
		? message.content
		: (message.content ?? [])
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n");
try {
	modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
	});
	const registry = new ModelRegistry(modelRuntime);
	const faux = createFauxCore({ api: `goal-smoke-${crypto.randomUUID()}`, provider: "goal-smoke" });
	registry.registerProvider("goal-smoke", {
		api: faux.api,
		apiKey: "fake",
		baseUrl: "http://localhost",
		streamSimple: faux.streamSimple,
		models: faux.models,
	});
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false },
	});
	const loader = new DefaultResourceLoader({
		cwd: root,
		agentDir: root,
		settingsManager,
		additionalExtensionPaths: [resolve(import.meta.dirname, "../dist/index.ts")],
	});
	await loader.reload();
	const result = await createAgentSession({
		cwd: root,
		agentDir: root,
		modelRuntime,
		model: registry.find("goal-smoke", faux.getModel().id),
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(root),
		settingsManager,
		noTools: "builtin",
	});
	session = result.session;
	assert.deepEqual(result.extensionsResult.errors, []);
	let approvals = 0;
	const goalEntries = () =>
		session.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom" && entry.customType === "goal-state");
	await session.bindExtensions({
		mode: "rpc",
		uiContext: {
			notify() {},
			setStatus() {},
			async confirm(_title, message) {
				assert.equal(goalEntries().length, 0, "no Goal before approval");
				assert.match(message, /Complete the agreed smoke and verify it/);
				approvals++;
				return true;
			},
		},
	});
	faux.setResponses([
		fauxAssistantMessage("Should the smoke verify approval before persistence?"),
		(context) => {
			const requestId = /Request ID: (\S+)/.exec(context.messages.map(text).join("\n"))?.[1];
			assert.ok(requestId);
			return fauxAssistantMessage(
				fauxToolCall("goal_confirm", {
					request_id: requestId,
					objective: "Complete the agreed smoke and verify it",
				}),
			);
		},
		(context) => {
			const id = [
				...context.messages
					.map(text)
					.join("\n")
					.matchAll(/<goal_id>\s*(\S+)\s*<\/goal_id>/g),
			].at(-1)?.[1];
			assert.ok(id, "owned kickoff must reach provider after approval");
			return fauxAssistantMessage(
				fauxToolCall("goal_complete", {
					goal_id: id,
					summary: "Verified confirmation before persistence and owned kickoff.",
				}),
			);
		},
	]);
	const settled = () =>
		new Promise((resolve) => {
			const unsubscribe = session.subscribe((event) => {
				if (event.type === "agent_settled") {
					unsubscribe();
					resolve();
				}
			});
		});
	const clarificationSettled = settled();
	await session.prompt("/goal --tokens 100k verify goal clarification");
	await clarificationSettled;
	assert.equal(goalEntries().length, 0);
	assert.equal(faux.state.callCount, 1);
	const executionSettled = settled();
	await session.prompt("Yes, that is the final scope.");
	await executionSettled;
	assert.equal(approvals, 1);
	assert.equal(faux.state.callCount, 3);
	assert.equal(goalEntries().at(-1)?.data.goal, null);
	assert.ok(
		goalEntries().some(
			(entry) => entry.data.goal?.text === "Complete the agreed smoke and verify it",
		),
	);
	console.log(
		"Goal clarification Jiti smoke passed: dialogue → native approval → persistence → owned kickoff → completion.",
	);
} finally {
	session?.dispose();
	await modelRuntime?.dispose?.();
	if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previous;
	await rm(root, { recursive: true, force: true });
}
