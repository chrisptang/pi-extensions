import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";

/** One alias entry: a short name pointing at one or more model references. */
export interface AliasDefinition {
	/**
	 * Candidate model references in `provider/modelId` form, where only the first
	 * `/` separates. More than one candidate means the alias picks one at random
	 * among those that currently have credentials.
	 */
	models: string[];
	thinkingLevel?: ThinkingLevel;
}

/** A single entry accepts a reference string, an array of them, or an object form. */
export type AliasInput =
	| string
	| string[]
	| { model?: string; models?: string[]; thinkingLevel?: ThinkingLevel };

export interface AliasFile {
	aliases?: Record<string, AliasInput>;
	/** Per-skill model overrides, keyed by skill name. */
	skills?: Record<string, AliasInput>;
}

export interface ModelReference {
	provider: string;
	modelId: string;
}

/** An alias name, as opposed to a `provider/modelId` reference. */
const ALIAS_NAME = /^[A-Za-z0-9][\w.-]*$/;

const THINKING_LEVELS: readonly string[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

/**
 * Split a `provider/modelId` reference on the first slash only, because model IDs
 * may contain further slashes (e.g. `openrouter/anthropic/claude-sonnet`).
 */
export function parseModelReference(value: string): ModelReference | undefined {
	const trimmed = value.trim();
	const separator = trimmed.indexOf("/");
	if (separator <= 0 || separator === trimmed.length - 1) return undefined;
	return {
		provider: trimmed.slice(0, separator),
		modelId: trimmed.slice(separator + 1),
	};
}

/** Strip a trailing `:level` suffix, mirroring Pi's own `--models` pattern syntax. */
function splitThinkingSuffix(reference: string): { model: string; thinkingLevel?: ThinkingLevel } {
	const lastColon = reference.lastIndexOf(":");
	if (lastColon > 0) {
		const suffix = reference.slice(lastColon + 1);
		if (THINKING_LEVELS.includes(suffix))
			return { model: reference.slice(0, lastColon), thinkingLevel: suffix as ThinkingLevel };
	}
	return { model: reference };
}

function normalizeDefinition(value: AliasInput): AliasDefinition | undefined {
	if (typeof value === "string") {
		const parsed = splitThinkingSuffix(value.trim());
		return { models: [parsed.model], thinkingLevel: parsed.thinkingLevel };
	}

	if (Array.isArray(value)) {
		const models: string[] = [];
		// A per-candidate `:level` suffix would be ambiguous across candidates, so the
		// last one that specifies a level wins and applies to whichever is picked.
		let thinkingLevel: ThinkingLevel | undefined;
		for (const entry of value) {
			if (typeof entry !== "string") return undefined;
			const parsed = splitThinkingSuffix(entry.trim());
			models.push(parsed.model);
			if (parsed.thinkingLevel) thinkingLevel = parsed.thinkingLevel;
		}
		return models.length > 0 ? { models, thinkingLevel } : undefined;
	}

	const level =
		value.thinkingLevel !== undefined && THINKING_LEVELS.includes(value.thinkingLevel)
			? value.thinkingLevel
			: undefined;

	if (Array.isArray(value.models)) {
		const models = value.models.filter((entry): entry is string => typeof entry === "string");
		if (models.length !== value.models.length || models.length === 0) return undefined;
		return { models, thinkingLevel: level };
	}
	if (typeof value.model === "string") {
		// Strip a `:level` suffix here too, so the single-value form matches the string form.
		const parsed = splitThinkingSuffix(value.model.trim());
		return { models: [parsed.model], thinkingLevel: level ?? parsed.thinkingLevel };
	}
	return undefined;
}

export interface LoadedAliases {
	aliases: Map<string, AliasDefinition>;
	skills: Map<string, AliasDefinition>;
}

/** Read and validate the alias file; an unreadable or malformed file yields empty maps. */
export function loadAliases(agentDir: string, warn?: (message: string) => void): LoadedAliases {
	const path = join(agentDir, "model-alias.json");
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return { aliases: new Map(), skills: new Map() };
	}

	let parsed: AliasFile;
	try {
		parsed = JSON.parse(raw) as AliasFile;
	} catch (error: unknown) {
		warn?.(`model-alias: ${path} is not valid JSON (${String(error)}); ignoring it.`);
		return { aliases: new Map(), skills: new Map() };
	}

	/**
	 * `allowAliasTarget` permits a bare alias name as the target, which the skills
	 * map supports so a skill can reuse an alias instead of repeating a reference.
	 */
	const collect = (source: Record<string, AliasInput> | undefined, allowAliasTarget: boolean) => {
		const result = new Map<string, AliasDefinition>();
		for (const [key, value] of Object.entries(source ?? {})) {
			const definition = normalizeDefinition(value);
			if (!definition) {
				warn?.(`model-alias: entry "${key}" is malformed; expected a string, array, or object.`);
				continue;
			}
			// A bare alias name is only meaningful as the sole target, never mixed
			// into a candidate list, so it is accepted only for a single entry.
			const aliasTarget =
				allowAliasTarget &&
				definition.models.length === 1 &&
				ALIAS_NAME.test(definition.models[0]) &&
				parseModelReference(definition.models[0]) === undefined;
			if (aliasTarget) {
				result.set(key, definition);
				continue;
			}
			const invalid = definition.models.filter(
				(reference) => parseModelReference(reference) === undefined,
			);
			if (invalid.length > 0) {
				warn?.(
					`model-alias: entry "${key}" has invalid reference(s) ${invalid.join(", ")}; expected "provider/model-id"${
						allowAliasTarget ? " or an alias name" : ""
					}.`,
				);
				continue;
			}
			result.set(key, definition);
		}
		return result;
	};

	return {
		aliases: collect(parsed.aliases, false),
		skills: collect(parsed.skills, true),
	};
}

export interface ResolveResult {
	model: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	/** Number of candidates that were registered and had credentials. */
	candidateCount: number;
	/** True when the model came from the session's sticky pick rather than a fresh draw. */
	sticky: boolean;
	/** Usable candidates currently sidelined by a rate limit, excluded from the pick. */
	cooledDown: number;
}

export interface ResolveAliasOptions {
	find: (provider: string, modelId: string) => Model<Api> | undefined;
	/** Credential check used to drop unusable candidates before picking. */
	hasAuth?: (model: Model<Api>) => boolean;
	/** Injectable for deterministic tests; defaults to `Math.random`. */
	random?: () => number;
	/** Drops candidates a provider has rate-limited until their cooldown expires. */
	isCoolingDown?: (model: Model<Api>) => boolean;
	/**
	 * The model this alias already settled on in this session. It is reused whenever
	 * it is still usable, so an alias stays on one model instead of redrawing.
	 */
	sticky?: Model<Api>;
}

/**
 * Resolve an alias to one usable model.
 *
 * Candidates are filtered in three stages — registered in Pi, holding credentials,
 * and not currently rate-limited — before a pick is made. A `sticky` model that
 * survives those filters is reused, which keeps an alias on one model for the whole
 * session; otherwise one of the survivors is drawn at random.
 *
 * Cooldown is deliberately the last filter and never empties the pool on its own:
 * when every candidate is sidelined, the least-bad option is still to return one
 * rather than fail the switch, since the limit may have lifted early.
 */
export function resolveAlias(
	definition: AliasDefinition,
	options: ResolveAliasOptions,
): ResolveResult | undefined {
	const { find, hasAuth, random = Math.random, isCoolingDown, sticky } = options;

	const registered: Model<Api>[] = [];
	for (const reference of definition.models) {
		const parsed = parseModelReference(reference);
		if (!parsed) continue;
		const model = find(parsed.provider, parsed.modelId);
		if (model) registered.push(model);
	}
	if (registered.length === 0) return undefined;

	const usable = hasAuth ? registered.filter((model) => hasAuth(model)) : registered;
	// Every candidate lacking credentials is a real failure; report it rather than
	// switching to a model that cannot serve a request.
	if (usable.length === 0) return undefined;

	const available = isCoolingDown ? usable.filter((model) => !isCoolingDown(model)) : usable;
	// All candidates sidelined: fall back to the full set rather than refusing to
	// switch, and let the provider decide whether the limit has actually cleared.
	const pool = available.length > 0 ? available : usable;
	const cooledDown = usable.length - available.length;

	const held =
		sticky && pool.find((model) => model.provider === sticky.provider && model.id === sticky.id);
	const picked = held ?? pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];

	return {
		model: picked,
		thinkingLevel: definition.thinkingLevel,
		candidateCount: usable.length,
		sticky: held !== undefined,
		cooledDown,
	};
}
