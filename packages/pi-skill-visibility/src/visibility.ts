import { homedir } from "node:os";
import { join } from "node:path";
import { type ExtensionAPI, getAgentDir, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { Markdown } from "@earendil-works/pi-tui";
import { analyzeSessions, parseDays } from "./analysis.js";
import { formatReport } from "./report.js";
import { loadExclusionSettings } from "./settings.js";

const REPORT_TYPE = "skill-visibility-analysis";

export default async function skillVisibility(pi: ExtensionAPI): Promise<void> {
	let excluded = new Set<string>();
	let configurationWarning: string | undefined;
	let running: AbortController | undefined;
	let sessionGeneration = 0;

	pi.on("session_start", async (_event, ctx) => {
		running?.abort();
		running = undefined;
		const generation = ++sessionGeneration;
		const settings = await loadExclusionSettings();
		if (generation !== sessionGeneration) return;
		excluded = settings.excluded;
		configurationWarning = settings.warning;
		if (configurationWarning) notify(ctx, configurationWarning, "warning");
		if (ctx.mode === "tui") {
			ctx.ui.addAutocompleteProvider((current) => filterAutocomplete(current, excluded));
		}
	});

	pi.on("before_agent_start", (event) => ({
		systemPrompt: filterSkillCatalog(event.systemPrompt, excluded),
	}));

	pi.on("session_shutdown", () => {
		sessionGeneration++;
		running?.abort();
		running = undefined;
	});

	pi.registerEntryRenderer<{ markdown: string }>(
		REPORT_TYPE,
		(entry) => new Markdown(entry.data?.markdown ?? "", 0, 0, getMarkdownTheme()),
	);

	pi.registerCommand("skills-analysis", {
		description: "Analyze local Claude Code/Pi skill-use evidence from the last N days",
		handler: async (args, ctx) => {
			if (running) {
				notify(ctx, "A skills analysis is already running. Wait for it to finish.", "error");
				return;
			}
			const generation = sessionGeneration;
			try {
				const days = parseDays(args);
				const controller = new AbortController();
				running = controller;
				notify(ctx, `Scanning local Claude Code and Pi sessions from the last ${days} days…`);
				const agentDir = getAgentDir();
				const result = await analyzeSessions({
					days,
					skills: ctx.getSystemPromptOptions().skills ?? [],
					excluded,
					roots: [
						{
							source: "pi",
							root: process.env.PI_CODING_AGENT_SESSION_DIR || join(agentDir, "sessions"),
						},
						{
							source: "claude",
							root: join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects"),
						},
					],
					signal: controller.signal,
				});
				if (controller.signal.aborted || generation !== sessionGeneration) return;
				const markdown = formatReport(result);
				pi.appendEntry(REPORT_TYPE, { markdown });
				if (ctx.mode !== "tui") {
					if (ctx.hasUI) ctx.ui.notify(markdown, "info");
					else console.log(markdown);
				}
			} catch (error) {
				if (!running?.signal.aborted && generation === sessionGeneration) {
					notify(ctx, error instanceof Error ? error.message : String(error), "error");
				}
			} finally {
				if (generation === sessionGeneration) running = undefined;
			}
		},
	});
}

function notify(
	ctx: {
		hasUI: boolean;
		ui: { notify(message: string, level: "info" | "warning" | "error"): void };
	},
	message: string,
	level: "info" | "warning" | "error" = "info",
): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
	else console.error(message);
}

/** Edit only automatic XML catalog entries, preserving other extensions' prompt changes. */
export function filterSkillCatalog(prompt: string, excluded: ReadonlySet<string>): string {
	if (excluded.size === 0) return prompt;
	return prompt.replace(/<available_skills>[\s\S]*?<\/available_skills>/g, (catalog) =>
		catalog.replace(/[ \t]*<skill>[\s\S]*?<\/skill>\n?/g, (entry) => {
			const name = /<name>([\s\S]*?)<\/name>/.exec(entry)?.[1];
			return name !== undefined && excluded.has(decodeXml(name)) ? "" : entry;
		}),
	);
}

/** Delegate completion semantics; remove only exact `/skill:<name>` values. */
export function filterAutocomplete(
	current: AutocompleteProvider,
	excluded: ReadonlySet<string>,
): AutocompleteProvider {
	return {
		triggerCharacters: current.triggerCharacters,
		async getSuggestions(...args) {
			const result = await current.getSuggestions(...args);
			if (!result) return result;
			const items = result.items.filter((item) => {
				const value = item.value.replace(/^\//, "");
				return !value.startsWith("skill:") || !excluded.has(value.slice(6));
			});
			return items.length ? { ...result, items } : null;
		},
		applyCompletion(...args) {
			return current.applyCompletion.call(current, ...args);
		},
		shouldTriggerFileCompletion(...args) {
			return current.shouldTriggerFileCompletion?.call(current, ...args) ?? true;
		},
	};
}

function decodeXml(text: string): string {
	const entities: Record<string, string> = {
		"&amp;": "&",
		"&lt;": "<",
		"&gt;": ">",
		"&quot;": '"',
		"&apos;": "'",
	};
	return text.replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => entities[entity] ?? entity);
}
