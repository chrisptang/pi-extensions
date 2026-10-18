import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";

export interface CompactTurn {
	userText: string;
	assistantText: string;
}

export function extractTextFromContent(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (Array.isArray(content)) {
		const parts: string[] = [];
		for (const part of content) {
			if (
				part &&
				typeof part === "object" &&
				"type" in part &&
				part.type === "text" &&
				"text" in part
			) {
				parts.push(String(part.text));
			}
		}
		return parts.join("\n").trim();
	}
	return "";
}

export function extractMessageText(message: AgentMessage): string {
	if ("content" in message && message.content !== undefined) {
		return extractTextFromContent(message.content);
	}
	return "";
}

/**
 * Groups session message entries into rounds of User -> Assistant interactions.
 */
export function extractCompactTurns(entries: readonly SessionEntry[]): CompactTurn[] {
	const turns: CompactTurn[] = [];
	let currentUserText = "";
	let currentAssistantParts: string[] = [];

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const msgEntry = entry as SessionMessageEntry;
		const msg = msgEntry.message;

		if (msg.role === "user") {
			// If we already had an active user turn, finish it before starting the next
			if (currentUserText.length > 0) {
				turns.push({
					userText: currentUserText,
					assistantText: currentAssistantParts.join(" ").trim(),
				});
				currentAssistantParts = [];
			}
			currentUserText = extractMessageText(msg);
		} else if (msg.role === "assistant") {
			const text = extractMessageText(msg);
			if (text.length > 0) {
				currentAssistantParts.push(text);
			}
		}
	}

	if (currentUserText.length > 0) {
		turns.push({
			userText: currentUserText,
			assistantText: currentAssistantParts.join(" ").trim(),
		});
	}

	return turns;
}

export interface FormatContextOptions {
	maxTurns?: number;
}

/**
 * Builds a compact summary string of the first 1-2 turns for title generation.
 */
export function buildTitleGenerationContext(
	entries: readonly SessionEntry[],
	options: FormatContextOptions = {},
): string {
	const { maxTurns = 2 } = options;

	const turns = extractCompactTurns(entries).slice(0, maxTurns);
	if (turns.length === 0) return "";

	const lines: string[] = [];

	turns.forEach((turn, idx) => {
		const turnNum = idx + 1;

		const userSnippet =
			turn.userText.length > 500 ? `${turn.userText.slice(0, 500)}...` : turn.userText;

		if (userSnippet) {
			lines.push(`User (Turn ${turnNum}): ${userSnippet}`);
		}

		const assistantSnippet =
			turn.assistantText.length > 500
				? `${turn.assistantText.slice(0, 500)}...`
				: turn.assistantText;

		if (assistantSnippet) {
			lines.push(`Assistant (Turn ${turnNum}): ${assistantSnippet}`);
		}
	});

	return lines.join("\n\n");
}
