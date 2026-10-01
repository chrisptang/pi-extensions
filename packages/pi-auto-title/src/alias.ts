import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const MAX_ALIAS_FILE_BYTES = 512 * 1024;
const THINKING_SUFFIX = /:(off|minimal|low|medium|high|xhigh|max)$/;

export interface ModelReference {
	provider: string;
	modelId: string;
}

export function parseModelReference(value: string): ModelReference | undefined {
	const trimmed = value.trim();
	const separator = trimmed.indexOf("/");
	if (separator <= 0 || separator === trimmed.length - 1) return undefined;
	return {
		provider: trimmed.slice(0, separator),
		modelId: trimmed.slice(separator + 1),
	};
}

function stripThinkingSuffix(ref: string): string {
	return ref.replace(THINKING_SUFFIX, "").trim();
}

function normalizeCandidates(entry: unknown): string[] {
	if (typeof entry === "string") return [stripThinkingSuffix(entry)];
	if (Array.isArray(entry)) {
		return entry
			.filter((v): v is string => typeof v === "string")
			.map(stripThinkingSuffix)
			.filter((v) => v.length > 0);
	}
	if (entry && typeof entry === "object") {
		const obj = entry as { model?: unknown; models?: unknown };
		if (typeof obj.model === "string") return [stripThinkingSuffix(obj.model)];
		if (Array.isArray(obj.models)) {
			return obj.models
				.filter((v): v is string => typeof v === "string")
				.map(stripThinkingSuffix)
				.filter((v) => v.length > 0);
		}
	}
	return [];
}

/**
 * Read candidate model references from `~/.pi/agent/model-alias.json` for a given alias name.
 */
export function readAliasCandidates(alias: string, agentDir = getAgentDir()): string[] {
	const file = join(agentDir, "model-alias.json");
	let raw: string;
	try {
		const stat = statSync(file);
		if (stat.size > MAX_ALIAS_FILE_BYTES) return [];
		raw = readFileSync(file, "utf8");
	} catch {
		return [];
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}

	const aliases = (parsed as { aliases?: unknown } | null)?.aliases;
	if (!aliases || typeof aliases !== "object" || Array.isArray(aliases)) return [];

	const wanted = alias.trim().toLowerCase();
	for (const [key, value] of Object.entries(aliases as Record<string, unknown>)) {
		if (key.trim().toLowerCase() === wanted) {
			return normalizeCandidates(value);
		}
	}

	return [];
}

export interface ModelLookup {
	find(provider: string, modelId: string): Model<Api> | undefined;
	hasConfiguredAuth(model: Model<Api>): boolean;
	getAvailable?(): Model<Api>[];
}

export interface ResolveModelOptions {
	requestedModelOrAlias: string;
	modelRegistry: ModelLookup;
	agentDir?: string;
	currentModel?: Model<Api>;
	fallbackToCurrentModel?: boolean;
}

/**
 * Resolves a model for auto-titling:
 * 1. Checks if requestedModelOrAlias is an alias in model-alias.json and resolves to a usable model.
 * 2. Checks if requestedModelOrAlias is an explicit provider/model-id.
 * 3. Fallback ladder:
 *    a. Search modelRegistry for any available model with "haiku" in ID or name.
 *    b. Search modelRegistry for lightweight models (gpt-4o-mini, gemini flash, etc.).
 *    c. Fallback to currentModel if permitted.
 */
export function resolveTitleModel(options: ResolveModelOptions): Model<Api> | undefined {
	const {
		requestedModelOrAlias,
		modelRegistry,
		agentDir = getAgentDir(),
		currentModel,
		fallbackToCurrentModel = true,
	} = options;

	// 1. Check if requestedModelOrAlias is an alias in model-alias.json
	const candidates = readAliasCandidates(requestedModelOrAlias, agentDir);
	for (const candidate of candidates) {
		const parsed = parseModelReference(candidate);
		if (!parsed) continue;
		const model = modelRegistry.find(parsed.provider, parsed.modelId);
		if (model && modelRegistry.hasConfiguredAuth(model)) {
			return model;
		}
	}

	// 2. Check if requestedModelOrAlias is a direct provider/model-id
	const directParsed = parseModelReference(requestedModelOrAlias);
	if (directParsed) {
		const model = modelRegistry.find(directParsed.provider, directParsed.modelId);
		if (model && modelRegistry.hasConfiguredAuth(model)) {
			return model;
		}
	}

	// 3. Fallback ladder across available models
	const available = modelRegistry.getAvailable?.() ?? [];

	// 3a. Search for any available haiku model
	const haikuModel = available.find((m) => {
		const id = m.id.toLowerCase();
		const name = m.name?.toLowerCase() ?? "";
		return (id.includes("haiku") || name.includes("haiku")) && modelRegistry.hasConfiguredAuth(m);
	});
	if (haikuModel) return haikuModel;

	// 3b. Search for other common fast lightweight models
	const lightweightKeywords = ["4o-mini", "flash", "deepseek-chat", "fast"];
	for (const kw of lightweightKeywords) {
		const match = available.find((m) => {
			const id = m.id.toLowerCase();
			const name = m.name?.toLowerCase() ?? "";
			return (id.includes(kw) || name.includes(kw)) && modelRegistry.hasConfiguredAuth(m);
		});
		if (match) return match;
	}

	// 3c. Fallback to session's current model
	if (fallbackToCurrentModel && currentModel && modelRegistry.hasConfiguredAuth(currentModel)) {
		return currentModel;
	}

	return undefined;
}
