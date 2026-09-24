import { type ExtensionAPI, getMarkdownTheme, keyText } from "@earendil-works/pi-coding-agent";
import { Box, type Component, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { formatDuration, formatSpend, sanitizeTerminalText } from "./text.js";

export const COMPLETION_MESSAGE_TYPE = "pi-subagents-completion";

function createCompletionBox(
	children: Component[],
	outputPad: number,
	background: (text: string) => string,
): Component {
	return {
		render(width) {
			if (width <= 0) return [];
			const maxPadding = Math.floor((width - 1) / 2);
			const box = new Box(Math.min(Math.max(0, outputPad), maxPadding), 1, background);
			for (const child of children) box.addChild(child);
			return box.render(width);
		},
		invalidate() {
			for (const child of children) child.invalidate();
		},
	};
}

export function registerCompletionRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer(COMPLETION_MESSAGE_TYPE, (message, options, theme) => {
		const children: Component[] = [
			new Text(theme.fg("customMessageLabel", theme.bold(`[${COMPLETION_MESSAGE_TYPE}]`)), 0, 0),
			new Spacer(1),
		];
		if (!options.expanded) {
			children.push(
				new Text(
					theme.fg("customMessageText", `Subagent job completion${summaryOf(message.details)} (`) +
						theme.fg("dim", keyText("app.tools.expand")) +
						theme.fg("customMessageText", " to expand)"),
					0,
					0,
				),
			);
		} else {
			const content =
				typeof message.content === "string"
					? message.content
					: message.content
							.filter((part) => part.type === "text")
							.map((part) => part.text)
							.join("\n");
			children.push(
				new Markdown(sanitizeTerminalText(content), 0, 0, getMarkdownTheme(), {
					color: (text) => theme.fg("customMessageText", text),
				}),
			);
		}
		return createCompletionBox(children, options.outputPad, (text) =>
			theme.bg("customMessageBg", text),
		);
	});
}

/**
 * ` · explorer · completed · 48s · 5 turns · cache 81.2% · in 62k · out 1.1k · $0.042`.
 *
 * Details come from the session file, where completions recorded before usage
 * was reported lack these fields, so each part appears only when well-formed.
 */
function summaryOf(details: unknown): string {
	if (typeof details !== "object" || details === null) return "";
	const { agent, state, elapsedMs, turns, usage } = details as Record<string, unknown>;
	const parts: string[] = [];
	if (typeof agent === "string")
		parts.push(sanitizeTerminalText(agent).replace(/\s+/gu, " ").trim());
	if (typeof state === "string") parts.push(sanitizeTerminalText(state));
	if (isCount(elapsedMs)) parts.push(formatDuration(elapsedMs / 1_000));
	if (isCount(turns)) parts.push(`${turns} turns`);
	if (isSpend(usage)) parts.push(formatSpend(usage));
	const shown = parts.filter((part) => part !== "");
	return shown.length > 0 ? ` · ${shown.join(" · ")}` : "";
}

function isSpend(
	value: unknown,
): value is { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number } {
	if (typeof value !== "object" || value === null) return false;
	const usage = value as Record<string, unknown>;
	return ["input", "output", "cacheRead", "cacheWrite", "cost"].every((key) => isCount(usage[key]));
}

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
