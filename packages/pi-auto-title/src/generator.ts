import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { extractTextFromContent } from "./context.js";

export const TITLE_SYSTEM_PROMPT = `You are a session title generator. Your job is to generate a concise, descriptive title for the conversation based on the user's intent.

RULES:
1. Length: 3 to 6 words (or 8 to 18 Chinese characters).
2. Format: Return ONLY the title text. Do NOT use quotes, prefixes like "Title:", markdown, or ending punctuation.
3. Language: Match the language used by the user (Chinese if user speaks Chinese, English if English).
4. Specificity: Focus on the specific task or topic (e.g. "Fix Redis connection timeout", "Add JWT auth middleware"), avoid generic phrases like "Code discussion" or "Help with issue".`;

const PREFIX_REGEX = /^(title|subject|topic|session|标题|主题|会话)\s*[:：]\s*/i;
const SURROUNDING_QUOTES_REGEX = /^["'“”«»`]+|["'“”«»`]+$/g;
const TRAILING_PUNCTUATION_REGEX = /[.。!！;；,，]+$/;

export function cleanTitle(raw: string, maxLength = 40): string {
	let text = raw.trim();

	// Remove code fences or markdown bold/italic if any
	text = text.replace(/^```[a-z]*\n?|```$/g, "").trim();
	text = text.replace(/[*_#]/g, "");

	// Remove prefixes like "Title:"
	text = text.replace(PREFIX_REGEX, "").trim();

	// Remove quotes
	text = text.replace(SURROUNDING_QUOTES_REGEX, "").trim();

	// Remove any remaining prefix if repeatedly present
	text = text.replace(PREFIX_REGEX, "").trim();
	text = text.replace(SURROUNDING_QUOTES_REGEX, "").trim();

	// Collapse internal whitespace
	text = text.replace(/\s+/g, " ");

	// Remove trailing punctuation
	text = text.replace(TRAILING_PUNCTUATION_REGEX, "").trim();

	if (text.length > maxLength) {
		text = text.slice(0, maxLength).trim();
	}

	return text;
}

export interface ModelCompleter {
	complete(
		model: Model<Api>,
		context: Context,
		options?: { maxTokens?: number; signal?: AbortSignal },
	): Promise<{ role?: string; content?: unknown } | undefined>;
}

export interface GenerateTitleOptions {
	model: Model<Api>;
	completer: ModelCompleter;
	conversationContext: string;
	maxLength?: number;
	signal?: AbortSignal;
}

export async function generateSessionTitle(
	options: GenerateTitleOptions,
): Promise<string | undefined> {
	const { model, completer, conversationContext, maxLength = 40, signal } = options;

	if (!conversationContext.trim()) {
		return undefined;
	}

	try {
		const response = await completer.complete(
			model,
			{
				systemPrompt: TITLE_SYSTEM_PROMPT,
				messages: [
					{
						role: "user",
						content: `Generate a concise title for this session:\n\n${conversationContext}`,
						timestamp: Date.now(),
					},
				],
			},
			{
				maxTokens: 60,
				signal,
			},
		);

		if (!response || signal?.aborted) return undefined;

		const rawContent = response.content;
		const rawText = extractTextFromContent(rawContent);
		if (!rawText) return undefined;

		const cleaned = cleanTitle(rawText, maxLength);
		return cleaned.length > 0 ? cleaned : undefined;
	} catch {
		return undefined;
	}
}
