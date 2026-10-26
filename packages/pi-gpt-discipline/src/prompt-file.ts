import fs from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export const GPT_DISCIPLINE_RULES = fs
	.readFileSync(new URL("../system-prompts/gpt-discipline.md", import.meta.url), "utf8")
	.trim();

export function resolvePrompt(options: {
	cwd: string;
	projectTrusted: boolean;
	agentDir?: string;
}): { text: string; errors: string[] } {
	const candidates = [
		{
			scope: "user",
			path: join(options.agentDir ?? getAgentDir(), "system-prompts", "gpt-discipline.md"),
		},
	];
	if (options.projectTrusted) {
		candidates.push({
			scope: "project",
			path: join(options.cwd, CONFIG_DIR_NAME, "system-prompts", "gpt-discipline.md"),
		});
	}
	const errors: string[] = [];
	for (const candidate of candidates) {
		try {
			const text = fs.readFileSync(candidate.path, "utf8").trim();
			if (text) return { text, errors };
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ENOTDIR" && code !== "EISDIR") {
				errors.push(
					`Could not read the ${candidate.scope} GPT discipline prompt (${code ?? "unknown error"}); trying the next source.`,
				);
			}
		}
	}
	return { text: GPT_DISCIPLINE_RULES, errors };
}
