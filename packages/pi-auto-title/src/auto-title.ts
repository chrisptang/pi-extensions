import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { resolveTitleModel } from "./alias.js";
import { buildTitleGenerationContext, extractCompactTurns } from "./context.js";
import { generateSessionTitle } from "./generator.js";
import { loadSettings } from "./settings.js";

interface SessionTitlingState {
	named: boolean;
	userTurnCount: number;
	inFlightController?: AbortController;
}

export default function autoTitle(pi: ExtensionAPI): void {
	let state: SessionTitlingState = {
		named: false,
		userTurnCount: 0,
	};

	const resetState = (ctx: ExtensionContext) => {
		state.inFlightController?.abort();
		const currentName = pi.getSessionName();
		const existingEntries = ctx.sessionManager?.getEntries ? ctx.sessionManager.getEntries() : [];
		const existingTurns = extractCompactTurns(existingEntries).length;

		state = {
			named: currentName !== undefined && currentName.trim().length > 0,
			userTurnCount: existingTurns,
		};
	};

	pi.on("session_start", (_event, ctx) => {
		resetState(ctx);
	});

	pi.on("session_info_changed", (event) => {
		if (event.name && event.name.trim().length > 0) {
			state.named = true;
		} else {
			state.named = false;
		}
	});

	pi.on("agent_start", () => {
		state.userTurnCount++;
	});

	pi.on("agent_settled", async (_event, ctx) => {
		const settings = loadSettings({
			cwd: ctx.cwd,
			isProjectTrusted: ctx.isProjectTrusted(),
		});

		if (!settings.enabled) return;
		if (state.named) return;
		if (pi.getSessionName()) {
			state.named = true;
			return;
		}

		if (state.userTurnCount !== settings.triggerTurn) {
			return;
		}

		// Mark as named to prevent duplicate triggers
		state.named = true;

		state.inFlightController?.abort();
		const controller = new AbortController();
		state.inFlightController = controller;

		try {
			const model = resolveTitleModel({
				requestedModelOrAlias: settings.model,
				modelRegistry: ctx.modelRegistry,
				currentModel: ctx.model,
				fallbackToCurrentModel: settings.fallbackToCurrentModel,
			});

			if (!model) return;

			const entries = ctx.sessionManager.getEntries();
			const contextText = buildTitleGenerationContext(entries);
			if (!contextText) return;

			const title = await generateSessionTitle({
				model,
				completer: ctx.modelRegistry,
				conversationContext: contextText,
				maxLength: settings.maxTitleLength,
				signal: controller.signal,
			});

			if (title && !controller.signal.aborted) {
				// Only set if user hasn't explicitly set a name in the meantime
				if (!pi.getSessionName()) {
					pi.setSessionName(title);
				}
			}
		} catch {
			// Silent on background naming failures
		} finally {
			if (state.inFlightController === controller) {
				state.inFlightController = undefined;
			}
		}
	});

	pi.on("session_shutdown", () => {
		state.inFlightController?.abort();
		state.inFlightController = undefined;
	});

	pi.registerCommand("auto-title", {
		description: "Generate a session title or check auto-title status",
		handler: async (args: string, cmdCtx: ExtensionCommandContext) => {
			const sub = args.trim();
			const isTrusted =
				typeof cmdCtx.isProjectTrusted === "function" ? cmdCtx.isProjectTrusted() : false;
			const settings = loadSettings({
				cwd: cmdCtx.cwd,
				isProjectTrusted: isTrusted,
			});

			if (sub === "generate" || sub === "now") {
				const model = resolveTitleModel({
					requestedModelOrAlias: settings.model,
					modelRegistry: cmdCtx.modelRegistry,
					currentModel: cmdCtx.model,
					fallbackToCurrentModel: settings.fallbackToCurrentModel,
				});

				if (!model) {
					if (cmdCtx.hasUI) {
						cmdCtx.ui.notify(
							`auto-title: Could not resolve a usable model for "${settings.model}".`,
							"error",
						);
					}
					return;
				}

				const entries = cmdCtx.sessionManager.getEntries();
				const contextText = buildTitleGenerationContext(entries);
				if (!contextText) {
					if (cmdCtx.hasUI) {
						cmdCtx.ui.notify(
							"auto-title: No conversation context found to generate title.",
							"warning",
						);
					}
					return;
				}

				const title = await generateSessionTitle({
					model,
					completer: cmdCtx.modelRegistry,
					conversationContext: contextText,
					maxLength: settings.maxTitleLength,
				});

				if (title) {
					pi.setSessionName(title);
					state.named = true;
					if (cmdCtx.hasUI) {
						cmdCtx.ui.notify(`Session title set to: "${title}"`, "info");
					}
				} else if (cmdCtx.hasUI) {
					cmdCtx.ui.notify("auto-title: Failed to generate title from model.", "error");
				}
				return;
			}

			if (sub.startsWith("set ")) {
				const customName = sub.slice(4).trim();
				if (customName) {
					pi.setSessionName(customName);
					state.named = true;
					if (cmdCtx.hasUI) {
						cmdCtx.ui.notify(`Session title set to: "${customName}"`, "info");
					}
				}
				return;
			}

			// Default status view
			const currentName = pi.getSessionName() ?? "(none)";
			const info = [
				`Auto-Title Status:`,
				`  • Current title: ${currentName}`,
				`  • Configured model: ${settings.model}`,
				`  • Trigger turn: ${settings.triggerTurn} (Current user turns: ${state.userTurnCount})`,
				`  • Enabled: ${settings.enabled}`,
				``,
				`Usage:`,
				`  /auto-title generate   - Generate a title now from current conversation`,
				`  /auto-title set <name> - Manually set session title`,
			].join("\n");

			if (cmdCtx.hasUI) {
				cmdCtx.ui.notify(info, "info");
			}
		},
	});
}
