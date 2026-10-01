import assert from "node:assert/strict";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import autoTitle from "../src/auto-title.js";

function emit(
	mock: ReturnType<typeof createMockPi>,
	eventName: string,
	eventData: unknown,
	ctx: unknown,
) {
	const handlers = mock.events.get(eventName) ?? [];
	for (const handler of handlers) {
		handler(eventData, ctx);
	}
}

test("auto-title triggers on turn 2 agent_settled and sets session name silently", async () => {
	const mock = createMockPi();
	autoTitle(mock.pi);

	const entries: SessionEntry[] = [];

	let completeCalledWith: { model: Model<Api>; context: unknown } | null = null;
	const mockModel = {
		provider: "anthropic",
		id: "claude-3-5-haiku-20241022",
	} as unknown as Model<Api>;

	const mockRegistry = {
		find() {
			return mockModel;
		},
		hasConfiguredAuth() {
			return true;
		},
		getAvailable() {
			return [mockModel];
		},
		async complete(model: Model<Api>, context: unknown) {
			completeCalledWith = { model, context };
			return {
				role: "assistant",
				content: [{ type: "text", text: "Database Pool Refactor" }],
			};
		},
	};

	const mockContext = createMockContext({
		model: mockModel,
		sessionManager: {
			getSessionId: () => "sess-1",
			getSessionName: () => mock.rawPi.getSessionName(),
			getBranch: () => entries,
			getEntries: () => entries,
		} as unknown as ExtensionCommandContext["sessionManager"],
		modelRegistry: mockRegistry as unknown as ExtensionCommandContext["modelRegistry"],
	});

	// 1. Session start with empty entries
	emit(mock, "session_start", { type: "session_start", reason: "new" }, mockContext.ctx);
	assert.equal(mock.rawPi.getSessionName(), undefined);

	// 2. Turn 1
	emit(mock, "agent_start", { type: "agent_start" }, mockContext.ctx);
	entries.push(
		{
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: "2026-10-01T00:00:01Z",
			message: { role: "user", content: "I want to refactor the database module." },
		} as unknown as SessionEntry,
		{
			type: "message",
			id: "m2",
			parentId: "m1",
			timestamp: "2026-10-01T00:00:02Z",
			message: { role: "assistant", content: "Sure, what changes do you need?" },
		} as unknown as SessionEntry,
	);
	emit(mock, "agent_settled", { type: "agent_settled" }, mockContext.ctx);
	await Promise.resolve();
	assert.equal(mock.rawPi.getSessionName(), undefined);
	assert.equal(completeCalledWith, null);

	// 3. Turn 2
	emit(mock, "agent_start", { type: "agent_start" }, mockContext.ctx);
	entries.push(
		{
			type: "message",
			id: "m3",
			parentId: "m2",
			timestamp: "2026-10-01T00:00:03Z",
			message: { role: "user", content: "Let's add connection pooling and timeout handling." },
		} as unknown as SessionEntry,
		{
			type: "message",
			id: "m4",
			parentId: "m3",
			timestamp: "2026-10-01T00:00:04Z",
			message: { role: "assistant", content: "I will add the pool configuration." },
		} as unknown as SessionEntry,
	);
	emit(mock, "agent_settled", { type: "agent_settled" }, mockContext.ctx);

	// Wait for background Promise in agent_settled
	await new Promise((resolve) => setTimeout(resolve, 50));

	assert.ok(completeCalledWith);
	assert.equal(mock.rawPi.getSessionName(), "Database Pool Refactor");
	// Silent: no notification toast shown during background auto-titling
	assert.equal(mockContext.notifications.length, 0);

	// 4. Turn 3 should NOT trigger again
	completeCalledWith = null;
	emit(mock, "agent_start", { type: "agent_start" }, mockContext.ctx);
	emit(mock, "agent_settled", { type: "agent_settled" }, mockContext.ctx);
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(completeCalledWith, null);
});

test("auto-title does not overwrite an existing session name", async () => {
	const mock = createMockPi();
	mock.rawPi.setSessionName("Manual User Name");
	autoTitle(mock.pi);

	let completeCalled = false;
	const mockRegistry = {
		find: () => ({ provider: "anthropic", id: "claude-haiku" }) as unknown as Model<Api>,
		hasConfiguredAuth: () => true,
		getAvailable: () => [],
		complete: async () => {
			completeCalled = true;
			return { role: "assistant", content: [{ type: "text", text: "New Name" }] };
		},
	};

	const mockContext = createMockContext({
		sessionManager: {
			getSessionId: () => "sess-2",
			getSessionName: () => "Manual User Name",
			getBranch: () => [],
			getEntries: () => [],
		} as unknown as ExtensionCommandContext["sessionManager"],
		modelRegistry: mockRegistry as unknown as ExtensionCommandContext["modelRegistry"],
	});

	emit(mock, "session_start", { type: "session_start", reason: "resume" }, mockContext.ctx);
	emit(mock, "agent_start", { type: "agent_start" }, mockContext.ctx);
	emit(mock, "agent_settled", { type: "agent_settled" }, mockContext.ctx);
	emit(mock, "agent_start", { type: "agent_start" }, mockContext.ctx);
	emit(mock, "agent_settled", { type: "agent_settled" }, mockContext.ctx);

	await new Promise((resolve) => setTimeout(resolve, 50));

	assert.equal(completeCalled, false);
	assert.equal(mock.rawPi.getSessionName(), "Manual User Name");
});

test("/auto-title generate command generates title on demand", async () => {
	const mock = createMockPi();
	autoTitle(mock.pi);

	const entries = [
		{
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: "2026-10-01T00:00:01Z",
			message: { role: "user", content: "Optimize web performance" },
		} as unknown as SessionEntry,
	];

	const mockModel = { provider: "anthropic", id: "haiku" } as unknown as Model<Api>;
	const mockRegistry = {
		find: () => mockModel,
		hasConfiguredAuth: () => true,
		getAvailable: () => [mockModel],
		complete: async () => ({
			role: "assistant",
			content: [{ type: "text", text: "Web Perf Optimization" }],
		}),
	};

	const mockContext = createMockContext({
		hasUI: true,
		sessionManager: {
			getSessionId: () => "sess-3",
			getSessionName: () => mock.rawPi.getSessionName(),
			getBranch: () => entries,
			getEntries: () => entries,
		} as unknown as ExtensionCommandContext["sessionManager"],
		modelRegistry: mockRegistry as unknown as ExtensionCommandContext["modelRegistry"],
	});

	const cmd = mock.commands.get("auto-title");
	assert.ok(cmd);

	await cmd.handler("generate", mockContext.ctx as unknown as ExtensionCommandContext);

	assert.equal(mock.rawPi.getSessionName(), "Web Perf Optimization");
	assert.ok(mockContext.notifications.some((n) => n.message.includes("Web Perf Optimization")));
});
