import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	isViewportTUI,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { openSubagentsPanel } from "./panel.js";
import type { ActiveJobDisplay, SubagentRuntime } from "./runtime.js";
import { formatDuration, sanitizeTerminalText } from "./text.js";

export const SUBAGENT_WIDGET_KEY = "subagents";
export const SUBAGENT_WIDGET_REFRESH_INTERVAL_MS = 1_000;

const WIDGET_OPTIONS = { placement: "aboveEditor" } as const;

export interface SubagentWidgetController {
	start(ctx: ExtensionContext): void;
	shutdown(ctx: ExtensionContext): void;
}

export function createSubagentWidgetController(runtime: SubagentRuntime): SubagentWidgetController {
	let activeSession: ExtensionContext["sessionManager"] | undefined;
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let unsubscribeJobs: (() => void) | undefined;
	let publishedValue: string | undefined;
	let panelOpen = false;
	let closePanel: (() => void) | undefined;

	const ownsSession = (ctx: ExtensionContext): boolean => ctx.sessionManager === activeSession;

	const stop = (): void => {
		if (refreshTimer) clearInterval(refreshTimer);
		refreshTimer = undefined;
		unsubscribeJobs?.();
		unsubscribeJobs = undefined;
	};

	/**
	 * A click toggles the panel through the same path as `/subagents`. The first
	 * click opens it — a job row lands on that job's detail view, the header opens
	 * the list — and a click while it is up closes it through the close handle,
	 * because the widget stays mounted above the editor and remains clickable.
	 */
	const openPanel = (ctx: ExtensionContext, jobId?: string): void => {
		if (panelOpen || !ownsSession(ctx)) return;
		panelOpen = true;
		void openSubagentsPanel(
			runtime,
			ctx,
			jobId === undefined ? undefined : { jobId, view: "detail" },
			{
				onCloseHandle: (close) => {
					closePanel = close;
				},
			},
		)
			.catch((error: unknown) => {
				if (!ownsSession(ctx)) return;
				ctx.ui.notify(
					`Could not open the subagents panel: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			})
			.finally(() => {
				panelOpen = false;
				closePanel = undefined;
			});
	};

	const publish = (ctx: ExtensionContext): void => {
		if (ctx.mode !== "tui" || !ownsSession(ctx)) return;
		const jobs = runtime.activeJobsForDisplay();
		const value = widgetValue(jobs);
		if (value === publishedValue) return;
		if (jobs.length === 0) {
			ctx.ui.setWidget(SUBAGENT_WIDGET_KEY, undefined);
		} else {
			const snapshot = jobs.map(cloneDisplayJob);
			ctx.ui.setWidget(
				SUBAGENT_WIDGET_KEY,
				(tui: TUI, theme) => {
					const clickable = isViewportTUI(tui);
					return {
						render: (width) => renderSubagentWidget(snapshot, theme, width, clickable),
						invalidate: () => {},
						handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
							if (event.button !== "left") return undefined;
							// The press must be handled for the release to arrive as a click.
							if (event.type === "press") return { handled: true, render: false };
							if (event.type !== "click") return undefined;
							if (panelOpen) {
								closePanel?.();
								return { handled: true };
							}
							openPanel(ctx, event.y > 0 ? snapshot[event.y - 1]?.jobId : undefined);
							return { handled: true };
						},
					};
				},
				WIDGET_OPTIONS,
			);
		}
		publishedValue = value;
	};

	return {
		start(ctx) {
			stop();
			activeSession = ctx.sessionManager;
			publishedValue = undefined;
			if (ctx.mode !== "tui") return;
			ctx.ui.setWidget(SUBAGENT_WIDGET_KEY, undefined);
			unsubscribeJobs = runtime.subscribeJobs(() => publish(ctx));
			refreshTimer = setInterval(() => publish(ctx), SUBAGENT_WIDGET_REFRESH_INTERVAL_MS);
			refreshTimer.unref();
			publish(ctx);
		},
		shutdown(ctx) {
			if (!ownsSession(ctx)) return;
			stop();
			if (ctx.mode === "tui") ctx.ui.setWidget(SUBAGENT_WIDGET_KEY, undefined);
			publishedValue = undefined;
			activeSession = undefined;
		},
	};
}

export function renderSubagentWidget(
	jobs: readonly ActiveJobDisplay[],
	theme: Theme,
	width: number,
	clickable = false,
): string[] {
	const renderWidth = Math.max(0, width);
	const cost = jobs.reduce((total, job) => total + job.cost, 0);
	// Only fullscreen mode tracks the mouse, so the click hint is viewport-only.
	const hint = clickable
		? " · click or /subagents to inspect"
		: " · /subagents to inspect or terminate";
	const lines = [
		`${theme.fg("muted", `Subagents · ${jobs.length} active · ${formatCost(cost)}`)}${theme.fg("dim", hint)}`,
		...jobs.map((job) => renderJob(job, theme)),
	];
	return lines.map((line) => truncateToWidth(line, renderWidth, "…"));
}

/**
 * One line per job in three groups: what it is (state, name, description), how
 * much of its budget it has used, and what it is doing now. Two spaces separate
 * the groups and `›` marks the activity, so a glance can find each without
 * reading the whole line. The activity comes last because it is the only part
 * that changes every second, and a tail is what a glance reads.
 */
function renderJob(job: ActiveJobDisplay, theme: Theme): string {
	const running = job.state === "running";
	const symbol = theme.fg(running ? "accent" : "dim", running ? "▶ " : "○ ");
	const summary = jobSummary(job);
	const elapsed = formatDuration(job.elapsedMs / 1_000);
	const turns =
		job.maxTurns === undefined ? `${job.turns} turns` : `${job.turns}/${job.maxTurns} turns`;
	const what = [
		`${symbol}${theme.fg("muted", jobTitle(job))}`,
		summary ? theme.fg("text", summary) : undefined,
	];
	const parts = [
		...what,
		running
			? theme.fg("dim", `${elapsed} · ${turns} · ${formatCost(job.cost)}`)
			: theme.fg("muted", job.state),
		// The activity line is already sanitized and redacted by the runtime's log.
		job.latestActivity === undefined
			? undefined
			: theme.fg("dim", `› ${sanitizeLabel(job.latestActivity)}`),
	];
	return parts.filter((part) => part !== undefined).join("  ");
}

/** Prefer the agent name; a job without one is only identifiable by its id. */
function jobTitle(job: ActiveJobDisplay): string {
	const agent = job.agent === undefined ? "" : sanitizeLabel(job.agent);
	return agent === "" ? sanitizeLabel(job.jobId) : agent;
}

function jobSummary(job: ActiveJobDisplay): string {
	return job.description === undefined ? "" : sanitizeLabel(job.description);
}

function widgetValue(jobs: readonly ActiveJobDisplay[]): string {
	return jobs
		.map(
			(job) =>
				`${job.jobId}\0${job.agent ?? ""}\0${job.description ?? ""}\0${job.state}\0${Math.floor(job.elapsedMs / 1_000)}\0${job.turns}\0${job.maxTurns ?? ""}\0${job.tools.join(",")}\0${formatCost(job.cost)}\0${job.latestActivity ?? ""}`,
		)
		.join("\n");
}

function formatCost(value: number): string {
	return `$${value.toFixed(3)}`;
}

function cloneDisplayJob(job: ActiveJobDisplay): ActiveJobDisplay {
	return { ...job, tools: [...job.tools] };
}

function sanitizeLabel(value: string): string {
	return sanitizeTerminalText(value).replace(/\s+/gu, " ").trim();
}
