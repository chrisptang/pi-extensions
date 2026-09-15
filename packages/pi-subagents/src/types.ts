import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export const JOB_STATES = [
	"queued",
	"running",
	"completed",
	"partial",
	"failed",
	"timed_out",
	"budget_exhausted",
	"cancelled",
] as const;

export type SubagentJobState = (typeof JOB_STATES)[number];

export const TERMINAL_JOB_STATES = new Set<SubagentJobState>([
	"completed",
	"partial",
	"failed",
	"timed_out",
	"budget_exhausted",
	"cancelled",
]);

export const CHILD_CORE_TOOL_NAMES = [
	"read",
	"bash",
	"powershell",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
] as const;
export const DEFAULT_SUBAGENT_TOOLS = ["read", "grep", "find", "ls"] as const;
export const SUBAGENT_THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const satisfies readonly ModelThinkingLevel[];
export type SubagentThinkingLevel = (typeof SUBAGENT_THINKING_LEVELS)[number];
/**
 * Turns a child may take before it is asked to wrap up. A turn is one model
 * response, so this bounds exploration regardless of how fast the model answers.
 */
export const DEFAULT_MAX_TURNS = 100;

export interface ChildResult {
	state: Extract<
		SubagentJobState,
		"completed" | "partial" | "failed" | "timed_out" | "budget_exhausted" | "cancelled"
	>;
	result?: string;
	error?: string;
	limitations: string[];
	truncated: boolean;
}

/**
 * Progress reported by a running child, for human inspection only.
 *
 * The child's stdout already carries every session event; these are the ones
 * that say what it is doing. Thinking is deliberately absent: it is never
 * forwarded, so no display path can expose it.
 */
export type ChildActivity =
	| { type: "tool_start"; toolCallId: string; tool: string; args: unknown }
	| { type: "tool_end"; toolCallId: string; tool: string; result: unknown; isError: boolean }
	| { type: "output"; text: string }
	| { type: "turn"; turns: number }
	| { type: "notice"; text: string };

export interface ChildRequest {
	task: string;
	tools: string[];
	model: string;
	/** Agent definition body appended to the child's system prompt. */
	systemPrompt?: string;
	thinkingLevel: SubagentThinkingLevel;
	cwd: string;
	timeout?: number;
	/** Turn budget; the child is steered to wrap up when it is reached. Omit for no budget. */
	maxTurns?: number;
	projectTrusted: boolean;
	signal: AbortSignal;
	/**
	 * Called once the child's RPC has accepted the task prompt, which is also when
	 * its timeout starts. Observation only: nothing can be sent to a child.
	 */
	onReady?: () => void;
	/** Observer for child progress. Must not throw; failures are the caller's to contain. */
	onActivity?: (activity: ChildActivity) => void;
}

export interface JobSummary {
	jobId: string;
	/** Agent definition the job runs, when one was selected. */
	agent?: string;
	/** Short caller-supplied summary of what the job is doing. */
	description?: string;
	state: SubagentJobState;
	createdAt: number;
	startedAt?: number;
	finishedAt?: number;
	timeout?: number;
	maxTurns?: number;
	/** Model responses the child has produced so far. */
	turns?: number;
	resultSummary?: string;
	errorSummary?: string;
}
