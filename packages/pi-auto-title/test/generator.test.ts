import assert from "node:assert/strict";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { test } from "vitest";
import { generateSessionTitle, TITLE_SYSTEM_PROMPT } from "../src/generator.js";

test("title requests prioritize the underlying task over vague wording and follow-up steps", async () => {
	const conversationContext = [
		"User (Turn 1): 接入 OPAQUE 无明文登录，补充回归测试和构建指纹校验。",
		"Assistant (Turn 1): 已接入 OPAQUE 登录并补充测试与校验。",
		"User (Turn 2): 提交修复并重发 QA 生产流水线。",
	].join("\n\n");
	let request: Context | undefined;
	const controller = new AbortController();
	const title = await generateSessionTitle({
		model: { provider: "anthropic", id: "haiku" } as Model<Api>,
		conversationContext,
		signal: controller.signal,
		completer: {
			async complete(_model, context, options) {
				request = context;
				assert.equal(options?.signal, controller.signal);
				return { content: [{ type: "text", text: "接入 OPAQUE 无明文登录" }] };
			},
		},
	});

	assert.equal(title, "接入 OPAQUE 无明文登录");
	assert.ok(request);
	assert.equal(request.systemPrompt, TITLE_SYSTEM_PROMPT);
	assert.match(request.systemPrompt, /underlying task across the conversation/);
	assert.match(request.systemPrompt, /do not let a follow-up step replace the core task/);
	assert.match(request.systemPrompt, /优化、提升、完善、增强、改进/);
	assert.match(request.systemPrompt, /Do not invent/);
	assert.ok(request.systemPrompt?.includes("3 to 6 words (or 8 to 18 Chinese characters)"));
	assert.match(request.systemPrompt, /Return ONLY the title text/);
	assert.match(request.systemPrompt, /Match the language used by the user/);
	assert.equal(request.messages.length, 1);
	assert.equal(
		request.messages[0].content,
		`Generate a concise title for this session:\n\n${conversationContext}`,
	);
});
