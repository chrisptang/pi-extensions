import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendHistory, DEFAULT_MAX_ENTRIES, historyFilePath, loadHistory } from "./store.js";

/**
 * Pi's editor keeps its in-memory prompt history capped at 100 entries and drops
 * anything past that, so seeding stops at the same bound even though the file
 * retains `DEFAULT_MAX_ENTRIES`.
 */
export const EDITOR_HISTORY_LIMIT = 100;

export default function history(pi: ExtensionAPI): void {
	/** Reported once per session so a broken file does not notify on every prompt. */
	let appendFailureReported = false;

	const warn = (ctx: ExtensionContext, message: string) => {
		if (ctx.hasUI) ctx.ui.notify(message, "warning");
	};

	pi.on("session_start", async (_event, ctx) => {
		appendFailureReported = false;
		// The editor exists only in TUI mode; other modes still append to the file.
		if (ctx.mode !== "tui") return;

		const { entries } = loadHistory(ctx.cwd, (message) => warn(ctx, message));
		if (entries.length === 0) return;
		const seed = entries.slice(-EDITOR_HISTORY_LIMIT);

		// Installing an editor factory is the only supported way to reach the
		// editor's history. The subclass changes nothing else, so every native
		// behavior Pi wires onto a custom editor is preserved.
		const { createHistoryEditorFactory } = await import("./editor.js");
		ctx.ui.setEditorComponent(createHistoryEditorFactory(seed));
	});

	pi.on("input", async (event, ctx) => {
		// Only prompts the user actually typed belong in history; extension-injected
		// and RPC messages are not things the user would page back to.
		if (event.source !== "interactive") return { action: "continue" };

		try {
			appendHistory(ctx.cwd, event.text);
		} catch (error) {
			if (!appendFailureReported) {
				appendFailureReported = true;
				const detail = error instanceof Error ? error.message : String(error);
				warn(ctx, `pi-history: not recording prompts: ${detail}`);
			}
		}
		return { action: "continue" };
	});

	pi.registerCommand("history", {
		description: "Show where this project's prompt history is stored",
		handler: async (args: string, ctx) => {
			if (args.trim()) {
				if (ctx.hasUI) ctx.ui.notify("/history takes no arguments.", "error");
				return;
			}
			if (!ctx.hasUI) return;
			const path = historyFilePath(ctx.cwd);
			const { entries, malformed } = loadHistory(ctx.cwd, (message) => warn(ctx, message));
			if (malformed) {
				ctx.ui.notify(`pi-history: ${path} is unreadable; prompts are not recorded.`, "error");
				return;
			}
			const browsable = Math.min(entries.length, EDITOR_HISTORY_LIMIT);
			ctx.ui.notify(
				`${entries.length} prompt(s) in ${path} (max ${DEFAULT_MAX_ENTRIES}); ` +
					`the most recent ${browsable} are reachable with Up.`,
				"info",
			);
		},
	});
}
