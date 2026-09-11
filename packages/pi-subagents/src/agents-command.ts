import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { agentDirectories } from "./agent-definitions.js";
import type { AgentRegistry } from "./agent-registry.js";
import { sanitizeTerminalText } from "./message-broker.js";

/**
 * Register `/agents`.
 *
 * The listing is deliberately limited to `~/.pi/agent/agents/`. Definitions that
 * only exist under the fallback directories stay reachable by name but are never
 * advertised, so the command reflects exactly what the session loaded.
 */
export function registerAgentsCommand(pi: ExtensionAPI, agents: AgentRegistry): void {
	pi.registerCommand("agents", {
		description: "List the subagent definitions in ~/.pi/agent/agents/",
		handler: async (_args, ctx) => {
			ctx.ui.notify(sanitizeTerminalText(renderAgentList(agents)));
		},
	});
}

export function renderAgentList(agents: AgentRegistry): string {
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
	const diagnostics = agents.primaryDiagnostics();
	if (diagnostics.length > 0) {
		lines.push("", "Diagnostics:", ...diagnostics.map((line) => `  ${line}`));
	}
	return lines.join("\n");
}
