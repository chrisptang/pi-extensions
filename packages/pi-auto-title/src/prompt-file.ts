import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export function resolveTitlePrompt(options: {
	cwd: string;
	projectTrusted: boolean;
	agentDir?: string;
	warn?: (message: string) => void;
}): string | undefined {
	const paths = options.projectTrusted
		? [join(options.cwd, CONFIG_DIR_NAME, "system-prompts", "auto-title.md")]
		: [];
	paths.push(join(options.agentDir ?? getAgentDir(), "system-prompts", "auto-title.md"));

	for (const path of paths) {
		try {
			const text = readFileSync(path, "utf8").trim();
			if (text) return text;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ENOTDIR") {
				options.warn?.(`auto-title: Could not read ${path}: ${String(error)}`);
			}
		}
	}
	return undefined;
}
