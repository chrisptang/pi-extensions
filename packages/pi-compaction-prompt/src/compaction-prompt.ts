/**
 * Injects a Markdown compaction prompt into Pi's summarization.
 */

import type {
	CompactionResult,
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { generateSummaryWithUsage } from "@earendil-works/pi-coding-agent";
import { computeFileLists, formatFileOperations } from "./file-lists.js";
import { mergeInstructions } from "./instructions.js";
import { type PromptResolution, resolvePrompt } from "./prompt-file.js";

/** Dependencies overridden in tests. */
export interface CompactionPromptDependencies {
	resolvePrompt: typeof resolvePrompt;
	generateSummary: typeof generateSummaryWithUsage;
}

const defaultDependencies: CompactionPromptDependencies = {
	resolvePrompt,
	generateSummary: generateSummaryWithUsage,
};

export default function compactionPrompt(
	pi: ExtensionAPI,
	dependencies: Partial<CompactionPromptDependencies> = {},
): void {
	const deps = { ...defaultDependencies, ...dependencies };

	pi.on("session_before_compact", async (event, ctx) => {
		const resolution = deps.resolvePrompt({
			cwd: ctx.cwd,
			projectTrusted: ctx.isProjectTrusted(),
		});
		reportErrors(ctx, resolution);

		const instructions = mergeInstructions(resolution.prompt?.text, event.customInstructions);
		// Without a prompt file there is nothing to add: Pi's default compaction already
		// applies any `/compact` instructions on its own.
		if (resolution.prompt === undefined || instructions === undefined) return;

		return await runCompaction(event, ctx, deps, instructions, resolution.prompt.scope);
	});
}

async function runCompaction(
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
	deps: CompactionPromptDependencies,
	instructions: string,
	scope: string,
): Promise<{ compaction: CompactionResult } | undefined> {
	const sessionModel = ctx.model;
	if (!sessionModel) {
		notify(ctx, "No active model for compaction; using Pi's default summary.", "warning");
		return undefined;
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(sessionModel);
	if (event.signal.aborted) return undefined;
	if (!auth.ok) {
		notify(
			ctx,
			`Could not resolve credentials (${auth.error}); using Pi's default summary.`,
			"warning",
		);
		return undefined;
	}
	// Match how Pi builds its own summarization request: route through the resolved base
	// URL and drop headers marked for deletion with a null value.
	const model = auth.baseUrl ? { ...sessionModel, baseUrl: auth.baseUrl } : sessionModel;
	const headers = withoutDeletedHeaders(auth.headers);

	const { preparation } = event;
	// A split turn's prefix is summarized by Pi's own second pass, which the extension
	// API cannot reach. Summarizing the prefix together with the history keeps every
	// message in the span covered by the configured prompt.
	const messages = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
	if (messages.length === 0) return undefined;

	try {
		const { text, usage } = await deps.generateSummary(
			messages,
			model,
			preparation.settings.reserveTokens,
			auth.apiKey,
			headers,
			event.signal,
			instructions,
			preparation.previousSummary,
			ctx.thinkingLevel,
			undefined,
			auth.env,
		);
		if (event.signal.aborted) return undefined;
		if (text.trim().length === 0) {
			notify(
				ctx,
				"Compaction prompt produced an empty summary; using Pi's default summary.",
				"warning",
			);
			return undefined;
		}

		const lists = computeFileLists(preparation.fileOps);
		notify(ctx, `Compacted with the ${scope} compaction prompt.`, "info");
		return {
			compaction: {
				summary: `${text}${formatFileOperations(lists)}`,
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				usage,
				details: { readFiles: lists.readFiles, modifiedFiles: lists.modifiedFiles },
			},
		};
	} catch (error) {
		if (event.signal.aborted) return undefined;
		notify(
			ctx,
			`Compaction prompt failed (${errorMessage(error)}); using Pi's default summary.`,
			"warning",
		);
		return undefined;
	}
}

function reportErrors(ctx: ExtensionContext, resolution: PromptResolution): void {
	for (const error of resolution.errors) notify(ctx, error, "warning");
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning"): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
}

/** Drop headers whose null value marks them for removal, as Pi does for its own requests. */
function withoutDeletedHeaders(
	headers: Record<string, string | null> | undefined,
): Record<string, string> | undefined {
	if (!headers) return undefined;
	return Object.fromEntries(
		Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== null),
	);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
