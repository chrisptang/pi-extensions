import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AgentRegistry } from "./agent-registry.js";
import { registerAgentsCommand } from "./agents-command.js";
import { type SeedResult, seedBuiltinAgents } from "./builtin-agents.js";
import { registerCompletionRenderer } from "./completion-renderer.js";
import { loadInstructionOverrides } from "./instruction-overrides.js";
import { registerSubagentsPanelCommand } from "./panel.js";
import type { SubagentRuntime } from "./runtime.js";
import { registerSkillsCommand } from "./skills-command.js";
import { registerSubagentTools, type SubagentToolsDependencies } from "./tools.js";
import { createSubagentWidgetController } from "./widget.js";

export interface SubagentsDependencies extends SubagentToolsDependencies {
	/** Injectable for tests; defaults to writing the built-ins into the Pi agent directory. */
	seedAgents?: () => SeedResult | undefined;
	/** Observer for the constructed runtime, so a test can drive it directly. */
	onRuntime?: (runtime: SubagentRuntime) => void;
}

export default function subagents(
	pi: ExtensionAPI,
	dependencies: SubagentsDependencies = {},
): void {
	// Seed before the first scan so a fresh install already advertises the built-ins.
	const seeded = (dependencies.seedAgents ?? seedBuiltinAgents)();
	const agents = dependencies.agents ?? new AgentRegistry();
	// A replaced built-in is reported through `/agents` rather than passing silently.
	if (seeded) agents.noteSeed(seeded.diagnostics);

	registerCompletionRenderer(pi);
	// Loaded once and shared, so `/agents` reports exactly the text the tools got.
	const instructions = dependencies.instructions ?? loadInstructionOverrides();
	const tools = registerSubagentTools(pi, { ...dependencies, agents, instructions });
	dependencies.onRuntime?.(tools.runtime);
	registerAgentsCommand(pi, agents, instructions);
	registerSkillsCommand(pi, tools.skills);
	const panel = registerSubagentsPanelCommand(tools.runtime);
	pi.registerCommand(panel.name, panel.options);
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
