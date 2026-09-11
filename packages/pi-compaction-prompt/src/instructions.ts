/**
 * Composition of the file prompt with per-invocation `/compact` instructions.
 */

/**
 * Merge the configured prompt with the instructions Pi already received.
 *
 * Pi appends the result to its own summarization prompt as `Additional focus: <text>`,
 * so both parts stay additive to Pi's built-in format. The file text comes first as the
 * standing policy, and a `/compact <instructions>` argument follows as the narrower
 * request for this one compaction.
 */
export function mergeInstructions(
	filePrompt: string | undefined,
	customInstructions: string | undefined,
): string | undefined {
	const parts = [filePrompt, customInstructions]
		.map((part) => part?.trim())
		.filter((part): part is string => part !== undefined && part.length > 0);
	return parts.length > 0 ? parts.join("\n\n") : undefined;
}
