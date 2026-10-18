import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { extractTextFromContent } from "./context.js";

export const TITLE_SYSTEM_PROMPT = `You generate session titles that let the user recognize the core task at a glance. Identify the user's underlying task across the conversation, not just the latest instruction or the assistant's activity report.

RULES:
1. Content: Name the concrete task or question and its distinguishing object, problem, or change. Prefer "action + specific object/problem"; preserve meaningful feature, component, protocol, or error names. Use assistant replies only to clarify what the user is asking for.
2. Task priority: Committing, testing, deploying, retrying pipelines, and reporting status are often supporting steps; do not let a follow-up step replace the core task. Name these actions when they ARE the user's main task.
3. Concrete wording: Do not use vague improvement or quality claims such as 优化、提升、完善、增强、改进 or optimize, improve, enhance, better. State what actually changes or what is being investigated instead. Avoid generic labels such as "Code discussion", "Issue handling", or "方案优化".
4. Evidence: Do not invent a cause, solution, implementation detail, or successful outcome. If the context is vague, name only the known subject or goal rather than inventing specifics.
5. Length: 3 to 6 words (or 8 to 18 Chinese characters). Keep distinguishing task details rather than filling space with generic words.
6. Format: Return ONLY the title text. Do NOT use quotes, prefixes like "Title:", markdown, or ending punctuation.
7. Language: Match the language used by the user (Chinese if user speaks Chinese, English if English).

EXAMPLES (use the concrete details only when supported by the conversation):
- "优化登录体验" when the task is adding OPAQUE login -> "接入 OPAQUE 无明文登录"
- "提交修复并重发 QA 生产流水线" after implementing OPAQUE login -> "接入 OPAQUE 无明文登录"
- "提升数据库性能" when the task is diagnosing slow order queries -> "排查订单查询慢 SQL"
- "Improve Redis reliability" when the task is fixing connection timeouts -> "Fix Redis connection timeout"
- A session solely about retrying a failed QA deployment -> "重新触发 QA 部署流水线"
- "优化数据库" with no further detail -> "数据库性能"`;

const PREFIX_REGEX = /^(title|subject|topic|session|标题|主题|会话)\s*[:：]\s*/i;
// Edge characters models like to wrap or leak around titles: quotes plus
// ASCII and CJK brackets (e.g. a stray "】【" left by bracket-quoted drafts).
const SURROUNDING_MARKS_REGEX =
	/^["'“”«»`「」『』【】〈〉《》〔〕〖〗()[\]（）［］]+|["'“”«»`「」『』【】〈〉《》〔〕〖〗()[\]（）［］]+$/g;
const TRAILING_PUNCTUATION_REGEX = /[.。!！;；,，]+$/;

export function cleanTitle(raw: string, maxLength = 40): string {
	let text = raw.trim();

	// Remove code fences or markdown bold/italic if any
	text = text.replace(/^```[a-z]*\n?|```$/g, "").trim();
	text = text.replace(/[*_#]/g, "");

	// Remove prefixes like "Title:"
	text = text.replace(PREFIX_REGEX, "").trim();

	// Remove quotes and surrounding brackets
	text = text.replace(SURROUNDING_MARKS_REGEX, "").trim();

	// Remove any remaining prefix if repeatedly present
	text = text.replace(PREFIX_REGEX, "").trim();
	text = text.replace(SURROUNDING_MARKS_REGEX, "").trim();

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
	systemPrompt?: string;
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
				systemPrompt: options.systemPrompt?.trim() || TITLE_SYSTEM_PROMPT,
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
