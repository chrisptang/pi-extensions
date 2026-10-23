import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export function resolvePrompt(
	cwd: string,
	projectTrusted: boolean,
): { text?: string; errors: string[] } {
	const paths = [join(getAgentDir(), "system-prompts", "handoff.md")];
	if (projectTrusted) paths.unshift(join(cwd, CONFIG_DIR_NAME, "system-prompts", "handoff.md"));
	const errors: string[] = [];
	for (const path of paths) {
		try {
			const text = readFileSync(path, "utf8").trim();
			if (text) return { text, errors };
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") continue;
			errors.push(`Could not read ${path}: ${String(error)}`);
		}
	}
	return { errors };
}
