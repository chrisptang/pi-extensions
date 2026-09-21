import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SkillRegistry } from "./skill-registry.js";
import { sanitizeTerminalText } from "./text.js";
import type { StartSkillJob } from "./tools.js";

const SKILL_COMMAND_PREFIX = "/skill:";

/**
 * Route a user's `/skill:<name>` to a subagent when the skill declares
 * `content: fork`.
 *
 * Pi's `input` event fires before its own skill expansion, so answering
 * `handled` keeps the skill body and every step of its work out of the main
 * session; only the job's completion message comes back, and it triggers a turn
 * so the main agent reports the result. Only user input takes this path: a
 * model that wants a skill in a child calls `skill_run`, and a skill without
 * `content: fork` still expands inline exactly as Pi does by default.
 */
export function registerSkillFork(
	pi: ExtensionAPI,
	skills: SkillRegistry,
	startSkillJob: StartSkillJob,
	validateSkillArgs: (value: string) => string,
): void {
	pi.on("input", async (event, ctx) => {
		const command = parseSkillCommand(event.text);
		if (!command) return { action: "continue" };
		const skill = skills.find(command.name);
		if (!skill?.fork) return { action: "continue" };
		try {
			const started = startSkillJob(skill, ctx, {
				description: `${SKILL_COMMAND_PREFIX}${skill.name}`,
				...(command.args ? { args: validateSkillArgs(command.args) } : {}),
				notifyOnCompletion: true,
			});
			ctx.ui.notify(
				`Skill ${skill.name} is running as subagent job ${started.jobId}; its result arrives when it finishes.`,
			);
		} catch (error) {
			// Falling through would expand the skill inline, the opposite of what the
			// skill asked for, so the failure is reported and the input consumed.
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(
				`Skill ${skill.name} could not start as a subagent: ${sanitizeTerminalText(message)}`,
				"error",
			);
		}
		return { action: "handled" };
	});
}

/** Split `/skill:<name> <args>` the way Pi's own expansion does. */
export function parseSkillCommand(text: string): { name: string; args: string } | undefined {
	if (!text.startsWith(SKILL_COMMAND_PREFIX)) return undefined;
	const spaceIndex = text.indexOf(" ");
	const name =
		spaceIndex === -1
			? text.slice(SKILL_COMMAND_PREFIX.length)
			: text.slice(SKILL_COMMAND_PREFIX.length, spaceIndex);
	const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();
	return name ? { name, args } : undefined;
}
