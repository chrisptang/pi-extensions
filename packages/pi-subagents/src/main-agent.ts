import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AgentDefinition, piAgentDirectory } from "./agent-definitions.js";
import {
	type ModelCandidateLookup,
	parseModelReference,
	resolveAgentModel,
} from "./agent-model.js";
import type { AgentRegistry } from "./agent-registry.js";

/**
 * Running the main session as an agent definition.
 *
 * A definition with `role: main` describes this session rather than a child.
 * Its body is appended to the system prompt on every turn, and its `model` and
 * `thinkingLevel` are applied when a fresh session starts. Which definition is
 * used comes from `--agent <name>` first and the `mainAgent` key of
 * `~/.pi/agent/subagents.json` second; `--agent none` starts plain.
 */

export const MAIN_AGENT_FLAG = "agent";
/** Flag value that starts without a main agent even when the settings file names one. */
export const NO_MAIN_AGENT = "none";
const MAX_SETTINGS_BYTES = 64 * 1024;

export interface MainAgentSettings {
	mainAgent?: string;
	source: string;
	diagnostics: string[];
}

export function settingsFilePath(): string {
	return path.join(piAgentDirectory(), "subagents.json");
}

/** Read `mainAgent` from the settings file; a missing file is the normal case. */
export function loadMainAgentSettings(file: string = settingsFilePath()): MainAgentSettings {
	let raw: string;
	try {
		if (fs.statSync(file).size > MAX_SETTINGS_BYTES) {
			return {
				source: file,
				diagnostics: [`Settings file ${file} exceeds ${MAX_SETTINGS_BYTES} bytes; it is ignored.`],
			};
		}
		raw = fs.readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return { source: file, diagnostics: [] };
		return {
			source: file,
			diagnostics: [`Cannot read settings file ${file}: ${errorText(error)}`],
		};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return {
			source: file,
			diagnostics: [`Settings file ${file} is not valid JSON: ${errorText(error)}`],
		};
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { source: file, diagnostics: [`Settings file ${file} must contain a JSON object.`] };
	}
	const value = (parsed as { mainAgent?: unknown }).mainAgent;
	if (value === undefined || value === null) return { source: file, diagnostics: [] };
	if (typeof value !== "string" || !value.trim()) {
		return {
			source: file,
			diagnostics: [`Settings file ${file} has an invalid mainAgent; expected an agent name.`],
		};
	}
	return { mainAgent: value.trim(), source: file, diagnostics: [] };
}

export interface MainAgentDependencies {
	/** Injectable for tests; defaults to reading the user's settings file. */
	settings?: MainAgentSettings;
	/** Injectable for tests; defaults to the parent's model registry. */
	modelLookup?: (ctx: ExtensionContext) => ModelCandidateLookup;
}

export interface MainAgentController {
	/** The definition this session runs as, once a session has started. */
	current(): AgentDefinition | undefined;
	/** Human-readable status for `/agents`. */
	statusLines(): string[];
	/** Settings and resolution problems, for the `/agents` diagnostics block. */
	diagnostics(): string[];
}

export function registerMainAgent(
	pi: ExtensionAPI,
	agents: AgentRegistry,
	dependencies: MainAgentDependencies = {},
): MainAgentController {
	const settings = dependencies.settings ?? loadMainAgentSettings();
	const lookup = dependencies.modelLookup ?? registryLookup;
	let current: AgentDefinition | undefined;
	// Resolved on each session start, after the registry has rescanned the disk, so
	// a definition edited between sessions is picked up and a bad name is reported
	// once per session rather than retried on every turn.
	let resolved = false;
	let diagnostics: string[] = [];

	pi.registerFlag(MAIN_AGENT_FLAG, {
		type: "string",
		description:
			"Run this session as an agent definition with role: main; its body joins the system prompt. Overrides mainAgent in ~/.pi/agent/subagents.json; 'none' starts without one.",
	});

	const requestedName = (): string | undefined => {
		const flag = pi.getFlag(MAIN_AGENT_FLAG);
		if (typeof flag === "string" && flag.trim()) return flag.trim();
		return settings.mainAgent;
	};

	const resolve = (): AgentDefinition | undefined => {
		resolved = true;
		current = undefined;
		diagnostics = [...settings.diagnostics];
		const name = requestedName();
		if (!name || name.toLowerCase() === NO_MAIN_AGENT) return undefined;
		const definition = agents.find(name);
		if (!definition) {
			diagnostics.push(
				`Main agent "${name}" is not defined in any agent directory; running without one.`,
			);
			return undefined;
		}
		if (definition.role !== "main") {
			diagnostics.push(
				`Main agent "${definition.name}" is a subagent definition (${definition.source}); add role: main to run it as the main session.`,
			);
			return undefined;
		}
		current = definition;
		return current;
	};

	pi.on("session_start", async (event, ctx) => {
		const definition = resolve();
		// A session start is rare enough that every problem is worth a warning.
		for (const line of diagnostics) ctx.ui.notify(line, "warning");
		if (!definition) return;
		// A resumed or forked session restores its model from the transcript; only
		// a fresh session takes the definition's defaults.
		if (event.reason !== "startup" && event.reason !== "new") return;
		await applyModel(pi, ctx, definition, lookup(ctx));
		if (definition.thinkingLevel) pi.setThinkingLevel(definition.thinkingLevel);
	});

	// Appended every turn rather than once, so the persona survives compaction and
	// any other extension's replacement of the prompt.
	pi.on("before_agent_start", (event) => {
		const definition = resolved ? current : resolve();
		if (!definition) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${definition.body}` };
	});

	return {
		current: () => current,
		statusLines: () => {
			const lines: string[] = [];
			if (!resolved) {
				lines.push("Main agent: not resolved until the session starts.");
			} else if (current) {
				lines.push(`Main agent: ${current.name} (${current.source}).`);
			} else {
				lines.push(
					`Main agent: none (set mainAgent in ${settings.source} or pass --agent <name>).`,
				);
			}
			return lines;
		},
		diagnostics: () => [...diagnostics],
	};
}

async function applyModel(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	definition: AgentDefinition,
	lookup: ModelCandidateLookup,
): Promise<void> {
	const selected = resolveAgentModel(definition.model, lookup);
	if (selected.limitation) {
		ctx.ui.notify(selected.limitation, "warning");
		return;
	}
	if (!selected.model) return;
	const reference = parseModelReference(selected.model);
	const model = reference
		? ctx.modelRegistry.find(reference.provider, reference.modelId)
		: undefined;
	if (!model) return;
	if (!(await pi.setModel(model))) {
		ctx.ui.notify(
			`No usable credentials for ${selected.model}; keeping the current model.`,
			"warning",
		);
	}
}

/** The main session is the parent, so any registered model with credentials is usable. */
function registryLookup(ctx: ExtensionContext): ModelCandidateLookup {
	return {
		isUsable(provider, modelId) {
			const model = ctx.modelRegistry.find(provider, modelId);
			return model !== undefined && ctx.modelRegistry.hasConfiguredAuth(model);
		},
	};
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
