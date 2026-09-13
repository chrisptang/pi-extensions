import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export const JOB_STATES = [
	"queued",
	"running",
	"completed",
	"partial",
	"failed",
	"timed_out",
	"cancelled",
] as const;

export type SubagentJobState = (typeof JOB_STATES)[number];

export const TERMINAL_JOB_STATES = new Set<SubagentJobState>([
	"completed",
	"partial",
	"failed",
	"timed_out",
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

export interface ChildResult {
	state: Extract<SubagentJobState, "completed" | "partial" | "failed" | "timed_out" | "cancelled">;
	result?: string;
	error?: string;
	limitations: string[];
	truncated: boolean;
}

export interface BrokerCredentials {
	host: "127.0.0.1";
	port: number;
	token: string;
}

export interface ChildControl {
	send(message: string, signal?: AbortSignal): Promise<void>;
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
	| { type: "output"; text: string };

export interface ChildRequest {
	task: string;
	tools: string[];
	model: string;
	/** Agent definition body appended to the child's system prompt. */
	systemPrompt?: string;
	thinkingLevel: SubagentThinkingLevel;
	cwd: string;
	timeout?: number;
	projectTrusted: boolean;
	communication: BrokerCredentials;
	signal: AbortSignal;
	onControl?: (control: ChildControl) => void;
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
	resultSummary?: string;
	errorSummary?: string;
}
