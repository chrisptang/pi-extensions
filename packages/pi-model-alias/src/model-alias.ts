import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { type AliasDefinition, type LoadedAliases, loadAliases, resolveAlias } from "./aliases.js";
import { readCliModelArgument } from "./cli-model.js";
import { CooldownRegistry } from "./cooldown.js";

interface RestorePoint {
	model: Model<Api>;
	/** Undefined when no level was active; restoring then leaves the level untouched. */
	thinkingLevel: ThinkingLevel | undefined;
}

/** HTTP statuses that mean "this model is busy", as opposed to a broken request. */
function isRateLimited(status: number): boolean {
	return status === 429 || status === 503;
}

/**
 * The model in use when `/new` was issued, kept for the replacement session.
 *
 * Pi rebuilds its resource loader for every session replacement and loads
 * extensions with the module cache disabled, so a new session gets a fresh
 * factory instance and a fresh module scope. Only process-global state survives
 * that hand-off, hence the `globalThis` slot rather than a closure variable.
 */
interface CarryOver {
	provider: string;
	modelId: string;
	thinkingLevel: ThinkingLevel | undefined;
}

const CARRY_OVER_KEY = Symbol.for("@chrisptang/pi-model-alias/carry-over");

function takeCarryOver(): CarryOver | undefined {
	const slot = globalThis as { [CARRY_OVER_KEY]?: CarryOver };
	const carried = slot[CARRY_OVER_KEY];
	delete slot[CARRY_OVER_KEY];
	return carried;
}

function setCarryOver(carried: CarryOver): void {
	(globalThis as { [CARRY_OVER_KEY]?: CarryOver })[CARRY_OVER_KEY] = carried;
}

function formatDuration(ms: number): string {
	const seconds = Math.ceil(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	return `${Math.ceil(seconds / 60)}m`;
}

export default function modelAlias(pi: ExtensionAPI): void {
	/** Populated on first use so the factory does no file or agent-dir work at load. */
	let loaded: LoadedAliases | undefined;
	/** Set while a skill-scoped model override is active; restored at the idle boundary. */
	let pendingRestore: RestorePoint | undefined;
	/** Rate-limited candidates, sidelined until their `retry-after` window elapses. */
	const cooldowns = new CooldownRegistry();
	/**
	 * The model each alias settled on for this session. Resolution reuses it while it
	 * stays usable, so an alias does not redraw a different candidate on every switch.
	 */
	const sticky = new Map<string, Model<Api>>();
	/**
	 * The alias that put the current model in flight. `after_provider_response` reports
	 * a status but not a model, so this is what a rate limit gets attributed to.
	 */
	let inFlight: { alias: string; model: Model<Api> } | undefined;

	const aliases = (warn?: (message: string) => void): LoadedAliases => {
		loaded ??= loadAliases(getAgentDir(), warn);
		return loaded;
	};

	const describe = (model: Model<Api>) => `${model.provider}/${model.id}`;

	const registryLookup = (ctx: ExtensionContext, alias?: string) => ({
		find: (provider: string, modelId: string) => ctx.modelRegistry.find(provider, modelId),
		hasAuth: (model: Model<Api>) => ctx.modelRegistry.hasConfiguredAuth(model),
		isCoolingDown: (model: Model<Api>) => cooldowns.isCoolingDown(model),
		sticky: alias ? sticky.get(alias) : undefined,
	});

	const applyModel = async (
		ctx: ExtensionContext,
		target: { model: Model<Api>; thinkingLevel?: ThinkingLevel },
	): Promise<boolean> => {
		const ok = await pi.setModel(target.model);
		if (!ok) {
			ctx.ui.notify(`No usable credentials for ${describe(target.model)}.`, "error");
			return false;
		}
		if (target.thinkingLevel) pi.setThinkingLevel(target.thinkingLevel);
		return true;
	};

	// ---------------------------------------------------------------------------
	// Feature 1: /ma <alias> switches the session model by short name.
	// ---------------------------------------------------------------------------
	pi.registerCommand("ma", {
		description: "Switch the session model using a configured alias",
		getArgumentCompletions: (prefix: string) => {
			const items = [...aliases().aliases.entries()]
				.filter(([name]) => name.startsWith(prefix))
				.map(([name, definition]) => ({
					value: name,
					label: name,
					description:
						sticky.get(name) !== undefined
							? `${describe(sticky.get(name) as Model<Api>)} (held)`
							: definition.models.length > 1
								? `${definition.models.length} candidates (random)`
								: definition.models[0],
				}));
			return items.length > 0 ? items : null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const name = args.trim();
			if (!name) {
				const names = [...aliases().aliases.keys()];
				ctx.ui.notify(
					names.length > 0 ? `Aliases: ${names.join(", ")}` : "No aliases configured.",
					"info",
				);
				return;
			}
			const definition = aliases().aliases.get(name);
			if (!definition) {
				ctx.ui.notify(`Unknown alias "${name}".`, "error");
				return;
			}
			const resolved = resolveAlias(definition, registryLookup(ctx, name));
			if (!resolved) {
				ctx.ui.notify(
					`Alias "${name}" has no registered candidate with usable credentials.`,
					"error",
				);
				return;
			}
			if (await applyModel(ctx, resolved)) {
				sticky.set(name, resolved.model);
				inFlight = { alias: name, model: resolved.model };
				const suffix = resolved.sticky
					? " (held)"
					: resolved.candidateCount > 1
						? ` (1 of ${resolved.candidateCount})`
						: "";
				ctx.ui.notify(`Model: ${describe(resolved.model)}${suffix}`, "info");
			}
		},
	});

	pi.registerCommand("model-alias-reload", {
		description: "Reload model alias definitions from disk",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const reloaded = loadAliases(getAgentDir(), (message) => ctx.ui.notify(message, "warning"));
			loaded = reloaded;
			// Definitions may no longer list the held candidates, so drop the session's
			// picks and let the next switch settle on the new configuration.
			sticky.clear();
			inFlight = undefined;
			ctx.ui.notify(`Loaded ${reloaded.aliases.size} aliases.`, "info");
		},
	});

	// ---------------------------------------------------------------------------
	// Feature 2: run a skill on its own model.
	// `/skill:<name>` is intercepted before expansion, the configured model is
	// applied, and the original input continues to normal skill expansion.
	// ---------------------------------------------------------------------------
	pi.on("input", async (event, ctx) => {
		const match = /^\/skill:([a-z0-9-]+)/.exec(event.text.trim());
		if (!match) return { action: "continue" };

		const definition: AliasDefinition | undefined = aliases().skills.get(match[1]);
		if (!definition) return { action: "continue" };

		// An alias may be used as the skill target indirection, so resolve it first.
		const aliasName = definition.models.length === 1 ? definition.models[0] : undefined;
		const aliased = (aliasName ? aliases().aliases.get(aliasName) : undefined) ?? definition;
		// A skill pointing at an alias shares that alias's held model; one with inline
		// candidates keys its own entry, so the two do not collide in the sticky map.
		const stickyKey =
			aliasName && aliases().aliases.has(aliasName) ? aliasName : `skill:${match[1]}`;

		const resolved = resolveAlias(aliased, registryLookup(ctx, stickyKey));
		if (!resolved) {
			ctx.ui.notify(
				`Skill "${match[1]}" has no usable model candidate; using current model.`,
				"warning",
			);
			return { action: "continue" };
		}

		const current = ctx.model;
		if (current && describe(current) === describe(resolved.model)) {
			sticky.set(stickyKey, resolved.model);
			inFlight = { alias: stickyKey, model: resolved.model };
			return { action: "continue" };
		}

		if (current && !pendingRestore)
			pendingRestore = { model: current, thinkingLevel: ctx.thinkingLevel };

		if (!(await applyModel(ctx, resolved))) {
			pendingRestore = undefined;
			return { action: "continue" };
		}
		sticky.set(stickyKey, resolved.model);
		inFlight = { alias: stickyKey, model: resolved.model };
		ctx.ui.notify(`Skill ${match[1]} -> ${describe(resolved.model)}`, "info");
		return { action: "continue" };
	});

	// ---------------------------------------------------------------------------
	// Feature 3: a rate-limited candidate is sidelined and the alias rotates.
	//
	// `after_provider_response` observes the status but cannot alter the request in
	// flight, and Pi retries the same model on its own. So the rotation lands on the
	// next turn: the failing candidate is put on cooldown and the alias is re-resolved
	// straight away, which `prepareNextTurn` picks up when the turn boundary arrives.
	// ---------------------------------------------------------------------------
	pi.on("after_provider_response", async (event, ctx) => {
		if (!isRateLimited(event.status)) return;

		const active = inFlight;
		if (!active) return;
		// Only attribute the limit when the session is still on the model we switched to;
		// anything else means the user or another extension has since taken over.
		const current = ctx.model;
		if (current && describe(current) !== describe(active.model)) return;

		const definition =
			aliases().aliases.get(active.alias) ??
			aliases().skills.get(active.alias.replace(/^skill:/u, ""));
		const cooldownMs = cooldowns.penalize(active.model, event.headers);

		// A single-candidate alias has nowhere to rotate to; the cooldown still records
		// the limit so a later switch can report it, but the model has to stay put.
		if (!definition || definition.models.length < 2) {
			ctx.ui.notify(
				`${describe(active.model)} is rate limited; retrying it (no other candidate).`,
				"warning",
			);
			return;
		}

		// Drop the held pick so resolution is free to draw a different candidate.
		if (
			sticky.get(active.alias) &&
			describe(sticky.get(active.alias) as Model<Api>) === describe(active.model)
		)
			sticky.delete(active.alias);

		const resolved = resolveAlias(definition, registryLookup(ctx, active.alias));
		if (!resolved || describe(resolved.model) === describe(active.model)) {
			ctx.ui.notify(
				`${describe(active.model)} is rate limited; every candidate is cooling down.`,
				"warning",
			);
			return;
		}

		if (!(await applyModel(ctx, resolved))) return;
		sticky.set(active.alias, resolved.model);
		inFlight = { alias: active.alias, model: resolved.model };
		ctx.ui.notify(
			`${describe(active.model)} rate limited (${formatDuration(cooldownMs)}); switching to ${describe(resolved.model)}.`,
			"warning",
		);
	});

	// `agent_settled` is the idle boundary: retries, compaction, and follow-ups are done.
	pi.on("agent_settled", async (_event, ctx) => {
		const restore = pendingRestore;
		if (!restore) return;
		pendingRestore = undefined;
		if (await pi.setModel(restore.model)) {
			if (restore.thinkingLevel) pi.setThinkingLevel(restore.thinkingLevel);
			// The restored model is the user's own choice, not an alias pick, so a later
			// rate limit on it must not be blamed on whichever alias ran the skill.
			inFlight = undefined;
			ctx.ui.notify(`Model restored: ${describe(restore.model)}`, "info");
		}
	});

	// ---------------------------------------------------------------------------
	// Feature 5: `/new` keeps the current model.
	//
	// A new session has no transcript to restore a model from, so Pi falls back to
	// the CLI `--model` or the settings default. Capture the outgoing model here
	// and re-apply it once the replacement session has started. "resume" restores
	// from the target session's own transcript and needs nothing. The replacement
	// session runs a new extension instance, so the hand-off goes through the
	// process-global slot (see `CarryOver`).
	// ---------------------------------------------------------------------------
	pi.on("session_before_switch", async (event, ctx) => {
		if (event.reason !== "new" || !ctx.model) return;
		setCarryOver({
			provider: ctx.model.provider,
			modelId: ctx.model.id,
			thinkingLevel: ctx.thinkingLevel,
		});
	});

	// A replaced session invalidates the restore point, the held picks, and the
	// cooldowns, all of which are scoped to one session by design.
	pi.on("session_start", async (event, ctx) => {
		pendingRestore = undefined;
		sticky.clear();
		cooldowns.clear();
		inFlight = undefined;

		const carried = takeCarryOver();
		if (event.reason === "new" && carried) {
			// Resolve against the new session's registry rather than reusing the old
			// session's model object.
			const target = ctx.modelRegistry.find(carried.provider, carried.modelId);
			if (!target) {
				ctx.ui.notify(
					`Previous model ${carried.provider}/${carried.modelId} is no longer available.`,
					"warning",
				);
			} else if (!ctx.model || describe(ctx.model) !== describe(target)) {
				await applyModel(ctx, { model: target, thinkingLevel: carried.thinkingLevel });
			} else if (carried.thinkingLevel) {
				pi.setThinkingLevel(carried.thinkingLevel);
			}
			return;
		}

		// -----------------------------------------------------------------------
		// Feature 4: `pi --model <alias>` starts the session on the alias.
		//
		// Pi resolves `--model` against its own catalog before any session exists,
		// so an alias name gets fuzzy-matched to an unrelated model. Only "startup"
		// carries a CLI argument; "resume" and "fork" restore the model from the
		// session transcript and "new" is handled above, so re-applying the flag
		// there would override a model the user has since chosen.
		// -----------------------------------------------------------------------
		if (event.reason !== "startup") return;

		const requested = readCliModelArgument(process.argv);
		if (!requested) return;

		const definition = aliases().aliases.get(requested);
		if (!definition) return;

		const resolved = resolveAlias(definition, registryLookup(ctx, requested));
		if (!resolved) {
			ctx.ui.notify(
				`Alias "${requested}" has no registered candidate with usable credentials; keeping ${
					ctx.model ? describe(ctx.model) : "the current model"
				}.`,
				"warning",
			);
			return;
		}

		// Pi already selected a model for the flag; only report a switch when the
		// alias actually lands somewhere else.
		if (ctx.model && describe(ctx.model) === describe(resolved.model)) {
			sticky.set(requested, resolved.model);
			inFlight = { alias: requested, model: resolved.model };
			return;
		}

		if (!(await applyModel(ctx, resolved))) return;
		sticky.set(requested, resolved.model);
		inFlight = { alias: requested, model: resolved.model };
		const suffix = resolved.candidateCount > 1 ? ` (1 of ${resolved.candidateCount})` : "";
		ctx.ui.notify(`Model: ${describe(resolved.model)}${suffix} (alias "${requested}")`, "info");
	});
}
