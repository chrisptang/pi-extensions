import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionInfo,
	SessionShutdownEvent,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildHandoffPrompt, HANDOFF_KICKOFF, type HandoffSource } from "../src/prompt.js";

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return { ...actual, stat: vi.fn(actual.stat) };
});

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
type NewSessionOptions = NonNullable<Parameters<ExtensionCommandContext["newSession"]>[0]>;
type ReplacedSessionContext = Parameters<NonNullable<NewSessionOptions["withSession"]>>[0];
type Message = Parameters<ReplacedSessionContext["sendMessage"]>[0];
type StartReason = SessionStartEvent["reason"];
type Hook = (event: SessionStartEvent | SessionShutdownEvent, ctx: ExtensionContext) => unknown;

let directory: string;
let agentDirectory: string;
let handoff: typeof import("../src/index.js")["default"];
const originalArgv = process.argv;
const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

beforeAll(async () => {
	// Import the extension only after isolating Pi's agent-directory lookup.
	agentDirectory = mkdtempSync(join(tmpdir(), "pi-handoff-agent-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDirectory);
	handoff = (await import("../src/index.js")).default;
});
afterAll(() => {
	vi.unstubAllEnvs();
	rmSync(agentDirectory, { recursive: true, force: true });
});
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "pi-handoff-"));
	process.argv = ["node", "pi"];
	vi.mocked(stat).mockImplementation(actualFs.stat);
	vi.spyOn(SessionManager, "list").mockResolvedValue([]);
});
afterEach(() => {
	process.argv = originalArgv;
	vi.restoreAllMocks();
	vi.mocked(stat).mockReset();
	rmSync(directory, { recursive: true, force: true });
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

function savedSession(id: string = randomUUID(), name = "Original goal", cwd = directory) {
	const manager = SessionManager.create(cwd, join(directory, "sessions"), { id });
	manager.appendSessionInfo(name);
	manager.appendMessage({ role: "user", content: "PRIVATE ORIGINAL HISTORY", timestamp: 1 });
	return manager;
}

function sessionInfo(manager: SessionManager, overrides: Partial<SessionInfo> = {}): SessionInfo {
	return {
		path: manager.getSessionFile() as string,
		id: manager.getSessionId(),
		cwd: manager.getCwd(),
		name: manager.getSessionName(),
		created: new Date(0),
		modified: new Date(0),
		messageCount: 1,
		firstMessage: "PRIVATE FIRST MESSAGE",
		allMessagesText: "PRIVATE INDEXED HISTORY",
		...overrides,
	};
}

function learningEntry(manager: SessionManager) {
	const entries = manager.getEntries().filter((entry) => entry.type === "custom_message");
	expect(entries).toHaveLength(1);
	const entry = entries[0];
	if (entry.type !== "custom_message") throw new Error("Expected the learning prompt");
	expect(entry).toMatchObject({ customType: "handoff", display: true });
	return entry;
}

function locator(manager: SessionManager): HandoffSource {
	const details = learningEntry(manager).details as { version: number; source: HandoffSource };
	expect(details.version).toBe(1);
	return details.source;
}

function harness(
	manager = savedSession(),
	options: { mode?: ExtensionContext["mode"]; flag?: string | boolean; hasUI?: boolean } = {},
) {
	const trace: string[] = [];
	const staleAccesses: string[] = [];
	const requests: { manager: SessionManager; messages: unknown[]; content: unknown }[] = [];
	let kickoffError: Error | undefined;
	let cancelNew = false;
	const registrations = {
		commands: [] as string[],
		flags: [] as { name: string; flag: Parameters<ExtensionAPI["registerFlag"]>[1] }[],
		tools: vi.fn(),
	};

	function runtime(session: SessionManager) {
		let stale = false;
		const live = () => {
			if (stale) {
				staleAccesses.push(session.getSessionId());
				throw new Error("STALE CONTEXT USED");
			}
		};
		const hooks = new Map<string, Hook>();
		let command!: Command;
		const ui = {
			select: vi.fn<ExtensionContext["ui"]["select"]>(async () => undefined),
			notify: vi.fn<ExtensionContext["ui"]["notify"]>(() => live()),
			setEditorText: vi.fn<ExtensionContext["ui"]["setEditorText"]>(() => live()),
		};
		const publish = (message: Message) => {
			live();
			trace.push("prompt");
			session.appendCustomMessageEntry(
				message.customType,
				message.content,
				message.display,
				message.details,
			);
		};
		const sendMessage = vi.fn(async (message: Message) => publish(message));
		const sendUserMessage = vi.fn(
			async (content: Parameters<ReplacedSessionContext["sendUserMessage"]>[0]) => {
				live();
				trace.push("request");
				requests.push({
					manager: session,
					messages: session.buildSessionContext().messages,
					content,
				});
				if (kickoffError) throw kickoffError;
				session.appendMessage({ role: "user", content, timestamp: 2 });
			},
		);
		const api = {
			on: (name: string, hook: Hook) => hooks.set(name, hook),
			registerCommand: (name: string, value: Command) => {
				registrations.commands.push(name);
				command = value;
			},
			registerFlag: (name: string, flag: Parameters<ExtensionAPI["registerFlag"]>[1]) =>
				registrations.flags.push({ name, flag }),
			registerTool: registrations.tools,
			getFlag: (name: string) => {
				live();
				return name === "handoff" ? options.flag : undefined;
			},
			// Pi's factory API is fire-and-forget, but idle custom publication is synchronous.
			sendMessage: vi.fn(publish),
			sendUserMessage: vi.fn((content: string) => {
				void sendUserMessage(content);
			}),
		};
		handoff(api as unknown as ExtensionAPI);
		const newSession = vi.fn<ExtensionCommandContext["newSession"]>(async (settings) => {
			live();
			trace.push("newSession");
			if (cancelNew) return { cancelled: true };
			const nextManager = SessionManager.create(directory, session.getSessionDir(), {
				parentSession: settings?.parentSession,
			});
			await shutdown("new");
			active = runtime(nextManager);
			await active.start("new");
			if (settings?.setup) {
				trace.push("setup");
				await settings.setup(nextManager);
			}
			trace.push("withSession");
			await settings?.withSession?.(active.ctx);
			return { cancelled: false };
		});
		const ctx = new Proxy(
			{
				cwd: directory,
				mode: options.mode ?? "tui",
				hasUI: options.hasUI ?? true,
				isProjectTrusted: () => true,
				sessionManager: session,
				ui,
				newSession,
				sendMessage,
				sendUserMessage,
			} as unknown as ReplacedSessionContext,
			{
				get: (target, key, receiver) => {
					live();
					return Reflect.get(target, key, receiver);
				},
			},
		);
		async function start(reason: StartReason = "startup") {
			trace.push(`start:${reason}`);
			await hooks.get("session_start")?.({ type: "session_start", reason }, ctx);
		}
		async function shutdown(reason: SessionShutdownEvent["reason"] = "reload") {
			trace.push(`shutdown:${reason}`);
			await hooks.get("session_shutdown")?.({ type: "session_shutdown", reason }, ctx);
			stale = true;
		}
		return { manager: session, ctx, ui, command, newSession, api, start, shutdown };
	}

	let active = runtime(manager);
	const initial = active;
	return {
		initial,
		get active() {
			return active;
		},
		trace,
		staleAccesses,
		requests,
		registrations,
		start: (reason?: StartReason) => active.start(reason),
		run: (args = "") => active.command.handler(args, active.ctx),
		complete: (prefix = "") => active.command.getArgumentCompletions?.(prefix),
		failKickoff: (error?: Error) => {
			kickoffError = error;
		},
		cancelNew: () => {
			cancelNew = true;
		},
	};
}

describe("/handoff", () => {
	it("keeps configured instructions in a terminal-safe retry draft when publication fails", async () => {
		const promptFiles = await import("../src/prompt-file.js");
		const text = "Extra focus\n\u001b[31m\u009b31m\u202e";
		vi.spyOn(promptFiles, "resolvePrompt").mockReturnValue({ text, errors: [] });
		vi.spyOn(SessionManager.prototype, "appendCustomMessageEntry").mockImplementationOnce(() => {
			throw new Error("append failed");
		});
		const h = harness();
		await h.start();
		await h.run();
		const draft = h.active.ui.setEditorText.mock.calls[0][0];
		expect(draft).toContain("# Session handoff");
		expect(draft).not.toContain("\u001b");
		expect(draft).not.toMatch(/[\u007f-\u009f\p{Cf}]/u);
		const blocks = [...draft.matchAll(/\x60\x60\x60json\n([\s\S]*?)\n\x60\x60\x60/gu)];
		expect(JSON.parse(blocks[blocks.length - 1][1])).toBe(
			`# Additional handoff instructions\n\n${text}`,
		);
		expect(h.requests).toEqual([]);
	});

	it.each(["tui", "rpc"] as const)(
		"adds configured instructions before kickoff in %s without rendering raw file text",
		async (mode) => {
			const promptFiles = await import("../src/prompt-file.js");
			const extra = "Preserve exact acceptance criteria.\n\u001b[31mAdditional focus";
			vi.spyOn(promptFiles, "resolvePrompt").mockReturnValue({
				text: extra,
				errors: ["Could not read prompt\u001b[31m\nTrying user scope."],
			});
			const h = harness(undefined, { mode });
			await h.start();
			await h.run();
			expect(h.requests[0].messages).toEqual([
				expect.objectContaining({ customType: "handoff", display: true }),
				expect.objectContaining({
					customType: "handoff-instructions",
					display: false,
					content: `# Additional handoff instructions\n\n${extra}`,
				}),
			]);
			expect(h.initial.ui.notify).toHaveBeenCalledWith(
				"Could not read prompt Trying user scope.",
				"warning",
			);
			expect(
				h.active.manager
					.getEntries()
					.filter(
						(entry) =>
							entry.type === "custom_message" && entry.customType === "handoff-instructions",
					),
			).toHaveLength(1);
			expect(h.staleAccesses).toEqual([]);
		},
	);

	it.each(["tui", "rpc"] as const)(
		"creates a fresh %s session before any request without copying large history",
		async (mode) => {
			const source = savedSession();
			const leaf = source.getLeafId();
			source.appendMessage({
				role: "user",
				content: [
					{ type: "text", text: "ABANDONED HISTORY" },
					{ type: "image", mimeType: "image/png", data: "QUJD".repeat(800_000) },
				],
				timestamp: 3,
			});
			source.branch(leaf as string);
			const before = readFileSync(source.getSessionFile() as string);
			const h = harness(source, { mode });
			await h.start();
			await h.run();

			expect(h.initial.newSession).toHaveBeenCalledTimes(1);
			expect(h.active.manager).not.toBe(source);
			expect(h.trace.indexOf("newSession")).toBeLessThan(h.trace.indexOf("request"));
			expect(h.trace.indexOf("shutdown:new")).toBeLessThan(h.trace.indexOf("start:new"));
			expect(h.trace.indexOf("start:new")).toBeLessThan(h.trace.indexOf("withSession"));
			expect(h.requests).toHaveLength(1);
			expect(h.requests[0].manager).toBe(h.active.manager);
			expect(h.requests[0].messages).toEqual([
				expect.objectContaining({
					role: "custom",
					customType: "handoff",
					content: expect.any(String),
				}),
			]);
			expect(h.requests[0].content).toBe(HANDOFF_KICKOFF);
			expect(h.active.manager.getHeader()?.parentSession).toBe(source.getSessionFile());
			expect(locator(h.active.manager)).toEqual({
				id: source.getSessionId(),
				path: source.getSessionFile(),
				cwd: directory,
				name: "Original goal",
				leafId: leaf,
				bytes: before.length,
			});
			const freshContext = JSON.stringify(h.active.manager.buildSessionContext().messages);
			expect(freshContext.length).toBeLessThan(20_000);
			for (const secret of ["PRIVATE ORIGINAL HISTORY", "ABANDONED HISTORY", "QUJDQUJD"]) {
				expect(freshContext).not.toContain(secret);
			}
			expect(readFileSync(source.getSessionFile() as string).equals(before)).toBe(true);
			expect(source.getLeafId()).toBe(leaf);
			const persisted = SessionManager.open(h.active.manager.getSessionFile() as string);
			expect(persisted.getHeader()?.parentSession).toBe(source.getSessionFile());
			expect(learningEntry(persisted)).toEqual(learningEntry(h.active.manager));
			expect(SessionManager.list).not.toHaveBeenCalled();
			expect(h.registrations.tools).not.toHaveBeenCalled();
		},
	);

	it("preserves a null current leaf instead of substituting the last disk entry", async () => {
		const source = savedSession();
		source.resetLeaf();
		const h = harness(source);
		await h.start();
		await h.run(source.getSessionId());
		expect(locator(h.active.manager).leafId).toBeNull();
		expect(SessionManager.list).not.toHaveBeenCalled();
	});

	it.each(["full ID", "unique prefix", "name", "spaced name", "quoted name", "escaped quotes"])(
		"looks up a same-project source by %s",
		async (route) => {
			const target = savedSession(
				"target-unique-123",
				route === "escaped quotes" ? 'Goal "confirmed"' : "Goal with spaces",
			);
			const entry = sessionInfo(target);
			vi.mocked(SessionManager.list).mockResolvedValue([entry]);
			const query = {
				"full ID": entry.id,
				"unique prefix": "target-unique",
				name: "Single",
				"spaced name": entry.name as string,
				"quoted name": JSON.stringify(entry.name),
				"escaped quotes": JSON.stringify(entry.name),
			}[route];
			if (route === "name") entry.name = "Single";
			const h = harness();
			await h.start();
			await h.run(query);
			expect(SessionManager.list).toHaveBeenCalledWith(
				directory,
				h.initial.manager.getSessionDir(),
				undefined,
				expect.any(AbortSignal),
			);
			expect(locator(h.active.manager)).toEqual({
				path: entry.path,
				id: entry.id,
				cwd: directory,
				name: entry.name,
				bytes: statSync(entry.path).size,
			});
			expect(h.active.manager.getHeader()?.parentSession).toBe(entry.path);
			expect(h.initial.ui.select).not.toHaveBeenCalled();
		},
	);

	it.each(["ID", "name"])("prefers an exact %s over broader ID prefix matches", async (kind) => {
		const one = sessionInfo(savedSession(kind === "ID" ? "match" : "match-prefix", "Other"));
		const two = sessionInfo(savedSession("match-long", "match"));
		vi.mocked(SessionManager.list).mockResolvedValue([one, two]);
		const h = harness();
		await h.start();
		await h.run("match");
		expect(locator(h.active.manager).id).toBe(kind === "ID" ? one.id : two.id);
		expect(h.initial.ui.select).not.toHaveBeenCalled();
	});

	it("records the current leaf when finding the current session by name", async () => {
		const manager = savedSession();
		const leaf = manager.getLeafId();
		vi.mocked(SessionManager.list).mockResolvedValue([sessionInfo(manager)]);
		const h = harness(manager);
		await h.start();
		await h.run(manager.getSessionName() as string);
		expect(locator(h.active.manager).leafId).toBe(leaf);
		expect(JSON.stringify(h.requests)).not.toContain("PRIVATE INDEXED HISTORY");
		expect(JSON.stringify(h.requests)).not.toContain("PRIVATE FIRST MESSAGE");
	});

	it.each(["tui", "rpc"] as const)(
		"resolves ambiguous names using native select in %s",
		async (mode) => {
			const entries = ["one", "two"].map((id) => sessionInfo(savedSession(id, "Same name")));
			vi.mocked(SessionManager.list).mockResolvedValue(entries);
			const h = harness(undefined, { mode });
			h.initial.ui.select.mockImplementation(async (_title, labels) => labels[1]);
			await h.start();
			await h.run("Same name");
			expect(h.initial.ui.select).toHaveBeenCalledWith(
				expect.any(String),
				expect.arrayContaining([expect.stringContaining("two")]),
				{ signal: expect.any(AbortSignal) },
			);
			expect(locator(h.active.manager).id).toBe("two");
		},
	);

	it("cancels an ambiguous prefix without changing sessions", async () => {
		vi.mocked(SessionManager.list).mockResolvedValue(
			["same-1", "same-2"].map((id) => sessionInfo(savedSession(id))),
		);
		const h = harness();
		await h.start();
		await h.run("same-");
		expect(h.initial.ui.select).toHaveBeenCalledOnce();
		expect(h.initial.newSession).not.toHaveBeenCalled();
		expect(h.requests).toEqual([]);
	});

	it.each(["missing", "cross-project"])("rejects %s sources before switching", async (kind) => {
		const target = sessionInfo(savedSession("target", "Target", join(directory, "elsewhere")));
		vi.mocked(SessionManager.list).mockResolvedValue(kind === "missing" ? [] : [target]);
		const h = harness();
		await h.start();
		await expect(h.run("target")).rejects.toThrow(/No session matches.*in this project/);
		expect(h.initial.newSession).not.toHaveBeenCalled();
		expect(h.requests).toEqual([]);
	});

	it.each(['"unterminated', '"name" trailing', '""'])(
		"rejects malformed quoted selector %s",
		async (query) => {
			const h = harness();
			await h.start();
			await expect(h.run(query)).rejects.toThrow(/Use \/handoff/);
			expect(h.initial.newSession).not.toHaveBeenCalled();
		},
	);

	it.each(["print", "json"] as const)("rejects %s without relying on no-op UI", async (mode) => {
		const h = harness(undefined, { mode, hasUI: false });
		await h.start();
		await expect(h.run()).rejects.toThrow(/requires TUI or RPC/);
		expect(h.initial.newSession).not.toHaveBeenCalled();
		expect(h.initial.ui.notify).not.toHaveBeenCalled();
	});

	it.each(["memory", "unsaved", "empty file", "directory", "deleted file"])(
		"requires a source disk file: %s",
		async (kind) => {
			let source: SessionManager;
			if (kind === "memory") source = SessionManager.inMemory(directory);
			else if (kind === "unsaved")
				source = SessionManager.create(directory, join(directory, "sessions"));
			else source = savedSession();
			if (kind === "empty file") writeFileSync(source.getSessionFile() as string, "");
			if (kind === "deleted file") rmSync(source.getSessionFile() as string);
			const h = harness(source);
			if (kind === "directory") {
				vi.mocked(SessionManager.list).mockResolvedValue([
					sessionInfo(source, { id: "dir", path: directory }),
				]);
			}
			await h.start();
			await expect(h.run(kind === "directory" ? "dir" : "")).rejects.toThrow();
			expect(h.initial.newSession).not.toHaveBeenCalled();
			expect(h.requests).toEqual([]);
		},
	);

	it("honors Pi's cancellation of newSession and can be retried", async () => {
		const h = harness();
		h.cancelNew();
		await h.start();
		await h.run();
		await h.run();
		expect(h.active).toBe(h.initial);
		expect(h.initial.newSession).toHaveBeenCalledTimes(2);
		expect(h.initial.ui.notify).toHaveBeenCalledWith(expect.stringContaining("cancelled"), "info");
		expect(h.requests).toEqual([]);
	});

	it("keeps a failed prompt publication in the fresh session as a full learning draft", async () => {
		const h = harness();
		const oldFile = readFileSync(h.initial.manager.getSessionFile() as string);
		vi.spyOn(SessionManager.prototype, "appendCustomMessageEntry").mockImplementationOnce(() => {
			throw new Error("append failed");
		});
		await h.start();
		await h.run();
		expect(h.active).not.toBe(h.initial);
		expect(h.requests).toEqual([]);
		expect(h.active.ui.setEditorText).toHaveBeenCalledWith(
			expect.stringContaining("# Session handoff"),
		);
		const draft = h.active.ui.setEditorText.mock.calls[0][0];
		expect(draft).toContain(h.initial.manager.getSessionFile());
		expect(draft).toContain("explicit user confirmation");
		expect(readFileSync(h.initial.manager.getSessionFile() as string)).toEqual(oldFile);
		expect(h.initial.ui.notify).not.toHaveBeenCalled();
		await h.active.ctx.sendUserMessage(draft);
		expect(h.requests).toHaveLength(1);
		expect(h.requests[0].manager).toBe(h.active.manager);
		expect(h.requests[0].content).toBe(draft);
	});

	it("leaves kickoff failures in the fresh session with a retryable draft", async () => {
		const h = harness();
		h.failKickoff(new Error("provider unavailable\u001b[31m\nretry"));
		await h.start();
		await h.run();
		expect(h.active).not.toBe(h.initial);
		expect(learningEntry(h.active.manager).content).toContain("# Session handoff");
		expect(h.active.ui.setEditorText).toHaveBeenCalledWith(HANDOFF_KICKOFF);
		expect(h.active.ui.notify).toHaveBeenCalledWith(
			expect.stringMatching(/submit the draft to retry/i),
			"error",
		);
		expect(JSON.stringify(h.active.ui.notify.mock.calls)).not.toContain("\\u001b");
		expect(h.initial.ui.setEditorText).not.toHaveBeenCalled();
		expect(h.initial.ui.notify).not.toHaveBeenCalled();
		h.failKickoff();
		await h.active.ctx.sendUserMessage(h.active.ui.setEditorText.mock.calls[0][0]);
		expect(h.requests).toHaveLength(2);
		expect(h.requests.every((request) => request.manager === h.active.manager)).toBe(true);
		expect(learningEntry(h.active.manager).customType).toBe("handoff");
		expect(h.initial.newSession).toHaveBeenCalledOnce();
	});
});

describe("asynchronous ownership", () => {
	it.each(["list", "stat", "dialog"])(
		"does not switch or use stale context after shutdown during %s",
		async (stage) => {
			const source = sessionInfo(savedSession("lookup-1", "Duplicate"));
			const entered = deferred<void>();
			const release = deferred<void>();
			vi.mocked(SessionManager.list).mockResolvedValue([source, { ...source, id: "lookup-2" }]);
			const h = harness();
			if (stage === "list") {
				vi.mocked(SessionManager.list).mockImplementationOnce(async () => {
					entered.resolve();
					await release.promise;
					return [source];
				});
			} else if (stage === "stat") {
				vi.mocked(stat).mockImplementationOnce((async () => {
					entered.resolve();
					await release.promise;
					return statSync(source.path);
				}) as unknown as typeof stat);
			} else {
				h.initial.ui.select.mockImplementationOnce(async (_title, labels) => {
					entered.resolve();
					await release.promise;
					return labels[0];
				});
			}
			await h.start();
			const operation = h.run(stage === "stat" ? "" : "lookup-");
			await entered.promise;
			await h.initial.shutdown();
			release.resolve();
			await expect(operation).resolves.toBeUndefined();
			expect(h.initial.newSession).not.toHaveBeenCalled();
			expect(h.initial.ui.notify).not.toHaveBeenCalled();
			expect(h.requests).toEqual([]);
			expect(h.staleAccesses).toEqual([]);
			if (stage !== "stat") {
				const signal = vi.mocked(SessionManager.list).mock.calls[0][3];
				expect(signal?.aborted).toBe(true);
			}
		},
	);

	it.each(["list", "stat", "dialog"])(
		"ignores a rejected pending %s after shutdown",
		async (stage) => {
			const entered = deferred<void>();
			const result = deferred<never>();
			const source = sessionInfo(savedSession("lookup-1"));
			vi.mocked(SessionManager.list).mockResolvedValue([source, { ...source, id: "lookup-2" }]);
			const h = harness();
			if (stage === "list") {
				vi.mocked(SessionManager.list).mockImplementationOnce(() => {
					entered.resolve();
					return result.promise;
				});
			} else if (stage === "stat") {
				vi.mocked(stat).mockImplementationOnce(() => {
					entered.resolve();
					return result.promise;
				});
			} else {
				h.initial.ui.select.mockImplementationOnce(() => {
					entered.resolve();
					return result.promise;
				});
			}
			await h.start();
			const operation = h.run(stage === "stat" ? "" : "lookup-");
			await entered.promise;
			await h.initial.shutdown();
			result.reject(new Error("Aborted pending operation"));
			await expect(operation).resolves.toBeUndefined();
			expect(h.initial.newSession).not.toHaveBeenCalled();
			expect(h.initial.ui.notify).not.toHaveBeenCalled();
			expect(h.staleAccesses).toEqual([]);
		},
	);

	it("rejects duplicate handoffs while lookup is pending", async () => {
		const result = deferred<SessionInfo[]>();
		const source = sessionInfo(savedSession("lookup"));
		vi.mocked(SessionManager.list).mockReturnValueOnce(result.promise);
		const h = harness();
		await h.start();
		const first = h.run("lookup");
		await expect(h.run()).rejects.toThrow(/already being prepared/);
		result.resolve([source]);
		await first;
		expect(h.initial.newSession).toHaveBeenCalledOnce();
		expect(h.requests).toHaveLength(1);
	});

	it("releases duplicate protection after lookup fails", async () => {
		vi.mocked(SessionManager.list).mockRejectedValueOnce(new Error("lookup failed"));
		const h = harness();
		await h.start();
		await expect(h.run("lookup")).rejects.toThrow("lookup failed");
		await h.run();
		expect(h.initial.newSession).toHaveBeenCalledOnce();
	});
});

describe("--handoff startup", () => {
	it("registers only the long string flag and no history tool", async () => {
		const h = harness();
		expect(h.registrations.flags).toEqual([
			{ name: "handoff", flag: expect.objectContaining({ type: "string" }) },
		]);
		expect(h.registrations.commands).toEqual(["handoff"]);
		expect(h.registrations.tools).not.toHaveBeenCalled();
	});

	it.each(["ID", "name"])(
		"saves the prompt before kickoff by %s without creating another session",
		async (kind) => {
			const source = sessionInfo(savedSession("startup-source", "Startup source"));
			vi.mocked(SessionManager.list).mockResolvedValue([source]);
			const fresh = SessionManager.create(directory, join(directory, "sessions"));
			fresh.appendModelChange("test", "test");
			const h = harness(fresh, { flag: kind === "ID" ? source.id : source.name });
			process.argv = [
				"node",
				"pi",
				"--handoff",
				kind === "ID" ? source.id : (source.name as string),
			];
			await h.start();
			expect(h.trace).toEqual(["start:startup", "prompt", "request"]);
			expect(h.initial.newSession).not.toHaveBeenCalled();
			expect(h.active.manager).toBe(fresh);
			expect(h.requests).toHaveLength(1);
			expect(h.requests[0].messages).toEqual([expect.objectContaining({ role: "custom" })]);
			expect(h.initial.api.sendMessage).toHaveBeenCalledWith(
				expect.objectContaining({ display: true, customType: "handoff" }),
				{ triggerTurn: false },
			);
			expect(locator(fresh).id).toBe(source.id);
			expect(fresh.getHeader()?.parentSession).toBeUndefined();
			expect(learningEntry(SessionManager.open(fresh.getSessionFile() as string))).toEqual(
				learningEntry(fresh),
			);
			for (const reason of ["reload", "new", "resume", "startup"] as const) await h.start(reason);
			expect(h.requests).toHaveLength(1);
		},
	);

	it.each([true, "", "   "])("rejects a missing flag value %s", async (flag) => {
		const h = harness(SessionManager.create(directory, join(directory, "sessions")), { flag });
		await expect(h.start()).rejects.toThrow(/requires a source session ID or name/);
		expect(h.requests).toEqual([]);
		expect(h.initial.newSession).not.toHaveBeenCalled();
	});

	it.each(["rpc", "print", "json"] as const)("rejects startup mode %s", async (mode) => {
		const h = harness(undefined, { mode, flag: "source" });
		await expect(h.start()).rejects.toThrow(/requires interactive TUI/);
		expect(h.requests).toEqual([]);
	});

	it.each([
		["--continue"],
		["-c"],
		["--resume"],
		["-r"],
		["--session", "old.jsonl"],
		["--session-id", "chosen-id"],
		["--fork", "old.jsonl"],
		["--no-session"],
		["initial prompt"],
		["@input.txt"],
		["--", "initial prompt"],
	])("rejects conflicting CLI arguments %j", async (...args) => {
		const h = harness(SessionManager.create(directory, join(directory, "sessions")), {
			flag: "source",
		});
		process.argv = ["node", "pi", "--handoff", "source", ...args];
		await expect(h.start()).rejects.toThrow(/must start fresh/);
		expect(h.requests).toEqual([]);
		expect(SessionManager.list).not.toHaveBeenCalled();
	});

	it.each(["message", "custom_message", "compaction", "branch_summary"])(
		"rejects non-fresh %s history",
		async (kind) => {
			const manager = SessionManager.create(directory, join(directory, "sessions"));
			if (kind === "message") manager.appendMessage({ role: "user", content: "old", timestamp: 1 });
			if (kind === "custom_message") manager.appendCustomMessageEntry("other", "old", true);
			if (kind === "compaction") manager.appendCompaction("old", null, 1);
			if (kind === "branch_summary") manager.branchWithSummary(null, "old");
			const h = harness(manager, { flag: "source" });
			await expect(h.start()).rejects.toThrow(/requires a fresh session/);
			expect(h.requests).toEqual([]);
		},
	);

	it.each(["reload", "new", "resume", "fork"] as const)(
		"does not replay startup flags in a fresh runtime started for %s",
		async (reason) => {
			const h = harness(undefined, { flag: "source" });
			await h.start(reason);
			expect(SessionManager.list).not.toHaveBeenCalled();
			expect(h.requests).toEqual([]);
		},
	);

	it.each(["resolve", "reject"])(
		"does not publish startup prompts when lookup completes by %s after shutdown",
		async (outcome) => {
			const result = deferred<SessionInfo[]>();
			vi.mocked(SessionManager.list).mockReturnValueOnce(result.promise);
			const fresh = SessionManager.create(directory, join(directory, "sessions"));
			const h = harness(fresh, { flag: "lookup" });
			const startup = h.start();
			await h.initial.shutdown();
			if (outcome === "resolve") result.resolve([sessionInfo(savedSession("lookup"))]);
			else result.reject(new Error("lookup aborted"));
			await expect(startup).resolves.toBeUndefined();
			expect(h.initial.api.sendMessage).not.toHaveBeenCalled();
			expect(h.requests).toEqual([]);
			expect(h.staleAccesses).toEqual([]);
		},
	);

	it("does nothing without the startup flag", async () => {
		const h = harness();
		await h.start();
		expect(h.requests).toEqual([]);
		expect(SessionManager.list).not.toHaveBeenCalled();
	});
});

describe("completion and terminal safety", () => {
	it("finds names but inserts IDs, scoped to cwd and the active session directory", async () => {
		const source = sessionInfo(savedSession("stable-id", "Goal with spaces"));
		const foreign = { ...source, id: "foreign", cwd: join(directory, "other") };
		vi.mocked(SessionManager.list).mockResolvedValue([source, foreign]);
		const h = harness();
		await h.start();
		expect(await h.complete('"WITH')).toEqual([
			{ value: "stable-id", label: "Goal with spaces", description: "stable-id" },
		]);
		expect(await h.complete("stable")).toHaveLength(1);
		expect(SessionManager.list).toHaveBeenCalledWith(
			directory,
			h.active.manager.getSessionDir(),
			undefined,
			expect.any(AbortSignal),
		);
	});

	it("strips terminal controls from completions and labels while preserving raw locator data", async () => {
		const dirtyName = "\u001b[31mVisible\u001b[0m\tname\u202e";
		const source = sessionInfo(savedSession("safe-id"), { name: dirtyName });
		vi.mocked(SessionManager.list).mockResolvedValue([source, { ...source, id: "safe-id-2" }]);
		const h = harness();
		h.initial.ui.select.mockImplementation(async (_title, labels) => labels[0]);
		await h.start();
		const completions = await h.complete("\u001b[32mVISIBLE");
		expect(completions).toHaveLength(2);
		for (const completion of completions ?? []) {
			expect(JSON.stringify(completion)).not.toMatch(/\\u001b|\\t|\u202e/u);
			expect(completion.label).toContain("Visible");
		}
		await h.run(dirtyName);
		expect(JSON.stringify(h.initial.ui.select.mock.calls)).not.toMatch(/\\u001b|\\t|\u202e/u);
		expect(locator(h.active.manager).name).toBe(dirtyName);
	});

	it("sanitizes every displayed ID without changing indexed data", async () => {
		const source = sessionInfo(savedSession(), { id: "\u001b[31mopaque-id\u001b[0m\t" });
		vi.mocked(SessionManager.list).mockResolvedValue([source]);
		const h = harness();
		await h.start();
		expect(await h.complete("opaque")).toEqual([
			{ value: "opaque-id ", label: "Original goal", description: "opaque-id " },
		]);
		expect(source.id).toBe("\u001b[31mopaque-id\u001b[0m\t");
	});

	it.each(["resolve", "reject"])(
		"suppresses pending completion results after shutdown: %s",
		async (outcome) => {
			const result = deferred<SessionInfo[]>();
			vi.mocked(SessionManager.list).mockReturnValueOnce(result.promise);
			const h = harness();
			expect(await h.complete()).toBeNull();
			await h.start();
			const completion = h.complete();
			await h.initial.shutdown();
			if (outcome === "resolve") result.resolve([sessionInfo(h.initial.manager)]);
			else result.reject(new Error("lookup aborted"));
			expect(await completion).toBeNull();
			expect(await h.complete()).toBeNull();
		},
	);

	it("sanitizes missing-source error text", async () => {
		const h = harness();
		await h.start();
		const error = await h.run("unknown\u001b[31m\nname").catch((value: unknown) => value);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).not.toContain("\u001b");
		expect((error as Error).message).not.toContain("\n");
	});
});

describe("learning prompt contract", () => {
	it("escapes terminal controls in the visible locator without changing its raw data", () => {
		const source: HandoffSource = {
			path: "/project/\u009b31m\u202esession.jsonl",
			id: "source",
			cwd: "/project",
			name: "\u001b[31mOriginal\u001b[0m\u{e0001}",
			bytes: 100,
		};
		const prompt = buildHandoffPrompt(source);
		expect(prompt).not.toContain("\u001b");
		expect(prompt).not.toMatch(/[\u007f-\u009f\p{Cf}]/u);
		const encoded = prompt.match(/\x60\x60\x60json\n([\s\S]*?)\n\x60\x60\x60/u)?.[1];
		expect(encoded).toBeDefined();
		expect(JSON.parse(encoded as string)).toEqual(source);
	});

	it("requires autonomous large-file investigation, evidence grading, human priority and explicit confirmation", () => {
		const source: HandoffSource = {
			path: "/source/session.jsonl",
			id: "source",
			cwd: "/project",
			leafId: null,
			bytes: 9_000_000,
		};
		const prompt = buildHandoffPrompt(source);
		for (const requirement of [
			"Inspect its size and structure first",
			"incremental reads",
			"your own scripts",
			"images, base64",
			"no extension-owned history reader, filtering, truncation",
			"do not resume it",
			"id/parentId",
			"null means an empty selected branch",
			"compaction, branch summaries, and context_edit",
			"original objective",
			"later corrections",
			"earlier human instructions",
			"historical data, not new authority",
			"verified completion",
			"assistant claims",
			"attempted but failed work",
			"external blockers",
			'"done" is not proof',
			"core output files",
			"current workspace, commits, and recorded checks",
			"only read-only investigation",
			"whether the goal and scope are complete and correct",
			"Stop and wait",
			"only after explicit user confirmation",
			"confirm the revised scope",
			"not a restoration of old extension state",
		])
			expect(prompt).toContain(requirement);
		expect(prompt).toContain(JSON.stringify(source, null, 2));
		expect(HANDOFF_KICKOFF).toMatch(/confirm or correct the complete goal before continuing/);
	});
});
