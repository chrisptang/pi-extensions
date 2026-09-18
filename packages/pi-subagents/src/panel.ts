import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	Key,
	type KeybindingsManager,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { ActivityEvent } from "./activity.js";
import type { PanelJob, SubagentRuntime } from "./runtime.js";
import { formatDuration, sanitizeTerminalText } from "./text.js";
import { TERMINAL_JOB_STATES } from "./types.js";

/** Panel repaint cadence, matching the active-jobs widget. */
export const PANEL_REFRESH_INTERVAL_MS = 1_000;
/** Share of the terminal the overlay may occupy; mirrors `overlayOptions.maxHeight`. */
const OVERLAY_HEIGHT_RATIO = 0.8;
/** Rows the panel never shrinks below, so a tiny terminal still shows something. */
const MIN_BODY_ROWS = 3;
/** Widest the agent-name column grows before it is truncated. */
const MAX_NAME_COLUMNS = 16;
/** Frame glyphs: `│ ` on the left and ` │` on the right. */
const FRAME_COLUMNS = 4;
/** Width of the tool-name column in the activity log; longer names are truncated. */
const TOOL_COLUMNS = 6;

type PanelExit = { kill?: string };
type PanelView = "list" | "detail";
/** A footer hint: the key, then what it does. */
type Hint = readonly [key: string, description: string];

/** The slice of the TUI the panel needs: repaints and the terminal height. */
export interface PanelTui {
	requestRender(): void;
	terminal: { rows: number };
}

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
		(tui, theme, keybindings, done) => createPanelComponent(runtime, tui, theme, keybindings, done),
		{
			overlay: true,
			overlayOptions: {
				width: "80%",
				minWidth: 48,
				maxHeight: `${OVERLAY_HEIGHT_RATIO * 100}%`,
				anchor: "center",
			},
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
 * The panel has two views: a job list, and the selected job's activity log
 * opened with Enter. Selection follows a job id rather than a list index, so a
 * job finishing or being pruned while the panel is open cannot silently move
 * the cursor onto a different job than the one the reader was looking at.
 *
 * Keys are matched through Pi's keybindings and `matchesKey` rather than raw
 * escape sequences, so they work under the Kitty keyboard protocol too.
 */
export function createPanelComponent(
	runtime: SubagentRuntime,
	tui: PanelTui,
	theme: Theme,
	keybindings: KeybindingsManager,
	done: (result: PanelExit) => void,
): PanelComponent {
	let view: PanelView = "list";
	let selectedJobId: string | undefined;
	// Detail scroll position. `undefined` follows the newest event, which is
	// what a reader opening a live log wants; scrolling up pins the offset until
	// the reader scrolls back to the end.
	let scrollTop: number | undefined;
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
	const bodyRows = () => panelBodyRows(tui.terminal.rows);
	const selectJob = (jobs: readonly PanelJob[], index: number) => {
		selectedJobId = jobs[Math.min(jobs.length - 1, Math.max(0, index))]?.jobId;
		scrollTop = undefined;
	};
	const terminateSelected = (jobs: readonly PanelJob[]) => {
		const job = jobs.find((candidate) => candidate.jobId === selectedJobId);
		// Only an active job is offered for termination; a terminal one has
		// nothing left to release.
		if (job && !TERMINAL_JOB_STATES.has(job.state)) finish({ kill: job.jobId });
	};
	const scrollDetail = (job: PanelJob, delta: number) => {
		const total = detailLogLines(job, theme).length;
		const maxTop = Math.max(0, total - detailLogRows(bodyRows(), job));
		const current = scrollTop ?? maxTop;
		const next = Math.min(maxTop, Math.max(0, current + delta));
		scrollTop = next >= maxTop ? undefined : next;
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
			const selected = jobs.find((job) => job.jobId === selectedJobId);
			if (view === "detail" && selected) {
				return renderDetailView(selected, theme, width, bodyRows(), scrollTop);
			}
			view = "list";
			return renderListView(jobs, selectedJobId, theme, width, bodyRows());
		},
		handleInput(data) {
			if (finished) return;
			if (matchesKey(data, Key.ctrl("c"))) {
				finish({});
				return;
			}
			const jobs = runtime.panelJobs();
			const index = jobs.findIndex((job) => job.jobId === selectedJobId);
			const selected = jobs[index];
			if (view === "detail" && selected) {
				if (keybindings.matches(data, "tui.select.cancel")) {
					view = "list";
					scrollTop = undefined;
				} else if (keybindings.matches(data, "tui.select.up")) scrollDetail(selected, -1);
				else if (keybindings.matches(data, "tui.select.down")) scrollDetail(selected, 1);
				else if (keybindings.matches(data, "tui.select.pageUp")) {
					scrollDetail(selected, -detailLogRows(bodyRows(), selected));
				} else if (keybindings.matches(data, "tui.select.pageDown")) {
					scrollDetail(selected, detailLogRows(bodyRows(), selected));
				} else if (matchesKey(data, Key.left)) selectJob(jobs, index - 1);
				else if (matchesKey(data, Key.right)) selectJob(jobs, index + 1);
				else if (matchesKey(data, "k") || matchesKey(data, "shift+k")) {
					terminateSelected(jobs);
					return;
				} else return;
				repaint();
				return;
			}
			if (keybindings.matches(data, "tui.select.cancel")) {
				finish({});
				return;
			}
			if (jobs.length === 0) return;
			if (keybindings.matches(data, "tui.select.up")) selectJob(jobs, index - 1);
			else if (keybindings.matches(data, "tui.select.down")) selectJob(jobs, index + 1);
			else if (keybindings.matches(data, "tui.select.confirm")) {
				view = "detail";
				scrollTop = undefined;
			} else if (matchesKey(data, "k") || matchesKey(data, "shift+k")) {
				terminateSelected(jobs);
				return;
			} else return;
			repaint();
		},
		dispose() {
			teardown();
		},
	};
}

/** Rows available inside the frame: the overlay's share of the terminal minus the two border rows. */
export function panelBodyRows(terminalRows: number): number {
	return Math.max(MIN_BODY_ROWS, Math.floor(terminalRows * OVERLAY_HEIGHT_RATIO) - 2);
}

/** Rows the detail log gets once the job's own lines and the rule are placed. */
function detailLogRows(bodyRows: number, job: PanelJob): number {
	return Math.max(1, bodyRows - jobLines(job).length - 1);
}

/**
 * Render the job list inside a frame.
 *
 * The panel shows terminal jobs alongside active ones so a cancelled or failed
 * child can still be reviewed, which is the reason the record is kept at all.
 * The list scrolls to keep the selection visible, and says how many jobs sit
 * above and below the window so the selection is never silently replaced.
 */
export function renderListView(
	jobs: readonly PanelJob[],
	selectedJobId: string | undefined,
	theme: Theme,
	width: number,
	bodyRows: number,
): string[] {
	const active = jobs.filter((job) => !TERMINAL_JOB_STATES.has(job.state)).length;
	const inner = innerWidth(width);
	const body: string[] = [];
	if (jobs.length === 0) {
		body.push(theme.fg("muted", "No subagent jobs in this session."));
	} else {
		const index = Math.max(
			0,
			jobs.findIndex((job) => job.jobId === selectedJobId),
		);
		const { start, end } = listWindow(jobs.length, index, bodyRows);
		const visible = jobs.slice(start, end);
		const nameWidth = Math.min(
			MAX_NAME_COLUMNS,
			Math.max(...visible.map((job) => visibleWidth(sanitizeLabel(jobTitle(job))))),
		);
		if (start > 0) body.push(theme.fg("dim", `… ${start} above`));
		body.push(
			...visible.map((job) =>
				renderJobRow(job, job.jobId === selectedJobId, nameWidth, inner, theme),
			),
		);
		if (end < jobs.length) body.push(theme.fg("dim", `… ${jobs.length - end} below`));
	}
	const selected = jobs.find((job) => job.jobId === selectedJobId);
	const killable = selected !== undefined && !TERMINAL_JOB_STATES.has(selected.state);
	const hints: Hint[] = [
		["↑↓", "select"],
		["⏎", "open"],
		["k", killable ? "terminate" : "terminate (inactive)"],
		["esc", "close"],
	];
	const title =
		theme.fg("accent", theme.bold("Subagents")) +
		theme.fg("muted", ` · ${active} active · ${jobs.length} total`);
	return frame(title, body, renderHints(hints, theme), "", theme, width);
}

/**
 * The slice of jobs to show and keep the selection inside. A window that is not
 * at either end gives up one row on each side to the `… N above/below` markers,
 * so the frame keeps its height while the reader scrolls.
 */
function listWindow(total: number, index: number, rows: number): { start: number; end: number } {
	if (total <= rows) return { start: 0, end: total };
	const edge = Math.max(1, rows - 1);
	if (index < edge) return { start: 0, end: edge };
	if (index >= total - edge) return { start: total - edge, end: total };
	const middle = Math.max(1, rows - 2);
	const start = Math.min(total - middle - 1, Math.max(1, index - Math.floor(middle / 2)));
	return { start, end: start + middle };
}

function renderJobRow(
	job: PanelJob,
	selected: boolean,
	nameWidth: number,
	inner: number,
	theme: Theme,
): string {
	const state = job.state.padEnd(9);
	const elapsed = formatDuration(job.elapsedMs / 1_000).padStart(6);
	// Fixed parts: cursor(2) symbol(2) name gap(2) description gap(2) state gap(2) elapsed.
	const fixed = 2 + 2 + nameWidth + 2 + 2 + state.length + 2 + elapsed.length;
	const descriptionWidth = Math.max(0, inner - fixed);
	const name = fit(sanitizeLabel(jobTitle(job)), nameWidth);
	const description = fit(sanitizeLabel(job.description ?? ""), descriptionWidth);
	const cursor = selected ? theme.fg("accent", "❯ ") : "  ";
	const symbol = theme.fg(stateColor(job.state), `${stateSymbol(job.state)} `);
	// The description is what tells two jobs of the same agent apart, so it is
	// the row's primary text and the agent name reads as its category.
	const row =
		`${cursor}${symbol}${theme.fg("muted", name)}  ${theme.fg("text", description)}  ` +
		`${theme.fg(stateColor(job.state), state)}  ${theme.fg("dim", elapsed)}`;
	return selected ? theme.bg("selectedBg", theme.bold(padToWidth(row, inner))) : row;
}

/**
 * Render one job's activity log inside a frame.
 *
 * The job's own facts (description, id, tools, error, limitations) sit above the
 * rule; below it is the chronological log, which follows the newest event unless
 * the reader scrolled up. The eviction notice at its head makes the bounded
 * retention explicit instead of letting the log look complete.
 */
export function renderDetailView(
	job: PanelJob,
	theme: Theme,
	width: number,
	bodyRows: number,
	scrollTop: number | undefined,
): string[] {
	const log = detailLogLines(job, theme);
	const rows = detailLogRows(bodyRows, job);
	const maxTop = Math.max(0, log.length - rows);
	const top = Math.min(maxTop, scrollTop ?? maxTop);
	const visible = log.slice(top, top + rows);
	const body = [
		...jobLines(job).map(([role, line]) => theme.fg(role, line)),
		theme.fg("borderMuted", "─".repeat(innerWidth(width))),
		...visible,
	];
	const killable = !TERMINAL_JOB_STATES.has(job.state);
	const position =
		log.length > rows ? `${top + 1}–${Math.min(log.length, top + rows)}/${log.length}` : "";
	const hints: Hint[] = [
		["↑↓", "scroll"],
		["PgUp/PgDn", "page"],
		["←→", "job"],
		["k", killable ? "terminate" : "terminate (inactive)"],
		["esc", "back"],
	];
	return frame(
		detailTitle(job, theme),
		body,
		renderHints(hints, theme),
		position ? theme.fg("dim", position) : "",
		theme,
		width,
	);
}

function detailTitle(job: PanelJob, theme: Theme): string {
	const elapsed = formatDuration(job.elapsedMs / 1_000);
	const budget =
		job.timeout === undefined ? elapsed : `${elapsed} / ${formatDuration(job.timeout)}`;
	const turns =
		job.maxTurns === undefined ? `${job.turns} turns` : `${job.turns}/${job.maxTurns} turns`;
	const separator = theme.fg("muted", " · ");
	return (
		theme.fg("accent", theme.bold(sanitizeLabel(jobTitle(job)))) +
		separator +
		theme.fg(stateColor(job.state), job.state) +
		separator +
		theme.fg("muted", `${budget} · ${turns}`)
	);
}

type JobLine = readonly [role: "text" | "dim" | "error" | "warning", line: string];

/** The job-level lines shown above the rule: what it is, then what went wrong. */
function jobLines(job: PanelJob): JobLine[] {
	const tools = job.tools.length > 0 ? job.tools.map(sanitizeLabel).join(", ") : "none";
	const identity = `${job.jobId} · tools: ${tools}`;
	const lines: JobLine[] = [
		job.description
			? ["text", `${sanitizeLabel(job.description)}  ${identity}`]
			: ["dim", identity],
	];
	if (job.error) lines.push(["error", `error: ${sanitizeLabel(job.error)}`]);
	for (const limitation of job.limitations) {
		lines.push(["warning", `note: ${sanitizeLabel(limitation)}`]);
	}
	return lines;
}

function detailLogLines(job: PanelJob, theme: Theme): string[] {
	const lines: string[] = [];
	if (job.droppedEvents > 0) {
		lines.push(theme.fg("dim", `… ${job.droppedEvents} earlier event(s) dropped`));
	}
	if (job.activity.length === 0) {
		lines.push(
			theme.fg(
				"muted",
				TERMINAL_JOB_STATES.has(job.state)
					? "No activity recorded."
					: "Waiting for the child to start…",
			),
		);
	} else {
		lines.push(...job.activity.map((event) => renderActivityEvent(event, theme)));
	}
	return lines;
}

/**
 * One log line: clock, a fixed-width label column, a two-column outcome mark,
 * then the detail. The columns are fixed so `read`, `write`, and `say` line up.
 */
function renderActivityEvent(event: ActivityEvent, theme: Theme): string {
	const at = theme.fg("dim", formatClock(event.at));
	if (event.kind === "output") {
		return `${at} ${theme.fg("accent", fit("say", TOOL_COLUMNS))}   ${theme.fg("text", event.detail)}`;
	}
	if (event.kind === "notice") {
		return `${at} ${theme.fg("muted", fit("note", TOOL_COLUMNS))}   ${theme.fg("muted", event.detail)}`;
	}
	const tool = theme.fg("toolTitle", fit(event.tool ?? "tool", TOOL_COLUMNS));
	const outcome =
		event.outcome === undefined
			? theme.fg("dim", " …")
			: event.outcome === "error"
				? theme.fg("error", " ✗")
				: theme.fg("success", " ✓");
	const result = event.result ? theme.fg("toolOutput", ` → ${event.result}`) : "";
	return `${at} ${tool}${outcome} ${theme.fg("muted", event.detail)}${result}`;
}

/**
 * Wrap body lines in a rounded frame with the title in the top border and the
 * key hints in the bottom one, so neither costs a content row. Every line is
 * truncated to the frame, so a long detail can never break the border.
 */
function frame(
	title: string,
	body: readonly string[],
	hints: string,
	trailing: string,
	theme: Theme,
	width: number,
): string[] {
	const renderWidth = Math.max(24, width);
	const inner = innerWidth(renderWidth);
	const row = (line: string) =>
		`${theme.fg("borderMuted", "│ ")}${padToWidth(truncateToWidth(line, inner, "…"), inner)}${theme.fg("borderMuted", " │")}`;
	return [
		border("╭", title, "", "╮", theme, renderWidth),
		...body.map(row),
		border("╰", hints, trailing, "╯", theme, renderWidth),
	];
}

/** A border row: `╭─ label ───── trailing ─╮`, with the rule filling the gap. */
function border(
	left: string,
	label: string,
	trailing: string,
	right: string,
	theme: Theme,
	width: number,
): string {
	const tail = trailing ? ` ${trailing} ─` : "";
	const tailWidth = visibleWidth(tail);
	// `╭─` and `╮` plus at least one rule glyph before the trailing text.
	const labelWidth = Math.max(0, Math.min(visibleWidth(label) + 2, width - 3 - tailWidth - 1));
	const text = labelWidth > 0 ? truncateToWidth(` ${label} `, labelWidth, "…") : "";
	const rule = "─".repeat(Math.max(0, width - 3 - visibleWidth(text) - tailWidth));
	return (
		theme.fg("borderMuted", `${left}─`) + text + theme.fg("borderMuted", `${rule}${tail}${right}`)
	);
}

function renderHints(hints: readonly Hint[], theme: Theme): string {
	return hints
		.map(([key, description]) => `${theme.fg("dim", key)} ${theme.fg("muted", description)}`)
		.join("  ");
}

function innerWidth(width: number): number {
	return Math.max(1, Math.max(24, width) - FRAME_COLUMNS);
}

function fit(value: string, columns: number): string {
	return padToWidth(truncateToWidth(value, columns, "…"), columns);
}

function padToWidth(value: string, columns: number): string {
	return value + " ".repeat(Math.max(0, columns - visibleWidth(value)));
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
