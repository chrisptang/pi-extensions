import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type AliasDefinition, loadAliases, resolveAlias } from "./aliases.js";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? `${process.env.HOME}/.pi/agent`;

interface RestorePoint {
	model: Model<Api>;
	/** Undefined when no level was active; restoring then leaves the level untouched. */
	thinkingLevel: ThinkingLevel | undefined;
}

export default function modelAlias(pi: ExtensionAPI): void {
	let loaded = loadAliases(AGENT_DIR);
	/** Set while a skill-scoped model override is active; restored at the idle boundary. */
	let pendingRestore: RestorePoint | undefined;

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
			const items = [...loaded.aliases.entries()]
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
				const names = [...loaded.aliases.keys()];
				ctx.ui.notify(
					names.length > 0 ? `Aliases: ${names.join(", ")}` : "No aliases configured.",
					"info",
				);
				return;
			}
			const definition = loaded.aliases.get(name);
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
			loaded = loadAliases(AGENT_DIR, (message) => ctx.ui.notify(message, "warning"));
			ctx.ui.notify(`Loaded ${loaded.aliases.size} aliases.`, "info");
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

		const definition: AliasDefinition | undefined = loaded.skills.get(match[1]);
		if (!definition) return { action: "continue" };

		// An alias may be used as the skill target indirection, so resolve it first.
		const aliased =
			(definition.models.length === 1 ? loaded.aliases.get(definition.models[0]) : undefined) ??
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
