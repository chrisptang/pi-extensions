import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sanitizeTerminalText } from "./message-broker.js";
import type { SkillRegistry } from "./skill-registry.js";

/**
 * Register `/skills`.
 *
 * The listing covers the primary tier only, matching the roster `skill_run`
 * advertises. Skills in the Claude and shared directories stay reachable by
 * name but are never listed, so the command reflects what the model can see.
 */
export function registerSkillsCommand(pi: ExtensionAPI, skills: SkillRegistry): void {
	pi.registerCommand("skills", {
		description: "List the skills skill_run advertises",
		handler: async (_args, ctx) => {
			ctx.ui.notify(sanitizeTerminalText(renderSkillList(skills)));
		},
	});
}

export function renderSkillList(skills: SkillRegistry): string {
	const definitions = skills.listPrimary();
	const lines: string[] = [];
	if (definitions.length === 0) {
		lines.push("No skills are advertised to skill_run.");
	} else {
		lines.push("Skills available to skill_run:", "");
		const width = Math.max(...definitions.map((definition) => definition.name.length));
		for (const definition of definitions) {
			lines.push(`  ${definition.name.padEnd(width)}  ${definition.description}`);
		}
	}
	const diagnostics = skills.primaryDiagnostics();
	if (diagnostics.length > 0) {
		lines.push("", "Diagnostics:", ...diagnostics.map((line) => `  ${line}`));
	}
	return lines.join("\n");
}
