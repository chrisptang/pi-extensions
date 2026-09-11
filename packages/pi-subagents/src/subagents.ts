import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AgentRegistry } from "./agent-registry.js";
import { registerAgentsCommand } from "./agents-command.js";
import { seedBuiltinAgents } from "./builtin-agents.js";
import { registerCompletionRenderer } from "./completion-renderer.js";
import { registerSkillsCommand } from "./skills-command.js";
import { registerSubagentTools, type SubagentToolsDependencies } from "./tools.js";
import { createSubagentWidgetController } from "./widget.js";

export interface SubagentsDependencies extends SubagentToolsDependencies {
	/** Injectable for tests; defaults to writing the built-ins into the Pi agent directory. */
	seedAgents?: () => void;
}

export default function subagents(
	pi: ExtensionAPI,
	dependencies: SubagentsDependencies = {},
): void {
	// Seed before the first scan so a fresh install already advertises the built-ins.
	(dependencies.seedAgents ?? (() => void seedBuiltinAgents()))();
	const agents = dependencies.agents ?? new AgentRegistry();

	registerCompletionRenderer(pi);
	const tools = registerSubagentTools(pi, { ...dependencies, agents });
	registerAgentsCommand(pi, agents);
	registerSkillsCommand(pi, tools.skills);
	const widget = createSubagentWidgetController(tools.runtime);
	let activeSession: ExtensionContext["sessionManager"] | undefined;
	let sessionGeneration = 0;

	pi.on("session_start", async (_event, ctx) => {
		activeSession = ctx.sessionManager;
		const generation = ++sessionGeneration;
		// Definitions may have changed on disk between sessions.
		agents.reset();
		// Skills are cwd-sensitive, so the scan is rebound to the session directory.
		tools.skills.reset(ctx.cwd);
		await tools.startSession();
		if (generation !== sessionGeneration) return;
		widget.start(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.sessionManager !== activeSession) return;
		sessionGeneration++;
		activeSession = undefined;
		widget.shutdown(ctx);
		await tools.shutdown();
	});
}
