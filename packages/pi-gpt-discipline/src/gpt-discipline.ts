/**
 * Targets GPT-series models with strict behavioral discipline while keeping AGENTS.md clean.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GPT_DISCIPLINE_RULES, resolvePrompt } from "./prompt-file.js";

export { GPT_DISCIPLINE_RULES };

export const SECTION_NAME = "gpt_discipline";

/**
 * Determine whether a given model identifier represents a GPT-family model.
 */
export function isGptModel(modelId?: string): boolean {
	if (!modelId) return false;
	const normalized = modelId.toLowerCase();
	return normalized.includes("gpt") || normalized.startsWith("omen");
}

export default function gptDiscipline(pi: ExtensionAPI): void {
	let rules = GPT_DISCIPLINE_RULES;
	pi.on("session_start", (_event, ctx) => {
		const resolution = resolvePrompt({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
		rules = resolution.text;
		for (const error of resolution.errors) {
			if (ctx.hasUI) ctx.ui.notify(error, "warning");
			else console.error(error);
		}
	});

	pi.on("before_agent_start", (event, ctx) => {
		const enabled = isGptModel(ctx.model?.id);
		if (enabled) {
			if (!event.systemPromptOptions.sections) {
				event.systemPromptOptions.sections = {};
			}
			event.systemPromptOptions.sections[SECTION_NAME] = rules;
		} else if (event.systemPromptOptions.sections) {
			delete event.systemPromptOptions.sections[SECTION_NAME];
		}

		// Pi ignores structured sections when an earlier hook has forced the complete prompt.
		const forced = event.systemPromptOptions.forceSystemPrompt;
		if (forced !== undefined) {
			const block = `\n\n<${SECTION_NAME}>\n${rules}\n</${SECTION_NAME}>`;
			const prompt = forced.replace(/\n\n<gpt_discipline>\n[\s\S]*?\n<\/gpt_discipline>/g, "");
			event.systemPromptOptions.forceSystemPrompt = enabled ? prompt + block : prompt;
		}
	});
}
