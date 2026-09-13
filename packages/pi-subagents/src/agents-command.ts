import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { agentDirectories } from "./agent-definitions.js";
import type { AgentRegistry } from "./agent-registry.js";
import {
	emptyOverrides,
	type InstructionOverrides,
	instructionFilePath,
} from "./instruction-overrides.js";
import { sanitizeTerminalText } from "./text.js";

/**
 * Register `/agents`.
 *
 * The listing is deliberately limited to `~/.pi/agent/agents/`. Definitions that
 * only exist under the fallback directories stay reachable by name but are never
 * advertised, so the command reflects exactly what the session loaded.
 *
 * It also reports the tool-instruction override, because a file that failed to
 * parse would otherwise be invisible: the tools keep working on their built-in
 * text and the user sees no sign their edit was ignored.
 */
export function registerAgentsCommand(
	pi: ExtensionAPI,
	agents: AgentRegistry,
	instructions: InstructionOverrides = emptyOverrides(),
): void {
	pi.registerCommand("agents", {
		description: "List the subagent definitions in ~/.pi/agent/agents/",
		handler: async (_args, ctx) => {
			ctx.ui.notify(sanitizeTerminalText(renderAgentList(agents, instructions)));
		},
	});
}

export function renderAgentList(
	agents: AgentRegistry,
	instructions: InstructionOverrides = emptyOverrides(),
): string {
	const directory = agentDirectories()[0].directory;
	const definitions = agents.listPrimary();
	const lines: string[] = [];
	if (definitions.length === 0) {
		lines.push(`No agent definitions in ${directory}.`);
	} else {
		lines.push(`Agents in ${directory}:`, "");
		const width = Math.max(...definitions.map((definition) => definition.name.length));
		for (const definition of definitions) {
			lines.push(`  ${definition.name.padEnd(width)}  ${definition.description}`);
		}
	}
	lines.push("", ...renderInstructionStatus(instructions));
	const diagnostics = [...agents.primaryDiagnostics(), ...instructions.diagnostics];
	if (diagnostics.length > 0) {
		lines.push("", "Diagnostics:", ...diagnostics.map((line) => `  ${line}`));
	}
	return lines.join("\n");
}

function renderInstructionStatus(instructions: InstructionOverrides): string[] {
	const file = instructions.source ?? instructionFilePath();
	const overridden = [...instructions.tools.keys()].sort();
	if (overridden.length === 0) {
		return [`Tool instructions: built-in (no overrides in ${file}).`];
	}
	return [`Tool instructions overridden from ${file}:`, ...overridden.map((name) => `  ${name}`)];
}
