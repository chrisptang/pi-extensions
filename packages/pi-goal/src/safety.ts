import { createHash } from "node:crypto";
import type { ActiveGoal } from "./persistence.js";

const TOOL_FIELD_SEPARATOR = "\u0000";
const TOOL_CALL_SEPARATOR = "\u0001";

export interface ToolFreeRepeatState {
	toolFreeRepeatCount: number;
	lastToolFreeOutputFingerprint?: string;
	lastFailedToolRunFingerprint?: string;
}

/** One completed tool execution observed during an automatic run. */
export interface ToolRunObservation {
	toolName: string;
	args: unknown;
	isError: boolean;
}

export function queueGoalSafetyReset(goal: ActiveGoal): ActiveGoal {
	return { ...goal, safetyResetPending: true };
}

export function resetGoalSafetyEpoch(goal: ActiveGoal): ActiveGoal {
	return {
		...goal,
		automaticModelTurns: 0,
		toolFreeRepeatCount: 0,
		lastToolFreeOutputFingerprint: undefined,
		lastFailedToolRunFingerprint: undefined,
		safetyPauseCause: undefined,
		safetyResetPending: undefined,
	};
}

/**
 * Advances the no-progress counter for one finished automatic run.
 *
 * Two independent repetition signals share the counter and the `noProgressTurns`
 * threshold, because both mean the same thing: another automatic run bought nothing.
 *
 * - Tool-free runs repeat when the visible assistant text is unchanged.
 * - Tool-using runs repeat only when the exact same tool calls ran again *and* every
 *   one of them failed. A single success, or any change to the calls, counts as
 *   progress, which keeps deliberate retries and exploratory trial-and-error alive.
 *
 * Switching between the two signals restarts the count at 1 instead of mixing them,
 * so a threshold is only ever reached by one kind of repetition.
 */
export function nextToolFreeRepeatState(
	current: ToolFreeRepeatState,
	messages: readonly unknown[],
	toolRun: readonly ToolRunObservation[] | boolean,
): ToolFreeRepeatState {
	const observations = normalizeToolRun(toolRun);
	if (observations === "unobserved") return { toolFreeRepeatCount: 0 };

	if (observations.length > 0) {
		// A run that got any tool to succeed made progress by definition.
		if (!observations.every((observation) => observation.isError)) {
			return { toolFreeRepeatCount: 0 };
		}
		const fingerprint = fingerprintToolRun(observations);
		return {
			toolFreeRepeatCount:
				fingerprint === current.lastFailedToolRunFingerprint
					? Math.min(Number.MAX_SAFE_INTEGER, current.toolFreeRepeatCount + 1)
					: 1,
			lastFailedToolRunFingerprint: fingerprint,
		};
	}

	const fingerprint = fingerprintVisibleAssistantOutput(messages);
	return {
		toolFreeRepeatCount:
			fingerprint === current.lastToolFreeOutputFingerprint
				? Math.min(Number.MAX_SAFE_INTEGER, current.toolFreeRepeatCount + 1)
				: 1,
		lastToolFreeOutputFingerprint: fingerprint,
	};
}

/**
 * Older callers pass a bare `toolAttempted` boolean. `true` carries no per-call
 * detail, so it keeps its original meaning of "progress, stop counting".
 */
function normalizeToolRun(
	toolRun: readonly ToolRunObservation[] | boolean,
): readonly ToolRunObservation[] | "unobserved" {
	if (toolRun === true) return "unobserved";
	if (toolRun === false) return [];
	return toolRun;
}

export function hasAssistantToolCall(messages: readonly unknown[]) {
	for (const message of messages) {
		if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) {
			continue;
		}
		if (message.content.some((block) => isRecord(block) && block.type === "toolCall")) return true;
	}
	return false;
}

export function fingerprintToolRun(observations: readonly ToolRunObservation[]) {
	const normalized = observations
		.map(
			(observation) =>
				`${observation.toolName}${TOOL_FIELD_SEPARATOR}${stableArgs(observation.args)}`,
		)
		.join(TOOL_CALL_SEPARATOR);
	return createHash("sha256").update(normalized, "utf8").digest("hex");
}

/**
 * Serializes tool arguments with object keys sorted, so key order alone cannot make
 * two otherwise identical calls look different.
 */
function stableArgs(value: unknown): string {
	if (value === undefined) return "undefined";
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
	if (Array.isArray(value)) return `[${value.map(stableArgs).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, entryValue]) => entryValue !== undefined)
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
		.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableArgs(entryValue)}`);
	return `{${entries.join(",")}}`;
}

export function fingerprintVisibleAssistantOutput(messages: readonly unknown[]) {
	const normalized = normalizeVisibleAssistantOutput(messages);
	return createHash("sha256").update(normalized, "utf8").digest("hex");
}

export function normalizeVisibleAssistantOutput(messages: readonly unknown[]) {
	const text: string[] = [];
	for (const message of messages) {
		if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) {
			continue;
		}
		for (const block of message.content) {
			if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") continue;
			text.push(block.text);
		}
	}
	const normalized = text
		.join("\n")
		.normalize("NFKC")
		.toLowerCase()
		.replace(/\s+/gu, " ")
		.replace(/[\p{Cc}\p{Cf}]/gu, "")
		.trim();
	return normalized === "" || /^[\p{P}\s]+$/u.test(normalized) ? "" : normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
