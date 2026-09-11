import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { type AliasDefinition, type LoadedAliases, loadAliases, resolveAlias } from "./aliases.js";

interface RestorePoint {
	model: Model<Api>;
	/** Undefined when no level was active; restoring then leaves the level untouched. */
	thinkingLevel: ThinkingLevel | undefined;
}

export default function modelAlias(pi: ExtensionAPI): void {
	/** Populated on first use so the factory does no file or agent-dir work at load. */
	let loaded: LoadedAliases | undefined;
	/** Set while a skill-scoped model override is active; restored at the idle boundary. */
	let pendingRestore: RestorePoint | undefined;

	const aliases = (warn?: (message: string) => void): LoadedAliases => {
		loaded ??= loadAliases(getAgentDir(), warn);
		return loaded;
	};

	const describe = (model: Model<Api>) => `${model.provider}/${model.id}`;

	const registryLookup = (ctx: ExtensionContext) => ({
		find: (provider: string, modelId: string) => ctx.modelRegistry.find(provider, modelId),
		hasAuth: (model: Model<Api>) => ctx.modelRegistry.hasConfiguredAuth(model),
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
						definition.models.length > 1
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
			const resolved = resolveAlias(definition, registryLookup(ctx));
			if (!resolved) {
				ctx.ui.notify(
					`Alias "${name}" has no registered candidate with usable credentials.`,
					"error",
				);
				return;
			}
			if (await applyModel(ctx, resolved)) {
				const suffix = resolved.candidateCount > 1 ? ` (1 of ${resolved.candidateCount})` : "";
				ctx.ui.notify(`Model: ${describe(resolved.model)}${suffix}`, "info");
			}
		},
	});

	pi.registerCommand("model-alias-reload", {
		description: "Reload model alias definitions from disk",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const reloaded = loadAliases(getAgentDir(), (message) => ctx.ui.notify(message, "warning"));
			loaded = reloaded;
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
		const aliased =
			(definition.models.length === 1 ? aliases().aliases.get(definition.models[0]) : undefined) ??
			definition;
		const resolved = resolveAlias(aliased, registryLookup(ctx));
		if (!resolved) {
			ctx.ui.notify(
				`Skill "${match[1]}" has no usable model candidate; using current model.`,
				"warning",
			);
			return { action: "continue" };
		}

		const current = ctx.model;
		if (current && describe(current) === describe(resolved.model)) return { action: "continue" };

		if (current && !pendingRestore)
			pendingRestore = { model: current, thinkingLevel: ctx.thinkingLevel };

		if (!(await applyModel(ctx, resolved))) {
			pendingRestore = undefined;
			return { action: "continue" };
		}
		ctx.ui.notify(`Skill ${match[1]} -> ${describe(resolved.model)}`, "info");
		return { action: "continue" };
	});

	// `agent_settled` is the idle boundary: retries, compaction, and follow-ups are done.
	pi.on("agent_settled", async (_event, ctx) => {
		const restore = pendingRestore;
		if (!restore) return;
		pendingRestore = undefined;
		if (await pi.setModel(restore.model)) {
			if (restore.thinkingLevel) pi.setThinkingLevel(restore.thinkingLevel);
			ctx.ui.notify(`Model restored: ${describe(restore.model)}`, "info");
		}
	});

	// A replaced session invalidates the restore point.
	pi.on("session_start", async () => {
		pendingRestore = undefined;
	});
}
