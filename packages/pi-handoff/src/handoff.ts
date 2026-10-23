import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
	type ExtensionAPI,
	type ExtensionContext,
	parseArgs,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { buildHandoffPrompt, HANDOFF_KICKOFF, type HandoffSource, promptJson } from "./prompt.js";
import { resolvePrompt } from "./prompt-file.js";

const MESSAGE_TYPE = "handoff";

function displayText(value: string): string {
	return stripVTControlCharacters(value).replace(/[\p{Cc}\p{Cf}]/gu, " ");
}

function handoffMessages(source: HandoffSource, ctx: ExtensionContext) {
	const { text, errors } = resolvePrompt(ctx.cwd, ctx.isProjectTrusted());
	for (const error of errors) ctx.ui.notify(displayText(error), "warning");
	return [
		{
			customType: MESSAGE_TYPE,
			content: buildHandoffPrompt(source),
			display: true,
			details: { version: 1, source },
		},
		...(text
			? [
					{
						customType: "handoff-instructions",
						content: `# Additional handoff instructions\n\n${text}`,
						display: false,
					},
				]
			: []),
	];
}

function selector(value: string): string {
	const text = value.trim();
	if (!text.startsWith('"')) return text;
	try {
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed === "string" && parsed.trim()) return parsed.trim();
	} catch {
		// A quoted selector must contain exactly one complete JSON string.
	}
	throw new Error('Use /handoff, /handoff <session-id>, or /handoff "session name".');
}

export default function handoff(pi: ExtensionAPI): void {
	let owner:
		| {
				manager: ExtensionContext["sessionManager"];
				cwd: string;
				sessionDir: string;
				controller: AbortController;
		  }
		| undefined;
	let pending: object | undefined;
	let startupHandled = false;

	const findSource = async (
		ctx: ExtensionContext,
		query: string,
		signal: AbortSignal,
	): Promise<HandoffSource | undefined> => {
		const manager = ctx.sessionManager;
		const cwd = ctx.cwd;
		const currentPath = manager.getSessionFile();
		let source: Omit<HandoffSource, "bytes">;
		if (!query || query === manager.getSessionId()) {
			if (!currentPath) throw new Error("Handoff requires a saved source session.");
			source = {
				path: currentPath,
				id: manager.getSessionId(),
				cwd,
				name: manager.getSessionName(),
				leafId: manager.getLeafId(),
			};
		} else {
			const sessions = (
				await SessionManager.list(cwd, manager.getSessionDir(), undefined, signal)
			).filter((session) => resolve(session.cwd) === resolve(cwd));
			if (signal.aborted) return;
			let matches = sessions.filter((session) => session.id === query);
			if (!matches.length) matches = sessions.filter((session) => session.name === query);
			if (!matches.length) matches = sessions.filter((session) => session.id.startsWith(query));
			if (!matches.length) {
				throw new Error(`No session matches "${displayText(query)}" in this project.`);
			}
			let selected = matches[0];
			if (matches.length > 1) {
				const labels = matches.map(
					(session, index) =>
						`${index + 1}. ${displayText(session.name ?? "Unnamed")} · ${displayText(session.id)}`,
				);
				const choice = await ctx.ui.select("Choose the source session", labels, { signal });
				if (signal.aborted || choice === undefined) return;
				selected = matches[labels.indexOf(choice)];
				if (!selected) return;
			}
			source = {
				path: selected.path,
				id: selected.id,
				cwd: selected.cwd,
				name: selected.name,
				...(selected.path === currentPath ? { leafId: manager.getLeafId() } : {}),
			};
		}
		const info = await stat(source.path);
		if (signal.aborted) return;
		if (!info.isFile() || info.size === 0) {
			throw new Error("The source session has no saved conversation file.");
		}
		return { ...source, bytes: info.size };
	};

	pi.registerFlag("handoff", {
		type: "string",
		description:
			"Learn a same-project session by ID or name in a fresh session, then confirm its goal",
	});

	pi.registerCommand("handoff", {
		description:
			"Start fresh and learn the current or a same-project session before confirming its goal",
		getArgumentCompletions: async (prefix) => {
			const current = owner;
			if (!current || current.controller.signal.aborted) return null;
			const sessions = await SessionManager.list(
				current.cwd,
				current.sessionDir,
				undefined,
				current.controller.signal,
			).catch((error) => {
				if (current.controller.signal.aborted) return [];
				throw error;
			});
			if (current.controller.signal.aborted) return null;
			const query = displayText(prefix).replace(/^"/u, "").toLowerCase();
			return sessions
				.filter(
					(session) =>
						resolve(session.cwd) === resolve(current.cwd) &&
						(displayText(session.id).toLowerCase().startsWith(query) ||
							displayText(session.name ?? "")
								.toLowerCase()
								.includes(query)),
				)
				.map((session) => ({
					value: displayText(session.id),
					label: displayText(session.name ?? session.id),
					description: displayText(session.id),
				}));
		},
		handler: async (args, ctx) => {
			if (!ctx.hasUI) throw new Error("/handoff requires TUI or RPC mode.");
			const current = owner;
			if (!current || current.manager !== ctx.sessionManager || current.controller.signal.aborted) {
				throw new Error("Handoff is unavailable for a stale session.");
			}
			if (pending) throw new Error("A handoff is already being prepared.");
			const operation = {};
			pending = operation;
			try {
				const source = await findSource(ctx, selector(args), current.controller.signal);
				if (!source || current.controller.signal.aborted) return;
				const messages = handoffMessages(source, ctx);
				const result = await ctx.newSession({
					parentSession: source.path,
					withSession: async (replacement) => {
						const manager = replacement.sessionManager;
						const isCurrent = () => {
							try {
								return replacement.sessionManager === manager;
							} catch {
								return false;
							}
						};
						let saved = false;
						try {
							for (const message of messages) {
								await replacement.sendMessage(message, { triggerTurn: false });
								if (!isCurrent()) return;
							}
							saved = true;
							await replacement.sendUserMessage(HANDOFF_KICKOFF);
						} catch (error) {
							if (!isCurrent()) return;
							replacement.ui.setEditorText(
								saved
									? HANDOFF_KICKOFF
									: messages
											.map((message) =>
												message.display
													? message.content
													: `## Additional handoff instructions (JSON-encoded text)\n\`\`\`json\n${promptJson(message.content)}\n\`\`\``,
											)
											.join("\n\n"),
							);
							replacement.ui.notify(
								`Fresh session created, but preparation did not start: ${displayText(String(error))}. Submit the draft to retry; the source session is unchanged.`,
								"error",
							);
						}
					},
				});
				if (result.cancelled && !current.controller.signal.aborted) {
					ctx.ui.notify("Handoff cancelled. The source session is unchanged.", "info");
				}
			} catch (error) {
				if (current.controller.signal.aborted) return;
				throw new Error(displayText(String(error)), { cause: error });
			} finally {
				if (pending === operation) pending = undefined;
			}
		},
	});

	pi.on("session_start", async (event, ctx) => {
		owner?.controller.abort();
		const current = {
			manager: ctx.sessionManager,
			cwd: ctx.cwd,
			sessionDir: ctx.sessionManager.getSessionDir(),
			controller: new AbortController(),
		};
		owner = current;
		if (event.reason !== "startup" || startupHandled) return;
		startupHandled = true;
		const flag = pi.getFlag("handoff");
		if (flag === undefined) return;
		if (typeof flag !== "string" || !flag.trim()) {
			throw new Error("--handoff requires a source session ID or name.");
		}
		if (ctx.mode !== "tui") throw new Error("--handoff requires interactive TUI mode.");
		const args = parseArgs(process.argv.slice(2));
		if (
			args.continue ||
			args.resume ||
			args.session ||
			args.sessionId ||
			args.fork ||
			args.noSession ||
			args.messages.length ||
			args.fileArgs.length
		) {
			throw new Error(
				"--handoff must start fresh, without resume/session/fork options or initial prompts/files.",
			);
		}
		if (
			ctx.sessionManager
				.getEntries()
				.some(
					(entry) =>
						entry.type === "message" ||
						entry.type === "custom_message" ||
						entry.type === "compaction" ||
						entry.type === "branch_summary",
				)
		) {
			throw new Error("--handoff requires a fresh session. Use /handoff from an existing session.");
		}
		const source = await findSource(ctx, flag.trim(), current.controller.signal).catch((error) => {
			if (current.controller.signal.aborted) return undefined;
			throw new Error(displayText(String(error)), { cause: error });
		});
		if (!source || current.controller.signal.aborted) return;
		for (const message of handoffMessages(source, ctx)) {
			pi.sendMessage(message, { triggerTurn: false });
		}
		// Do not await an agent run from session_start; Pi owns cancellation and errors.
		pi.sendUserMessage(HANDOFF_KICKOFF);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (owner?.manager !== ctx.sessionManager) return;
		owner.controller.abort();
		owner = undefined;
	});
}
