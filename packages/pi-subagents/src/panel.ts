import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ActivityEvent } from "./activity.js";
import type { PanelJob, SubagentRuntime } from "./runtime.js";
import { sanitizeTerminalText } from "./text.js";
import { TERMINAL_JOB_STATES } from "./types.js";

/** Panel repaint cadence, matching the active-jobs widget. */
export const PANEL_REFRESH_INTERVAL_MS = 1_000;
/** Rows the job list may occupy before it scrolls. */
const MAX_LIST_ROWS = 8;
const MIN_ACTIVITY_ROWS = 3;

/** Keys the panel handles. Everything else is ignored so it cannot be typed into. */
const KEY_UP = "\u001b[A";
const KEY_DOWN = "\u001b[B";
const KEY_ESCAPE = "\u001b";
const KEY_CTRL_C = "\u0003";

type PanelExit = { kill?: string };

/**
 * Register `/subagents`.
 *
 * The command is the only entry point, so the panel is discoverable through the
 * command list and takes no keybinding the user may already have bound. It opens
 * an overlay that holds focus: the panel is a read-and-act surface, and typing
 * into the editor underneath while reading a live log would serve nobody.
 */
export function registerSubagentsPanelCommand(runtime: SubagentRuntime): {
	name: string;
	options: {
		description: string;
		handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
	};
} {
	return {
		name: "subagents",
		options: {
			description: "Inspect running subagent jobs and terminate one",
			handler: async (_args, ctx) => {
				await openSubagentsPanel(runtime, ctx);
			},
		},
	};
}

/**
 * Show the panel, then act on what the human chose.
 *
 * Termination is confirmed outside the overlay rather than inside it, because a
 * confirmation rendered by the panel it is about would have to re-implement
 * focus and dismissal that `ctx.ui.confirm` already gets right.
 */
export async function openSubagentsPanel(
	runtime: SubagentRuntime,
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("The subagents panel requires interactive mode.", "warning");
		return;
	}
	const exit = await ctx.ui.custom<PanelExit>(
		(tui, theme, _keybindings, done) => createPanelComponent(runtime, tui, theme, done),
		{
			overlay: true,
			overlayOptions: { width: "80%", minWidth: 48, maxHeight: "80%", anchor: "center" },
		},
	);
	const jobId = exit.kill;
	if (jobId === undefined) return;
	const job = runtime.panelJobs().find((candidate) => candidate.jobId === jobId);
	if (!job || TERMINAL_JOB_STATES.has(job.state)) {
		ctx.ui.notify(`Subagent job ${jobId} is no longer active.`, "warning");
		return;
	}
	const confirmed = await ctx.ui.confirm(
		"Terminate subagent",
		[
			`Terminate ${jobLabel(job)}?`,
			"",
			"Its child process and timer are released.",
			"File changes it already made are kept and are not rolled back.",
			"Other jobs are unaffected.",
		].join("\n"),
	);
	if (!confirmed) return;
	try {
		const result = await runtime.cancel(jobId, "user");
		ctx.ui.notify(`Subagent job ${jobId} ${result.state}.`, "info");
	} catch (error) {
		ctx.ui.notify(
			`Could not terminate ${jobId}: ${error instanceof Error ? error.message : String(error)}`,
			"error",
		);
	}
}

export interface PanelComponent {
	render(width: number): string[];
	/** Required by the TUI component contract; the panel renders from live state. */
	invalidate(): void;
	handleInput(data: string): void;
	dispose(): void;
}

/**
 * Build the overlay component.
 *
 * Selection follows a job id rather than a list index, so a job finishing or
 * being pruned while the panel is open cannot silently move the cursor onto a
 * different job than the one the reader was looking at.
 */
export function createPanelComponent(
	runtime: SubagentRuntime,
	tui: { requestRender(): void },
	theme: Theme,
	done: (result: PanelExit) => void,
): PanelComponent {
	let selectedJobId: string | undefined;
	let finished = false;
	let unsubscribe: () => void = () => undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	// `dispose` runs only when the panel closes itself, so a session torn down
	// underneath an open overlay would otherwise leave the timer and the
	// subscription behind. Teardown is therefore idempotent and also reachable
	// from the refresh itself, which notices the session is gone.
	const teardown = () => {
		finished = true;
		if (timer) clearInterval(timer);
		timer = undefined;
		unsubscribe();
		unsubscribe = () => undefined;
	};
	const repaint = () => {
		if (finished) return;
		if (!runtime.isSessionActive()) {
			teardown();
			return;
		}
		tui.requestRender();
	};
	unsubscribe = runtime.subscribeJobs(repaint);
	timer = setInterval(repaint, PANEL_REFRESH_INTERVAL_MS);
	timer.unref();
	const finish = (result: PanelExit) => {
		if (finished) return;
		teardown();
		done(result);
	};

	return {
		invalidate() {},
		render(width) {
			const jobs = runtime.panelJobs();
			// Prefer the first active job on open, so the panel lands on live work.
			if (selectedJobId === undefined || !jobs.some((job) => job.jobId === selectedJobId)) {
				selectedJobId =
					jobs.find((job) => !TERMINAL_JOB_STATES.has(job.state))?.jobId ?? jobs.at(-1)?.jobId;
			}
			return renderPanel(jobs, selectedJobId, theme, width);
		},
		handleInput(data) {
			if (data === KEY_ESCAPE || data === KEY_CTRL_C) {
				finish({});
				return;
			}
			const jobs = runtime.panelJobs();
			if (jobs.length === 0) return;
			if (data === KEY_UP || data === KEY_DOWN) {
				const index = jobs.findIndex((job) => job.jobId === selectedJobId);
				const next = Math.min(
					jobs.length - 1,
					Math.max(0, (index < 0 ? 0 : index) + (data === KEY_DOWN ? 1 : -1)),
				);
				selectedJobId = jobs[next]?.jobId;
				repaint();
				return;
			}
			if (data === "k" || data === "K") {
				const job = jobs.find((candidate) => candidate.jobId === selectedJobId);
				// Only an active job is offered for termination; a terminal one has
				// nothing left to release.
				if (job && !TERMINAL_JOB_STATES.has(job.state)) finish({ kill: job.jobId });
			}
		},
		dispose() {
			teardown();
		},
	};
}

export function renderPanel(
	jobs: readonly PanelJob[],
	selectedJobId: string | undefined,
	theme: Theme,
	width: number,
): string[] {
	const renderWidth = Math.max(24, width);
	const active = jobs.filter((job) => !TERMINAL_JOB_STATES.has(job.state)).length;
	const lines: string[] = [
		heading(`Subagents · ${active} active · ${jobs.length} retained`, theme, renderWidth),
	];
	if (jobs.length === 0) {
		lines.push(theme.fg("muted", "  No subagent jobs in this session."));
	} else {
		lines.push(...renderJobList(jobs, selectedJobId, theme));
	}
	const selected = jobs.find((job) => job.jobId === selectedJobId);
	if (selected) {
		lines.push(heading(detailTitle(selected), theme, renderWidth));
		lines.push(...renderActivity(selected, theme));
	}
	lines.push(
		theme.fg("borderMuted", "─".repeat(renderWidth)),
		theme.fg("muted", keyHint(selected)),
	);
	return lines.map((line) => truncateToWidth(line, renderWidth, "…"));
}

function keyHint(selected: PanelJob | undefined): string {
	const killable = selected !== undefined && !TERMINAL_JOB_STATES.has(selected.state);
	return `  ↑↓ select   ${killable ? "k terminate" : "k terminate (inactive)"}   esc close`;
}

function heading(title: string, theme: Theme, width: number): string {
	const label = ` ${sanitizeLabel(title)} `;
	const rule = Math.max(0, width - label.length - 2);
	return `${theme.fg("borderMuted", "──")}${theme.fg("accent", label)}${theme.fg("borderMuted", "─".repeat(rule))}`;
}

/**
 * Render the job list, scrolled to keep the selection visible.
 *
 * The panel shows terminal jobs alongside active ones so a cancelled or failed
 * child can still be reviewed, which is the reason the record is kept at all.
 */
function renderJobList(
	jobs: readonly PanelJob[],
	selectedJobId: string | undefined,
	theme: Theme,
): string[] {
	const index = Math.max(
		0,
		jobs.findIndex((job) => job.jobId === selectedJobId),
	);
	const start = Math.min(
		Math.max(0, index - Math.floor(MAX_LIST_ROWS / 2)),
		Math.max(0, jobs.length - MAX_LIST_ROWS),
	);
	const visible = jobs.slice(start, start + MAX_LIST_ROWS);
	const lines = visible.map((job) => renderJobRow(job, job.jobId === selectedJobId, theme));
	const hidden = jobs.length - visible.length;
	if (hidden > 0) lines.push(theme.fg("dim", `  … ${hidden} more job(s)`));
	return lines;
}

function renderJobRow(job: PanelJob, selected: boolean, theme: Theme): string {
	const cursor = selected ? theme.fg("accent", "❯ ") : "  ";
	const symbol = theme.fg(stateColor(job.state), `${stateSymbol(job.state)} `);
	const title = sanitizeLabel(jobTitle(job)).padEnd(14).slice(0, 14);
	const description = sanitizeLabel(job.description ?? "")
		.padEnd(26)
		.slice(0, 26);
	const state = job.state.padEnd(9);
	const elapsed = formatDuration(job.elapsedMs);
	return (
		`${cursor}${symbol}${theme.fg(selected ? "text" : "muted", title)} ` +
		`${theme.fg("muted", description)} ` +
		`${theme.fg(stateColor(job.state), state)} ${theme.fg("dim", elapsed)}`
	);
}

function detailTitle(job: PanelJob): string {
	const tools = job.tools.length > 0 ? job.tools.join(",") : "none";
	const timeout = job.timeout === undefined ? "no timeout" : `${job.timeout}s timeout`;
	return `${jobTitle(job)} · ${job.jobId} · tools: ${tools} · ${timeout}`;
}

/**
 * Render the selected job's activity, newest last.
 *
 * The tail is shown rather than the head: a reader opening the panel wants to
 * know what the child is doing now, and the eviction notice above it makes the
 * bounded retention explicit instead of letting the log look complete.
 */
function renderActivity(job: PanelJob, theme: Theme): string[] {
	const lines: string[] = [];
	if (job.droppedEvents > 0) {
		lines.push(theme.fg("dim", `  … ${job.droppedEvents} earlier event(s) dropped`));
	}
	const visible = job.activity.slice(-Math.max(MIN_ACTIVITY_ROWS, 12));
	if (visible.length === 0) {
		lines.push(
			theme.fg(
				"muted",
				TERMINAL_JOB_STATES.has(job.state)
					? "  No activity recorded."
					: "  Waiting for the child to start…",
			),
		);
	} else {
		lines.push(...visible.map((event) => renderActivityEvent(event, theme)));
	}
	if (job.error) lines.push(theme.fg("error", `  error: ${sanitizeLabel(job.error)}`));
	for (const limitation of job.limitations) {
		lines.push(theme.fg("warning", `  note: ${sanitizeLabel(limitation)}`));
	}
	return lines;
}

function renderActivityEvent(event: ActivityEvent, theme: Theme): string {
	const at = theme.fg("dim", formatClock(event.at));
	if (event.kind === "output") {
		return `  ${at} ${theme.fg("accent", "say ")}   ${theme.fg("text", event.detail)}`;
	}
	if (event.kind === "notice") {
		return `  ${at} ${theme.fg("muted", "note")}   ${theme.fg("muted", event.detail)}`;
	}
	const tool = theme.fg("toolTitle", (event.tool ?? "tool").padEnd(4).slice(0, 8));
	const outcome =
		event.outcome === undefined
			? theme.fg("dim", " …")
			: event.outcome === "error"
				? theme.fg("error", " ✗")
				: theme.fg("success", " ✓");
	const result = event.result ? theme.fg("toolOutput", ` → ${event.result}`) : "";
	return `  ${at} ${tool}${outcome} ${theme.fg("muted", event.detail)}${result}`;
}

function jobTitle(job: PanelJob): string {
	return job.agent && job.agent !== "" ? job.agent : job.jobId;
}

function jobLabel(job: PanelJob): string {
	const description = job.description ? ` — ${job.description}` : "";
	return `${jobTitle(job)} (${job.jobId})${description}`;
}

function stateSymbol(state: PanelJob["state"]): string {
	switch (state) {
		case "running":
			return "▶";
		case "queued":
			return "○";
		case "completed":
			return "✓";
		case "partial":
			return "◐";
		default:
			return "✗";
	}
}

function stateColor(
	state: PanelJob["state"],
): "accent" | "success" | "warning" | "error" | "muted" {
	switch (state) {
		case "running":
			return "accent";
		case "queued":
			return "muted";
		case "completed":
			return "success";
		case "partial":
			return "warning";
		default:
			return "error";
	}
}

function sanitizeLabel(value: string): string {
	return sanitizeTerminalText(value).replace(/\s+/gu, " ").trim();
}

function formatClock(at: number): string {
	const date = new Date(at);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatDuration(elapsedMs: number): string {
	const seconds = Math.max(0, Math.floor(elapsedMs / 1_000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}
