import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type ActivityEvent, ActivityLog } from "./activity.js";
import { COMPLETION_MESSAGE_TYPE } from "./completion-renderer.js";
import { modelVisibleJson } from "./model-output.js";
import { runChild as defaultRunChild } from "./process.js";
import {
	type ChildActivity,
	type ChildRequest,
	type ChildResult,
	type ChildUsage,
	type JobSummary,
	type SubagentJobState,
	type SubagentThinkingLevel,
	TERMINAL_JOB_STATES,
} from "./types.js";

const MAX_ACTIVE_JOBS = 8;
const MAX_RETAINED_TERMINAL_JOBS = 32;
const TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1_000;
interface StopRequest {
	child: ChildResult;
	deliver: boolean;
}

interface InternalJob extends JobSummary {
	controller: AbortController;
	tools: string[];
	model: string;
	contextWindow?: number;
	usage: JobUsage;
	notifyOnCompletion: boolean;
	terminal: Promise<void>;
	resolveTerminal: () => void;
	task?: Promise<void>;
	stopRequest?: StopRequest;
	result?: string;
	error?: string;
	limitations: string[];
	turns: number;
	deliverySent: boolean;
	generation: number;
	/** Human-facing progress record. Never read by the model. */
	activity: ActivityLog;
}

export interface RuntimeDependencies {
	runChild?: (request: ChildRequest) => Promise<ChildResult>;
	now?: () => number;
}

/**
 * One job as the inspection panel sees it, active or terminal.
 *
 * This is a human-facing view: unlike `JobSummary`, which the model receives and
 * which deliberately omits the tool list, it carries everything the panel shows.
 */
/**
 * What a job has spent so far, accumulated from its child's responses.
 *
 * `contextTokens` is the latest usable reading rather than a sum: it says how
 * full the child's context is now, which is what a reader watching a long job
 * needs to know.
 */
export interface JobUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** Provider cost so far, in USD. */
	cost: number;
	/** Context the child's latest usable response carried. */
	contextTokens?: number;
}

export interface PanelJob {
	jobId: string;
	agent?: string;
	description?: string;
	state: SubagentJobState;
	createdAt: number;
	startedAt?: number;
	finishedAt?: number;
	elapsedMs: number;
	maxTurns?: number;
	turns: number;
	tools: string[];
	/** Concrete `provider/modelId` the child runs. */
	model: string;
	/** Context window of `model`, when the registry reported one. */
	contextWindow?: number;
	usage: JobUsage;
	error?: string;
	limitations: string[];
	/** Events evicted by the per-job capacity bound. */
	droppedEvents: number;
	activity: ActivityEvent[];
}

export interface ActiveJobDisplay {
	jobId: string;
	/** Agent definition the job runs, when one was selected. */
	agent?: string;
	/** Short caller-supplied summary of what the job is doing. */
	description?: string;
	state: Extract<SubagentJobState, "queued" | "running">;
	elapsedMs: number;
	maxTurns?: number;
	turns: number;
	tools: string[];
	/** The child's most recent activity line, so the widget says what it is doing now. */
	latestActivity?: string;
}

export interface StartJobInput {
	task: string;
	tools: string[];
	model: string;
	/** Context window of `model`, when the registry reports one. */
	contextWindow?: number;
	thinkingLevel: SubagentThinkingLevel;
	cwd: string;
	/** Turn budget after which the child is asked to wrap up. */
	maxTurns?: number;
	projectTrusted: boolean;
	/** Agent definition body appended to the child's system prompt. */
	systemPrompt?: string;
	/** Agent name recorded for inspection and completion reporting. */
	agent?: string;
	/** Short summary of the task, shown in the active-jobs widget. */
	description?: string;
	/** Notes about degraded setup, such as an unresolved model alias. */
	limitations?: string[];
	/**
	 * Background jobs interrupt the main agent with their completion so a weaker
	 * model cannot forget to collect the result. Blocking callers use wait instead.
	 */
	notifyOnCompletion?: boolean;
}

export class SubagentRuntime {
	private readonly jobs = new Map<string, InternalJob>();
	private readonly runChild: (request: ChildRequest) => Promise<ChildResult>;
	private readonly now: () => number;
	private counter = 0;
	private generation = 0;
	private deliveryEnabled = false;
	private sessionActive = false;
	private omittedJobs = 0;
	private readonly jobListeners = new Set<() => void>();

	constructor(
		private readonly pi: ExtensionAPI,
		dependencies: RuntimeDependencies = {},
	) {
		this.runChild = dependencies.runChild ?? defaultRunChild;
		this.now = dependencies.now ?? Date.now;
	}

	beginSession(): void {
		if (this.sessionActive) throw new Error("Subagent runtime session is already active.");
		this.generation++;
		this.jobs.clear();
		this.omittedJobs = 0;
		this.deliveryEnabled = true;
		this.sessionActive = true;
		this.notifyJobsChanged();
	}

	/** Whether a session owns this runtime. A closed panel checks this to stop itself. */
	isSessionActive(): boolean {
		return this.sessionActive;
	}

	subscribeJobs(listener: () => void): () => void {
		this.jobListeners.add(listener);
		return () => this.jobListeners.delete(listener);
	}

	activeJobsForDisplay(): ActiveJobDisplay[] {
		const now = this.now();
		return [...this.jobs.values()]
			.filter((job): job is InternalJob & { state: "queued" | "running" } => !isTerminal(job.state))
			.sort((left, right) => left.createdAt - right.createdAt)
			.map((job) => ({
				jobId: job.jobId,
				...(job.agent ? { agent: job.agent } : {}),
				...(job.description ? { description: job.description } : {}),
				state: job.state,
				elapsedMs: Math.max(0, now - (job.startedAt ?? job.createdAt)),
				...(job.maxTurns !== undefined ? { maxTurns: job.maxTurns } : {}),
				turns: job.turns,
				tools: [...job.tools],
				...latestActivityOf(job),
			}));
	}

	/**
	 * Every retained job with its activity, newest-created last.
	 *
	 * Terminal jobs stay listed so a human can review what a cancelled or failed
	 * child actually did; they leave only when `prune` drops the job itself.
	 */
	panelJobs(): PanelJob[] {
		this.prune();
		const now = this.now();
		return [...this.jobs.values()]
			.sort((left, right) => left.createdAt - right.createdAt)
			.map((job) => ({
				jobId: job.jobId,
				...(job.agent ? { agent: job.agent } : {}),
				...(job.description ? { description: job.description } : {}),
				state: job.state,
				createdAt: job.createdAt,
				...(job.startedAt !== undefined ? { startedAt: job.startedAt } : {}),
				...(job.finishedAt !== undefined ? { finishedAt: job.finishedAt } : {}),
				elapsedMs: Math.max(0, (job.finishedAt ?? now) - (job.startedAt ?? job.createdAt)),
				...(job.maxTurns !== undefined ? { maxTurns: job.maxTurns } : {}),
				turns: job.turns,
				tools: [...job.tools],
				model: job.model,
				...(job.contextWindow !== undefined ? { contextWindow: job.contextWindow } : {}),
				usage: { ...job.usage },
				...(job.error ? { error: job.error } : {}),
				limitations: [...job.limitations],
				droppedEvents: job.activity.droppedCount,
				activity: job.activity.snapshot(),
			}));
	}

	start(input: StartJobInput): {
		jobId: string;
		state: "queued";
		maxTurns?: number;
	} {
		if (!this.sessionActive) {
			throw new Error("Subagent runtime is unavailable because the session is not active.");
		}
		this.prune();
		const active = [...this.jobs.values()].filter((job) => !isTerminal(job.state)).length;
		if (active >= MAX_ACTIVE_JOBS) {
			throw new Error(`Active subagent job limit reached (${MAX_ACTIVE_JOBS}).`);
		}
		const jobId = `job_${this.now().toString(36)}_${(++this.counter).toString(36)}`;
		let resolveTerminal!: () => void;
		const terminal = new Promise<void>((resolve) => {
			resolveTerminal = resolve;
		});
		const controller = new AbortController();
		const job: InternalJob = {
			jobId,
			...(input.agent ? { agent: input.agent } : {}),
			...(input.description ? { description: input.description } : {}),
			state: "queued",
			createdAt: this.now(),
			...(input.maxTurns !== undefined ? { maxTurns: input.maxTurns } : {}),
			controller,
			tools: [...input.tools],
			model: input.model,
			...(input.contextWindow !== undefined ? { contextWindow: input.contextWindow } : {}),
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
			notifyOnCompletion: input.notifyOnCompletion ?? false,
			terminal,
			resolveTerminal,
			// Setup limitations, such as an unresolved model alias, are reported even
			// when the child itself runs cleanly.
			limitations: [...(input.limitations ?? [])],
			turns: 0,
			deliverySent: false,
			generation: this.generation,
			activity: new ActivityLog(),
		};
		this.jobs.set(jobId, job);
		this.notifyJobsChanged();
		job.task = Promise.resolve().then(async () => {
			if (job.state !== "queued" || job.generation !== this.generation) return;
			if (job.stopRequest) {
				this.finish(job, job.stopRequest.child, job.stopRequest.deliver);
				return;
			}
			job.state = "running";
			job.startedAt = this.now();
			this.notifyJobsChanged();
			let child: ChildResult;
			try {
				child = await this.runChild({
					task: input.task,
					tools: [...input.tools],
					model: input.model,
					...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
					thinkingLevel: input.thinkingLevel,
					cwd: input.cwd,
					maxTurns: input.maxTurns,
					projectTrusted: input.projectTrusted,
					signal: controller.signal,
					onActivity: (activity) => this.recordActivity(job, activity),
				});
			} catch (error) {
				child = {
					state: controller.signal.aborted ? "cancelled" : "failed",
					error: error instanceof Error ? error.message : String(error),
					limitations: [],
					truncated: false,
				};
			}
			if (job.state !== "running" || job.generation !== this.generation) return;
			const outcome = job.stopRequest ?? { child, deliver: true };
			this.finish(job, outcome.child, outcome.deliver);
		});
		return {
			jobId,
			state: "queued",
			...(job.maxTurns !== undefined ? { maxTurns: job.maxTurns } : {}),
		};
	}

	inspectJobs(): { jobs: JobSummary[]; omitted: number } {
		this.prune();
		return {
			jobs: [...this.jobs.values()]
				.sort((left, right) => left.createdAt - right.createdAt)
				.map((job) => this.summary(job)),
			omitted: this.omittedJobs,
		};
	}

	/**
	 * Record child progress against a job.
	 *
	 * Late events are dropped rather than appended: once a job is terminal, or
	 * belongs to a replaced session, its record is what the human reviews and
	 * must not keep changing underneath them.
	 */
	private recordActivity(job: InternalJob, activity: ChildActivity): void {
		if (isTerminal(job.state) || job.generation !== this.generation) return;
		const at = this.now();
		switch (activity.type) {
			case "tool_start":
				job.activity.toolStart(activity.toolCallId, activity.tool, activity.args, at);
				break;
			case "tool_end":
				job.activity.toolEnd(
					activity.toolCallId,
					activity.tool,
					activity.result,
					activity.isError,
					at,
				);
				break;
			case "output":
				job.activity.output(activity.text, at);
				break;
			case "turn":
				job.turns = activity.turns;
				break;
			case "notice":
				job.activity.notice(activity.text, at);
				break;
			case "usage":
				accumulateUsage(job.usage, activity.usage);
				break;
		}
		this.notifyJobsChanged();
	}

	/**
	 * Cancel one job and release the resources it owns.
	 *
	 * `origin` distinguishes a human cancellation from the model's own, because
	 * the main agent would otherwise read its own wording back and retry work the
	 * user deliberately stopped. File changes the child already made are kept, and
	 * its activity record stays readable in the panel.
	 */
	async cancel(
		jobId: string,
		origin: "model" | "user" = "model",
	): Promise<{ jobId: string; state: SubagentJobState }> {
		const job = this.requireJob(jobId);
		const error =
			origin === "user"
				? "Subagent execution was cancelled by the user."
				: "Subagent execution was cancelled.";
		if (!isTerminal(job.state)) job.activity.notice(error, this.now());
		await this.stop(
			job,
			{ state: "cancelled", error, limitations: [], truncated: false },
			true,
			new DOMException("Subagent job cancelled", "AbortError"),
		);
		return { jobId, state: job.state };
	}

	async wait(
		jobId: string,
		timeoutMs: number | undefined,
		signal?: AbortSignal,
	): Promise<{
		jobId: string;
		state: SubagentJobState;
		timedOut: boolean;
		result?: string;
		error?: string;
		limitations?: string[];
	}> {
		const job = this.requireJob(jobId);
		if (isTerminal(job.state)) return this.waitResult(job, false);
		if (signal?.aborted) throw abortError("Subagent wait was cancelled");
		let timeout: NodeJS.Timeout | undefined;
		let onAbort: (() => void) | undefined;
		const outcome = await Promise.race([
			job.terminal.then(() => "terminal" as const),
			...(timeoutMs !== undefined
				? [
						new Promise<"timeout">((resolve) => {
							timeout = setTimeout(() => resolve("timeout"), timeoutMs);
							timeout.unref();
						}),
					]
				: []),
			...(signal
				? [
						new Promise<"aborted">((resolve) => {
							onAbort = () => resolve("aborted");
							signal.addEventListener("abort", onAbort, { once: true });
						}),
					]
				: []),
		]);
		if (timeout) clearTimeout(timeout);
		if (signal && onAbort) signal.removeEventListener("abort", onAbort);
		if (outcome === "aborted") throw abortError("Subagent wait was cancelled");
		if (isTerminal(job.state)) return this.waitResult(job, false);
		return this.waitResult(job, outcome === "timeout");
	}

	async shutdown(): Promise<void> {
		if (!this.sessionActive) return;
		this.deliveryEnabled = false;
		this.sessionActive = false;
		const active = [...this.jobs.values()].filter((job) => !isTerminal(job.state));
		await Promise.allSettled(
			active.map((job) =>
				this.stop(
					job,
					{
						state: "cancelled",
						error: "Subagent session shut down.",
						limitations: [],
						truncated: false,
					},
					false,
					new DOMException("Subagent session shut down", "AbortError"),
				),
			),
		);
		this.generation++;
		this.notifyJobsChanged();
	}

	private async stop(
		job: InternalJob,
		child: ChildResult,
		deliver: boolean,
		reason: DOMException,
	): Promise<void> {
		if (isTerminal(job.state)) return;
		job.stopRequest ??= { child, deliver };
		if (!job.controller.signal.aborted) job.controller.abort(reason);
		await job.task;
		if (!isTerminal(job.state)) {
			this.finish(job, job.stopRequest.child, job.stopRequest.deliver);
		}
	}

	private notifyJobsChanged(): void {
		for (const listener of this.jobListeners) {
			try {
				listener();
			} catch {
				// UI observers cannot interrupt the job lifecycle.
			}
		}
	}

	private finish(job: InternalJob, child: ChildResult, deliver: boolean): void {
		if (isTerminal(job.state)) return;
		job.state = child.state;
		job.finishedAt = this.now();
		// A closing line so the panel reports the outcome, not just an abrupt stop.
		job.activity.notice(`Job ${child.state}.`, job.finishedAt);
		job.result = child.result;
		job.error = child.error;
		// Keep setup limitations recorded at start alongside the child's own.
		job.limitations = [...new Set([...job.limitations, ...child.limitations])];
		job.resolveTerminal();
		this.notifyJobsChanged();
		if (deliver) this.deliver(job);
		this.prune();
	}

	private deliver(job: InternalJob): void {
		if (!this.deliveryEnabled || job.deliverySent || job.generation !== this.generation) return;
		job.deliverySent = true;
		const payload = this.waitResult(job, false);
		try {
			this.pi.sendMessage(
				{
					customType: COMPLETION_MESSAGE_TYPE,
					content: modelVisibleJson(payload, { prefix: "Subagent job completion:\n" }),
					display: true,
					details: payload,
				},
				// A background job triggers a turn so the main agent acts on the result
				// immediately. A blocking caller is already waiting, so it must not.
				{ deliverAs: "steer", ...(job.notifyOnCompletion ? { triggerTurn: true } : {}) },
			);
		} catch {
			// Completion remains available through wait; inspect continues to report status.
		}
	}

	private waitResult(job: InternalJob, timedOut: boolean) {
		return {
			jobId: job.jobId,
			...(job.agent ? { agent: job.agent } : {}),
			...(job.description ? { description: job.description } : {}),
			state: job.state,
			timedOut,
			...(!timedOut && job.result ? { result: job.result } : {}),
			...(!timedOut && job.error ? { error: job.error } : {}),
			...(!timedOut && job.limitations.length > 0 ? { limitations: [...job.limitations] } : {}),
		};
	}

	private summary(job: InternalJob): JobSummary {
		return {
			jobId: job.jobId,
			...(job.agent ? { agent: job.agent } : {}),
			...(job.description ? { description: job.description } : {}),
			state: job.state,
			createdAt: job.createdAt,
			...(job.startedAt !== undefined ? { startedAt: job.startedAt } : {}),
			...(job.finishedAt !== undefined ? { finishedAt: job.finishedAt } : {}),
			...(job.maxTurns !== undefined ? { maxTurns: job.maxTurns } : {}),
			turns: job.turns,
			...(job.resultSummary !== undefined ? { resultSummary: job.resultSummary } : {}),
			...(job.errorSummary !== undefined ? { errorSummary: job.errorSummary } : {}),
		};
	}

	private requireJob(jobId: string): InternalJob {
		this.prune();
		const job = this.jobs.get(jobId);
		if (!job) throw new Error("Unknown or expired subagent job.");
		return job;
	}

	private prune(): void {
		const now = this.now();
		const expired = [...this.jobs.values()].filter(
			(job) =>
				isTerminal(job.state) && (job.finishedAt ?? job.createdAt) < now - TERMINAL_RETENTION_MS,
		);
		for (const job of expired) {
			if (this.jobs.delete(job.jobId)) this.omittedJobs++;
		}
		const terminal = [...this.jobs.values()]
			.filter((job) => isTerminal(job.state))
			.sort((left, right) => (left.finishedAt ?? 0) - (right.finishedAt ?? 0));
		for (const job of terminal.slice(
			0,
			Math.max(0, terminal.length - MAX_RETAINED_TERMINAL_JOBS),
		)) {
			if (this.jobs.delete(job.jobId)) this.omittedJobs++;
		}
	}
}

/**
 * The last activity line, formatted for the one-line widget.
 *
 * Only the newest event is exposed: the widget exists to say a job is alive and
 * roughly where it is, and the panel is where the full record is read.
 */
/**
 * Fold one response's accounting into the job's running totals. Context size is
 * replaced rather than added, because each reading already covers the whole
 * conversation the child sent.
 */
function accumulateUsage(totals: JobUsage, usage: ChildUsage): void {
	totals.input += usage.input;
	totals.output += usage.output;
	totals.cacheRead += usage.cacheRead;
	totals.cacheWrite += usage.cacheWrite;
	totals.cost += usage.cost;
	if (usage.contextTokens !== undefined) totals.contextTokens = usage.contextTokens;
}

function latestActivityOf(job: InternalJob): { latestActivity?: string } {
	const events = job.activity.snapshot();
	const latest = events.at(-1);
	if (!latest) return {};
	const prefix = latest.kind === "tool" ? `${latest.tool ?? "tool"} ` : "";
	const text = `${prefix}${latest.detail}`.trim();
	return text ? { latestActivity: text } : {};
}

function isTerminal(state: SubagentJobState): boolean {
	return TERMINAL_JOB_STATES.has(state);
}

function abortError(message: string): Error {
	const error = new Error(message);
	error.name = "AbortError";
	return error;
}
