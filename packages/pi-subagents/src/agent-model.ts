import * as fs from "node:fs";
import * as path from "node:path";
import { piAgentDirectory } from "./agent-definitions.js";

/**
 * Model resolution for agent definitions.
 *
 * Children spawn with `--no-extensions`, so the pi-model-alias extension is not
 * loaded inside them and cannot expand an alias there. The parent therefore
 * resolves an agent's `model` down to a concrete `provider/modelId` before spawn.
 * The alias file is read directly rather than importing pi-model-alias, which
 * keeps the two extensions independently installable.
 */

const MAX_ALIAS_FILE_BYTES = 256 * 1024;

export interface ModelCandidateLookup {
	/** Whether `provider/modelId` is registered and usable for a child process. */
	isUsable(provider: string, modelId: string): boolean;
}

export interface ResolveAgentModelResult {
	/** Concrete `provider/modelId`, or undefined to keep the main agent's model. */
	model?: string;
	/** Human-readable note when the requested model could not be honoured. */
	limitation?: string;
}

/** Split on the first slash only; model IDs may contain further slashes. */
export function parseModelReference(
	value: string,
): { provider: string; modelId: string } | undefined {
	const trimmed = value.trim();
	const separator = trimmed.indexOf("/");
	if (separator <= 0 || separator === trimmed.length - 1) return undefined;
	return { provider: trimmed.slice(0, separator), modelId: trimmed.slice(separator + 1) };
}

/**
 * `model: inherit` states explicitly what omitting the field does implicitly:
 * keep the main agent's model. Claude Code spells it this way, so definitions
 * written for either harness resolve the same.
 */
export function isInheritedModel(value: string | undefined): boolean {
	return value?.trim().toLowerCase() === "inherit";
}

/**
 * Resolve an agent's declared model to a concrete reference.
 *
 * Falls back to the main agent's model whenever the request cannot be satisfied,
 * so a missing alias degrades the job instead of failing it.
 */
export function resolveAgentModel(
	requested: string | undefined,
	lookup: ModelCandidateLookup,
	options: { aliasDirectory?: string; random?: () => number } = {},
): ResolveAgentModelResult {
	// Inheritance is the intended outcome, not a failed lookup, so it reports no
	// limitation the way an undefined alias would.
	if (!requested || isInheritedModel(requested)) return {};

	const direct = parseModelReference(requested);
	if (direct) {
		if (lookup.isUsable(direct.provider, direct.modelId)) return { model: requested };
		return {
			limitation: `Agent model ${requested} is unavailable; the main agent's model was used instead.`,
		};
	}

	const candidates = readAliasCandidates(requested, options.aliasDirectory);
	if (candidates.length === 0) {
		return {
			limitation: `Agent model alias "${requested}" is not defined in model-alias.json; the main agent's model was used instead.`,
		};
	}

	const usable = candidates.filter((candidate) => {
		const parsed = parseModelReference(candidate);
		return parsed ? lookup.isUsable(parsed.provider, parsed.modelId) : false;
	});
	if (usable.length === 0) {
		return {
			limitation: `No candidate of model alias "${requested}" is registered with usable credentials; the main agent's model was used instead.`,
		};
	}

	const random = options.random ?? Math.random;
	const picked = usable[Math.min(usable.length - 1, Math.floor(random() * usable.length))];
	return { model: picked };
}

/**
 * Read one alias's candidates from `model-alias.json`, mirroring the shapes that
 * pi-model-alias accepts: a string, an array of strings, or `{ model | models }`.
 */
function readAliasCandidates(alias: string, aliasDirectory?: string): string[] {
	const file = path.join(aliasDirectory ?? piAgentDirectory(), "model-alias.json");
	let raw: string;
	try {
		const stats = fs.statSync(file);
		if (stats.size > MAX_ALIAS_FILE_BYTES) return [];
		raw = fs.readFileSync(file, "utf8");
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
	if (!aliases || typeof aliases !== "object") return [];

	// Alias names are matched case-insensitively, like agent names.
	const wanted = alias.trim().toLowerCase();
	const entry = Object.entries(aliases as Record<string, unknown>).find(
		([key]) => key.trim().toLowerCase() === wanted,
	)?.[1];
	return normalizeCandidates(entry);
}

function normalizeCandidates(entry: unknown): string[] {
	if (typeof entry === "string") return stripLevels([entry]);
	if (Array.isArray(entry)) {
		return stripLevels(entry.filter((value): value is string => typeof value === "string"));
	}
	if (entry && typeof entry === "object") {
		const record = entry as { model?: unknown; models?: unknown };
		if (typeof record.model === "string") return stripLevels([record.model]);
		if (Array.isArray(record.models)) {
			return stripLevels(record.models.filter((v): v is string => typeof v === "string"));
		}
	}
	return [];
}

const THINKING_SUFFIX = /:(off|minimal|low|medium|high|xhigh|max)$/;

/** Drop pi-model-alias's optional `:level` suffix; thinking level comes from the agent file. */
function stripLevels(values: string[]): string[] {
	const candidates: string[] = [];
	for (const value of values) {
		const trimmed = value.trim().replace(THINKING_SUFFIX, "");
		if (trimmed && !candidates.includes(trimmed)) candidates.push(trimmed);
	}
	return candidates;
}
