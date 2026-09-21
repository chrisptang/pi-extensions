import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { type AssistantMessage, isRetryableAssistantError } from "@earendil-works/pi-ai";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import type { ChildActivity, ChildRequest, ChildResult, ChildUsage } from "./types.js";

const CORE_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;
const MAX_OUTPUT_BYTES = 32 * 1024;
const MAX_ERROR_BYTES = 8 * 1024;
const MAX_EVENT_LINE_BYTES = 256 * 1024;
const RPC_RESPONSE_TIMEOUT_MS = 30_000;
const KILL_GRACE_MS = 1_000;
const MAX_TRANSIENT_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 2_000;
const CONTINUE_AFTER_TRANSIENT_FAILURE_MESSAGE =
	"Continue after transient failure and finish the original task. Do not redo completed work; use the existing conversation and workspace state.";
const PREMATURE_STREAM_ERROR_PATTERN =
	/stream disconnected before completion|stream closed before response\.completed/iu;
/**
 * Turns the child may still take after its budget is reached. The wrap-up steer
 * lands only before the next model call, so one turn may already be in flight
 * when it is sent; the rest cover a short closing exchange.
 */
const BUDGET_GRACE_TURNS = 3;
/**
 * Share of the budget after which the child is reminded how many turns remain.
 * The model cannot count its own turns, so the reminder carries real numbers.
 * It is skipped when fewer than BUDGET_HINT_MIN_REMAINING turns would separate
 * it from the wrap-up request, where it would only add noise.
 */
const BUDGET_HINT_RATIO = 0.9;
const BUDGET_HINT_MIN_REMAINING = 3;
/**
 * Share of the context window at which the child is asked to wrap up. The turn
 * budget cannot see this coming: a child reading large files fills its window
 * long before its turns run out, and Pi's own compaction would then summarize
 * away the evidence it gathered. Steering here leaves room for the report.
 */
export const CONTEXT_WRAP_UP_RATIO = 0.7;
const WRAP_UP_REPORT =
	"Stop calling tools and report your findings now: what you established, what remains unverified, and where you stopped.";
const WRAP_UP_MESSAGE = `Your turn budget is exhausted. ${WRAP_UP_REPORT}`;

interface ProcessSettlement {
	code: number;
	cancelled: boolean;
	budgetExhausted: boolean;
	completed: boolean;
	launchError?: string;
}

interface AssistantEvent {
	type?: string;
	id?: string;
	success?: boolean;
	error?: string;
	toolCallId?: string;
	toolName?: string;
	args?: unknown;
	result?: unknown;
	isError?: boolean;
	toolResults?: unknown[];
	message?: AssistantEventMessage;
}

interface AssistantEventMessage {
	role?: string;
	content?: Array<{ type?: string; text?: string }>;
	stopReason?: string;
	errorMessage?: string;
	usage?: {
		input?: unknown;
		output?: unknown;
		cacheRead?: unknown;
		cacheWrite?: unknown;
		totalTokens?: unknown;
		cost?: { total?: unknown };
	};
}

interface PendingRpcCommand {
	command: string;
	resolve: () => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
	onAccepted?: () => void;
	signal?: AbortSignal;
	onAbort?: () => void;
}

export function resolveTimeoutMs(timeout: number | undefined): number | undefined {
	if (timeout === undefined) return undefined;
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new Error("Invalid timeout: must be a finite number of seconds");
	}
	const timeoutMs = timeout * 1000;
	if (timeoutMs > MAX_TIMEOUT_MS) {
		throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
	}
	return timeoutMs;
}

/** Turn after which the remaining-budget reminder is sent, or undefined for none. */
export function budgetHintTurn(maxTurns: number): number | undefined {
	const hintAt = Math.min(
		Math.floor(maxTurns * BUDGET_HINT_RATIO),
		maxTurns - BUDGET_HINT_MIN_REMAINING,
	);
	return hintAt >= 1 ? hintAt : undefined;
}

export function resolveMaxTurns(maxTurns: number | undefined): number | undefined {
	if (maxTurns === undefined) return undefined;
	if (!Number.isInteger(maxTurns) || maxTurns <= 0) {
		throw new Error("Invalid maxTurns: must be a positive integer");
	}
	return maxTurns;
}

export async function runChild(request: ChildRequest): Promise<ChildResult> {
	if (request.signal.aborted) return cancelledResult();
	try {
		const invocation = resolvePiInvocation(buildPiArgs(request));
		return await executeProcess(invocation, request);
	} catch (error) {
		if (request.signal.aborted) return cancelledResult();
		return {
			state: "failed",
			error: truncateText(error instanceof Error ? error.message : String(error), MAX_ERROR_BYTES)
				.text,
			limitations: [],
			truncated: false,
		};
	}
}

export function buildPiArgs(request: ChildRequest): string[] {
	const args = [
		"--mode",
		"rpc",
		"--no-session",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--model",
		request.model,
		"--thinking",
		request.thinkingLevel,
		request.projectTrusted ? "--approve" : "--no-approve",
	];
	// A child holds only its selected work tools. Nothing is added: the child has
	// no channel back to the parent, so there is no communication tool to grant,
	// and no `subagent_*` tool reaches a child at all.
	args.push("--tools", [...new Set(request.tools)].join(","));
	// The agent definition specializes the child through its system prompt rather
	// than the task, so the task text stays free for the caller's own instructions.
	// The budget goes there too: a child that knows it from the start can pace
	// its exploration instead of learning about it only when it is asked to stop.
	const appended = [request.systemPrompt, budgetInstruction(request)]
		.filter((part): part is string => Boolean(part))
		.join("\n\n");
	if (appended) args.push("--append-system-prompt", appended);
	return args;
}

function budgetInstruction(request: ChildRequest): string | undefined {
	const parts: string[] = [];
	if (request.maxTurns !== undefined) {
		parts.push(
			`You have a budget of ${request.maxTurns} turns for this task, where one turn is one of your responses, with or without tool calls. Pace your exploration so you finish and report well within it. When the budget is reached you will be asked to stop using tools and report what you have; a few turns after that you are stopped.`,
		);
	}
	if (request.contextWindow !== undefined) {
		parts.push(
			`Your context window is also a budget: once it is ${percent(CONTEXT_WRAP_UP_RATIO)}% full you will be asked to stop using tools and report, whatever your turn count. Read narrowly, with line ranges and filtered searches, rather than whole files and unbounded listings.`,
		);
	}
	return parts.length > 0 ? parts.join(" ") : undefined;
}

function percent(ratio: number): number {
	return Math.round(ratio * 100);
}

async function executeProcess(
	invocation: { command: string; args: string[] },
	request: ChildRequest,
): Promise<ChildResult> {
	const maxTurns = resolveMaxTurns(request.maxTurns);
	const hintTurn = maxTurns === undefined ? undefined : budgetHintTurn(maxTurns);
	const contextWindow = request.contextWindow;
	let turns = 0;
	let latestContextTokens = 0;
	// Which bound asked the child to wrap up, and on which turn, so the grace
	// period counts from the request whether it came from turns or context.
	let wrapUp: { reason: "turns" | "context"; turn: number; detail: string } | undefined;
	let latestOutput = "";
	let terminalOutput: string | undefined;
	let terminalStopReason: "stop" | "length" | undefined;
	let errorMessage = "";
	let assistantFailed = false;
	let stderr = "";
	let truncated = false;
	let malformedEvents = 0;
	let rpcCounter = 0;
	const pendingCommands = new Map<string, PendingRpcCommand>();
	let rpcInputError: Error | undefined;
	let transientRetryAttempts = 0;
	let nativeRetryDisabled = false;
	let sendCommand: (
		command:
			| { type: "prompt" | "steer"; message: string }
			| { type: "set_auto_retry"; enabled: boolean },
		onAccepted?: () => void,
		signal?: AbortSignal,
	) => Promise<void> = () => Promise.reject(new Error("Subagent RPC process is unavailable."));
	let onAgentSettled: () => void = () => undefined;
	let onBudgetExhausted: () => void = () => undefined;

	const takePendingCommand = (id: string): PendingRpcCommand | undefined => {
		const pending = pendingCommands.get(id);
		if (!pending) return undefined;
		pendingCommands.delete(id);
		clearTimeout(pending.timer);
		if (pending.signal && pending.onAbort) {
			pending.signal.removeEventListener("abort", pending.onAbort);
		}
		return pending;
	};
	const rejectPendingCommand = (id: string, error: Error) => {
		takePendingCommand(id)?.reject(error);
	};
	const rejectPendingCommands = (error: Error) => {
		for (const id of [...pendingCommands.keys()]) rejectPendingCommand(id, error);
	};
	const resolvePendingCommand = (id: string) => {
		const pending = takePendingCommand(id);
		if (!pending) return;
		try {
			pending.onAccepted?.();
			pending.resolve();
		} catch (error) {
			pending.reject(error instanceof Error ? error : new Error(String(error)));
		}
	};
	const failRpcInput = (error: Error) => {
		rpcInputError ??= error;
		rejectPendingCommands(rpcInputError);
	};
	// A progress observer is a display concern; it must never affect the child's run.
	const reportActivity = (activity: ChildActivity) => {
		try {
			request.onActivity?.(activity);
		} catch {
			// Observers cannot interrupt event decoding.
		}
	};

	const decoder = new JsonLineDecoder(
		(value) => {
			const event = value as AssistantEvent;
			if (event.type === "response" && typeof event.id === "string") {
				const pending = pendingCommands.get(event.id);
				if (!pending) return;
				if (event.success === true) {
					resolvePendingCommand(event.id);
				} else {
					rejectPendingCommand(
						event.id,
						new Error(
							typeof event.error === "string"
								? event.error
								: `Subagent RPC ${pending.command} command failed.`,
						),
					);
				}
				return;
			}
			if (event.type === "auto_retry_start") {
				transientRetryAttempts++;
				return;
			}
			if (event.type === "agent_settled") {
				onAgentSettled();
				return;
			}
			// A turn is one model response. Reaching the budget asks the child to
			// wrap up rather than killing it, so the knowledge it gathered comes back
			// as a report; only a child that keeps going past the grace is stopped.
			if (event.type === "turn_end") {
				turns++;
				reportActivity({ type: "turn", turns });
				// A turn without tool calls is the child's final report: it settles on
				// its own, so neither a wrap-up request nor a stop applies.
				const failedTurn =
					event.message?.stopReason === "error" || event.message?.stopReason === "aborted";
				const finishing =
					Array.isArray(event.toolResults) && event.toolResults.length === 0 && !failedTurn;
				// Failed model calls consume turns, but retry policy owns their next action.
				// Applying the wrap-up steer here would suppress the transient retry.
				if (finishing || failedTurn) return;
				if (wrapUp) {
					if (turns >= wrapUp.turn + BUDGET_GRACE_TURNS) onBudgetExhausted();
					return;
				}
				// Context is checked first: it is the bound the turn budget cannot see.
				if (
					contextWindow !== undefined &&
					latestContextTokens >= contextWindow * CONTEXT_WRAP_UP_RATIO
				) {
					const filled = percent(latestContextTokens / contextWindow);
					wrapUp = { reason: "context", turn: turns, detail: `${filled}% of its context window` };
					reportActivity({
						type: "notice",
						text: `Context ${filled}% full (${latestContextTokens}/${contextWindow} tokens); asked the child to wrap up.`,
					});
					// Best effort: a failed steer still leaves the grace-turn stop in place.
					void sendCommand({
						type: "steer",
						message: `Your context window is ${filled}% full. ${WRAP_UP_REPORT}`,
					}).catch(() => undefined);
					return;
				}
				if (maxTurns === undefined) return;
				if (turns === hintTurn) {
					const remaining = maxTurns - turns;
					reportActivity({
						type: "notice",
						text: `${turns}/${maxTurns} turns used; reminded the child that ${remaining} remain.`,
					});
					void sendCommand({
						type: "steer",
						message: `You have used ${turns} of your ${maxTurns} turns; ${remaining} remain. Finish the thread you are on and start converging on your report.`,
					}).catch(() => undefined);
				} else if (turns >= maxTurns) {
					wrapUp = { reason: "turns", turn: turns, detail: `its turn budget of ${maxTurns}` };
					reportActivity({
						type: "notice",
						text: `Turn budget of ${maxTurns} reached; asked the child to wrap up.`,
					});
					// Best effort: a failed steer still leaves the grace-turn stop in place.
					void sendCommand({ type: "steer", message: WRAP_UP_MESSAGE }).catch(() => undefined);
				}
				return;
			}
			// Tool activity is forwarded for inspection only and never affects the
			// result. `tool_execution_update` is skipped: partial results arrive per
			// chunk and would flood the log without saying anything new.
			if (event.type === "tool_execution_start") {
				if (typeof event.toolCallId === "string" && typeof event.toolName === "string") {
					reportActivity({
						type: "tool_start",
						toolCallId: event.toolCallId,
						tool: event.toolName,
						args: event.args,
					});
				}
				return;
			}
			if (event.type === "tool_execution_end") {
				if (typeof event.toolCallId === "string" && typeof event.toolName === "string") {
					reportActivity({
						type: "tool_end",
						toolCallId: event.toolCallId,
						tool: event.toolName,
						result: event.result,
						isError: event.isError === true,
					});
				}
				return;
			}
			if (event.type === "message_end" && event.message?.role === "assistant") {
				const usage = readUsage(event.message);
				if (usage) {
					reportActivity({ type: "usage", usage });
					if (usage.contextTokens !== undefined) latestContextTokens = usage.contextTokens;
				}
				const text = (event.message.content ?? [])
					.filter((part) => part.type === "text" && typeof part.text === "string")
					.map((part) => part.text)
					.join("\n")
					.trim();
				if (text) {
					const limited = truncateText(text, MAX_OUTPUT_BYTES);
					latestOutput = limited.text;
					truncated ||= limited.truncated;
					// Only the text parts are forwarded, so thinking never reaches a display.
					reportActivity({ type: "output", text });
					if (event.message.stopReason === "stop" || event.message.stopReason === "length") {
						terminalOutput = limited.text;
						terminalStopReason = event.message.stopReason;
					}
				}
				if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
					assistantFailed = true;
					if (event.message.errorMessage) {
						const limited = truncateText(event.message.errorMessage, MAX_ERROR_BYTES);
						errorMessage = limited.text;
						truncated ||= limited.truncated;
					} else {
						errorMessage = "";
					}
				} else {
					// Pi retains failed assistant messages during native retries. A later
					// successful message is authoritative and starts a fresh retry budget.
					assistantFailed = false;
					errorMessage = "";
					transientRetryAttempts = 0;
				}
			}
		},
		() => {
			malformedEvents++;
		},
	);

	const settlement = await new Promise<ProcessSettlement>((resolve) => {
		let process: ChildProcess;
		let settled = false;
		let finishRequested = false;
		let spawned = false;
		let terminating = false;
		let cancelled = false;
		let budgetExhausted = false;
		let completed = false;
		let ready = false;
		let retryWaiting = false;
		let forceClose: NodeJS.Timeout | undefined;
		let escalation: NodeJS.Timeout | undefined;
		let termination: Promise<void> | undefined;

		const finish = (code: number, launchError?: string) => {
			if (settled || finishRequested) return;
			finishRequested = true;
			const complete = () => {
				if (settled) return;
				settled = true;
				if (forceClose) clearTimeout(forceClose);
				if (escalation) clearTimeout(escalation);
				request.signal.removeEventListener("abort", onAbort);
				rejectPendingCommands(new Error("Subagent RPC process closed."));
				resolve({ code, cancelled, budgetExhausted, completed, launchError });
			};
			if (termination) void termination.then(complete, complete);
			else complete();
		};
		const terminate = (code: number) => {
			if (settled || terminating) return;
			terminating = true;
			if (globalThis.process.platform === "win32") {
				termination = terminateWindowsProcessTree(process);
			} else {
				signalPosixProcess(process, "SIGTERM");
				escalation = setTimeout(() => signalPosixProcess(process, "SIGKILL"), KILL_GRACE_MS);
				escalation.unref();
			}
			forceClose = setTimeout(() => {
				decoder.finish();
				process.stdin?.destroy();
				process.stdout?.destroy();
				process.stderr?.destroy();
				finish(code);
			}, KILL_GRACE_MS * 2);
			forceClose.unref();
		};
		const onAbort = () => {
			if (settled) return;
			cancelled = true;
			terminate(130);
		};
		const completeNormally = () => {
			if (settled || terminating || !ready) return;
			completed = true;
			terminate(0);
		};
		onAgentSettled = () => {
			if (retryWaiting) return;
			if (settled || terminating || wrapUp || !assistantFailed || !errorMessage) {
				completeNormally();
				return;
			}
			if (!isTransientAssistantError(errorMessage)) {
				completeNormally();
				return;
			}
			if (transientRetryAttempts >= MAX_TRANSIENT_RETRIES) {
				completeNormally();
				return;
			}

			const retryAttempt = ++transientRetryAttempts;
			retryWaiting = true;
			const delayMs = RETRY_BASE_DELAY_MS * 2 ** (retryAttempt - 1);
			reportActivity({
				type: "notice",
				text: `Transient child model failure; continuing after ${delayMs / 1000}s backoff (retry ${retryAttempt}/${MAX_TRANSIENT_RETRIES}).`,
			});
			void (async () => {
				try {
					await abortableDelay(delayMs, request.signal);
					if (settled || terminating || request.signal.aborted) return;
					// Pi already spent any native attempts reported before agent_settled.
					// Disable a fresh native budget before our continuation so both layers
					// cannot exceed MAX_TRANSIENT_RETRIES together.
					if (!nativeRetryDisabled) {
						await sendCommand(
							{ type: "set_auto_retry", enabled: false },
							undefined,
							request.signal,
						);
						nativeRetryDisabled = true;
					}
					if (settled || terminating || request.signal.aborted) return;
					await sendCommand(
						{ type: "prompt", message: CONTINUE_AFTER_TRANSIENT_FAILURE_MESSAGE },
						() => {
							if (settled || terminating || request.signal.aborted) {
								throw new Error("Subagent retry prompt was superseded.");
							}
							// RPC may deliver the acceptance and settled events in one stdout
							// chunk, so reopen settlement synchronously at acceptance.
							retryWaiting = false;
						},
						request.signal,
					);
				} catch (error) {
					if (settled || terminating || request.signal.aborted) return;
					retryWaiting = false;
					const limited = truncateText(
						error instanceof Error ? error.message : String(error),
						MAX_ERROR_BYTES,
					);
					errorMessage = limited.text;
					truncated ||= limited.truncated;
					terminate(1);
				}
			})();
		};
		onBudgetExhausted = () => {
			if (settled || terminating) return;
			budgetExhausted = true;
			terminate(124);
		};

		try {
			process = spawn(invocation.command, invocation.args, {
				cwd: request.cwd,
				detached: globalThis.process.platform !== "win32",
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
				env: {
					...globalThis.process.env,
					PI_SUBAGENT_DEPTH: String(
						(Number.parseInt(globalThis.process.env.PI_SUBAGENT_DEPTH ?? "0", 10) || 0) + 1,
					),
				},
			});
		} catch (error) {
			finish(1, error instanceof Error ? error.message : String(error));
			return;
		}

		process.stdin?.on("error", failRpcInput);
		sendCommand = (command, onAccepted, signal) => {
			if (settled || terminating || process.exitCode !== null) {
				return Promise.reject(new Error("Subagent RPC process is no longer active."));
			}
			if (signal?.aborted) {
				return Promise.reject(abortError("Subagent RPC command was cancelled."));
			}
			if (rpcInputError) return Promise.reject(rpcInputError);
			const stdin = process.stdin;
			if (!stdin || stdin.destroyed || !stdin.writable) {
				return Promise.reject(new Error("Subagent RPC stdin is unavailable."));
			}
			const id = `rpc_${++rpcCounter}`;
			return new Promise<void>((resolveCommand, rejectCommand) => {
				const timer = setTimeout(
					() =>
						rejectPendingCommand(id, new Error(`Subagent RPC ${command.type} response timed out.`)),
					RPC_RESPONSE_TIMEOUT_MS,
				);
				timer.unref();
				const pending: PendingRpcCommand = {
					command: command.type,
					resolve: resolveCommand,
					reject: rejectCommand,
					timer,
					onAccepted,
					signal,
				};
				if (signal) {
					pending.onAbort = () =>
						rejectPendingCommand(id, abortError("Subagent RPC command was cancelled."));
				}
				pendingCommands.set(id, pending);
				if (signal && pending.onAbort) {
					signal.addEventListener("abort", pending.onAbort, { once: true });
					if (signal.aborted) {
						pending.onAbort();
						return;
					}
				}
				try {
					stdin.write(`${JSON.stringify({ id, ...command })}\n`, (error) => {
						if (error) failRpcInput(error);
					});
				} catch (error) {
					failRpcInput(error instanceof Error ? error : new Error(String(error)));
				}
			});
		};

		request.signal.addEventListener("abort", onAbort, { once: true });
		if (request.signal.aborted) onAbort();
		process.once("spawn", () => {
			spawned = true;
			if (settled || cancelled) return;
			void sendCommand(
				{ type: "prompt", message: `Task: ${request.task}` },
				() => {
					if (settled || terminating || request.signal.aborted) {
						throw new Error("Subagent RPC prompt was superseded.");
					}
					ready = true;
					try {
						request.onReady?.();
					} catch {
						// Observers cannot interrupt the child's lifecycle.
					}
				},
				request.signal,
			).catch((error) => {
				if (settled || terminating) return;
				errorMessage = truncateText(
					error instanceof Error ? error.message : String(error),
					MAX_ERROR_BYTES,
				).text;
				terminate(1);
			});
		});
		process.stdout?.on("data", (chunk) => decoder.push(chunk));
		process.stderr?.on("data", (chunk) => {
			const limited = truncateTail(`${stderr}${chunk.toString()}`, MAX_ERROR_BYTES);
			stderr = limited.text;
			truncated ||= limited.truncated;
		});
		process.once("close", (code) => {
			decoder.finish();
			finish(cancelled ? 130 : budgetExhausted ? 124 : completed ? 0 : (code ?? 1));
		});
		process.once("error", (error) => {
			const limited = truncateText(error.message, MAX_ERROR_BYTES);
			errorMessage = limited.text;
			truncated ||= limited.truncated;
			if (spawned) terminate(1);
			else finish(1, error.message);
		});
	});

	const output = terminalOutput ?? latestOutput;
	const limitations =
		malformedEvents > 0
			? [`Ignored ${malformedEvents} malformed or oversized child event(s).`]
			: [];
	if (truncated) limitations.push("Child output was truncated to runtime limits.");
	if (terminalStopReason === "length") {
		limitations.push("Child output ended at the model output limit and may be incomplete.");
	}
	if (wrapUp && !settlement.budgetExhausted) {
		limitations.push(
			`Child reached ${wrapUp.detail} and was asked to wrap up; the result may be incomplete.`,
		);
	}
	if (settlement.cancelled) return cancelledResult(output, limitations, truncated);
	if (settlement.budgetExhausted) {
		return {
			state: "budget_exhausted",
			...(output ? { result: output } : {}),
			error: `Subagent exhausted ${wrapUp?.detail ?? "its budget"} without wrapping up.`,
			limitations,
			truncated,
		};
	}
	const error = settlement.launchError || errorMessage || stderr.trim();
	if (settlement.completed && terminalStopReason === "stop" && !assistantFailed && !errorMessage) {
		return {
			state: "completed",
			result: terminalOutput,
			limitations,
			truncated,
		};
	}
	const failure =
		error ||
		(terminalStopReason === "length"
			? "Subagent output reached the model limit."
			: assistantFailed
				? "Subagent model turn failed."
				: settlement.completed
					? "Subagent settled without a terminal assistant result."
					: settlement.code === 0
						? "Subagent exited without settling."
						: `Subagent exited with code ${settlement.code}.`);
	if (output) {
		return {
			state: "partial",
			result: output,
			error: failure,
			limitations,
			truncated,
		};
	}
	return {
		state: "failed",
		error: failure,
		limitations,
		truncated,
	};
}

function resolvePiInvocation(args: string[]): { command: string; args: string[] } {
	const packageDirectory = fs.realpathSync(getPackageDir());
	const manifestPath = path.join(packageDirectory, "package.json");
	let manifest: { name?: string; bin?: { pi?: string } };
	try {
		manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	} catch (error) {
		throw new Error(
			`Could not read the Pi core package manifest: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (manifest.name !== CORE_PACKAGE_NAME || typeof manifest.bin?.pi !== "string") {
		throw new Error("Loaded Pi core package does not declare a valid bin.pi entry.");
	}
	const declared = manifest.bin.pi;
	if (path.isAbsolute(declared)) throw new Error("Pi core bin.pi must be package-relative.");
	if (
		globalThis.process.versions.bun &&
		/^pi(?:\.exe)?$/iu.test(path.basename(globalThis.process.execPath)) &&
		path.dirname(fs.realpathSync(globalThis.process.execPath)) === packageDirectory
	) {
		return { command: globalThis.process.execPath, args };
	}
	const cliPath = fs.realpathSync(path.resolve(packageDirectory, declared));
	const relative = path.relative(packageDirectory, cliPath);
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error("Pi core bin.pi escapes its package directory.");
	}
	if (!fs.statSync(cliPath).isFile()) throw new Error("Pi core bin.pi is not a file.");
	return { command: globalThis.process.execPath, args: [cliPath, ...args] };
}

function signalPosixProcess(process: ChildProcess, signal: NodeJS.Signals): void {
	if (process.pid) {
		try {
			globalThis.process.kill(-process.pid, signal);
			return;
		} catch {
			// Fall back to the immediate child.
		}
	}
	try {
		process.kill(signal);
	} catch {
		// The process may already be terminal.
	}
}

export function terminateWindowsProcessTree(
	process: ChildProcess,
	spawnProcess: typeof spawn = spawn,
	taskkillPath = resolveTaskkillPath(),
	helperTimeoutMs = KILL_GRACE_MS,
): Promise<void> {
	if (!process.pid || !taskkillPath) {
		killImmediateChild(process);
		return Promise.resolve();
	}
	return new Promise((resolve) => {
		let settled = false;
		let treeKiller: ChildProcess;
		let deadline: NodeJS.Timeout | undefined;
		const onError = () => finish(true, false);
		const onClose = (code: number | null) => finish(code !== 0, false);
		const finish = (fallback: boolean, terminateHelper: boolean) => {
			if (settled) return;
			settled = true;
			if (deadline) clearTimeout(deadline);
			treeKiller.removeListener("error", onError);
			treeKiller.removeListener("close", onClose);
			if (terminateHelper) killImmediateChild(treeKiller);
			if (fallback) killImmediateChild(process);
			resolve();
		};
		try {
			treeKiller = spawnProcess(taskkillPath, ["/PID", String(process.pid), "/T", "/F"], {
				stdio: "ignore",
				windowsHide: true,
			});
		} catch {
			killImmediateChild(process);
			resolve();
			return;
		}
		treeKiller.once("error", onError);
		treeKiller.once("close", onClose);
		deadline = setTimeout(() => finish(true, true), helperTimeoutMs);
		deadline.unref();
	});
}

function resolveTaskkillPath(): string | undefined {
	const systemRoot = globalThis.process.env.SystemRoot ?? globalThis.process.env.WINDIR;
	if (!systemRoot || !path.win32.isAbsolute(systemRoot)) return undefined;
	return path.win32.join(systemRoot, "System32", "taskkill.exe");
}

function killImmediateChild(process: ChildProcess): void {
	try {
		process.kill("SIGKILL");
	} catch {
		// The process may already be terminal.
	}
}

function isTransientAssistantError(errorMessage: string): boolean {
	const assistantError = {
		stopReason: "error",
		errorMessage,
	} as AssistantMessage;
	return (
		isRetryableAssistantError(assistantError) || PREMATURE_STREAM_ERROR_PATTERN.test(errorMessage)
	);
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(abortError("Subagent retry was cancelled."));
			return;
		}
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, delayMs);
		timer.unref();
		const onAbort = () => {
			clearTimeout(timer);
			reject(abortError("Subagent retry was cancelled."));
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

function abortError(message: string): Error {
	const error = new Error(message);
	error.name = "AbortError";
	return error;
}

function cancelledResult(
	result?: string,
	limitations: string[] = [],
	truncated = false,
): ChildResult {
	return {
		state: "cancelled",
		...(result ? { result } : {}),
		error: "Subagent execution was cancelled.",
		limitations,
		truncated,
	};
}

/**
 * Read one response's token accounting.
 *
 * Context size follows Pi core: `totalTokens` wins over the component sum, and a
 * response that was aborted or failed reports none, because its usage does not
 * describe the conversation the child will send next. The cumulative fields are
 * read from every response, failed ones included, since they were still billed.
 */
function readUsage(message: AssistantEventMessage): ChildUsage | undefined {
	const usage = message.usage;
	if (!usage) return undefined;
	const input = tokenCount(usage.input);
	const output = tokenCount(usage.output);
	const cacheRead = tokenCount(usage.cacheRead);
	const cacheWrite = tokenCount(usage.cacheWrite);
	const failed = message.stopReason === "error" || message.stopReason === "aborted";
	const contextTokens = tokenCount(usage.totalTokens) || input + output + cacheRead + cacheWrite;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		...(failed || contextTokens <= 0 ? {} : { contextTokens }),
		cost: tokenCount(usage.cost?.total),
	};
}

/** Child stdout is untrusted, so a missing or nonsensical count reads as zero. */
function tokenCount(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function truncateText(text: string, maxBytes: number): { text: string; truncated: boolean } {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= maxBytes) return { text, truncated: false };
	return {
		text: `${bytes
			.subarray(0, Math.max(0, maxBytes - 18))
			.toString("utf8")
			.replace(/�+$/gu, "")}\n… [truncated]`,
		truncated: true,
	};
}

function truncateTail(text: string, maxBytes: number): { text: string; truncated: boolean } {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= maxBytes) return { text, truncated: false };
	return {
		text: `… [truncated]\n${bytes
			.subarray(bytes.length - Math.max(0, maxBytes - 18))
			.toString("utf8")
			.replace(/^�+/gu, "")}`,
		truncated: true,
	};
}

class JsonLineDecoder {
	private buffer = "";
	private dropping = false;
	private readonly decoder = new StringDecoder("utf8");

	constructor(
		private readonly onValue: (value: unknown) => void,
		private readonly onMalformed: () => void,
	) {}

	push(chunk: Buffer | string): void {
		this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
		this.drain(false);
	}

	finish(): void {
		this.buffer += this.decoder.end();
		this.drain(true);
		this.buffer = "";
		this.dropping = false;
	}

	private drain(flush: boolean): void {
		while (true) {
			const newline = this.buffer.indexOf("\n");
			if (newline < 0) break;
			const line = this.buffer.slice(0, newline).replace(/\r$/u, "");
			this.buffer = this.buffer.slice(newline + 1);
			if (this.dropping) {
				this.dropping = false;
				continue;
			}
			this.parse(line);
		}
		if (!flush && Buffer.byteLength(this.buffer, "utf8") > MAX_EVENT_LINE_BYTES) {
			this.onMalformed();
			this.buffer = "";
			this.dropping = true;
		}
		if (flush && this.buffer && !this.dropping) this.parse(this.buffer.replace(/\r$/u, ""));
	}

	private parse(line: string): void {
		if (!line.trim()) return;
		if (Buffer.byteLength(line, "utf8") > MAX_EVENT_LINE_BYTES) {
			this.onMalformed();
			return;
		}
		try {
			this.onValue(JSON.parse(line));
		} catch {
			this.onMalformed();
		}
	}
}
