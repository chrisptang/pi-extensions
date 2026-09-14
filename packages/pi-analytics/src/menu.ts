import { stripVTControlCharacters } from "node:util";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { MenuDefinition } from "@narumitw/pi-tui-kit";
import type { ClearAnalyticsResult } from "./storage/database.js";
import type {
	ActivityDay,
	AnalyticsSnapshot,
	SkillStats,
	TimeRange,
	TimeRangeId,
	ToolStats,
} from "./storage/queries.js";
import { resolveTimeRange } from "./storage/queries.js";

export type AnalyticsLoadResult =
	| { kind: "ready"; snapshot: AnalyticsSnapshot }
	| { kind: "unavailable"; message: string };

export interface AnalyticsMenuDataSource {
	path: string;
	load(range: TimeRange, signal: AbortSignal): Promise<AnalyticsLoadResult>;
	clearAll(signal: AbortSignal): Promise<ClearAnalyticsResult>;
}

export interface AnalyticsMenuState {
	rangeId: TimeRangeId;
	range: TimeRange;
	path: string;
	result: AnalyticsLoadResult;
}

export interface AnalyticsMenuOptions {
	runConfirmation: typeof import("@narumitw/pi-tui-kit")["runConfirmation"];
	isCurrent(): boolean;
}

type Screen =
	| "main"
	| "range"
	| "tokens"
	| "sessions"
	| "skills"
	| "tools"
	| "reliability"
	| "responses"
	| "privacy";
type Action = "setRange" | "clearData";

const RANGE_LABELS: Record<TimeRangeId, string> = {
	today: "Today",
	"7d": "Last 7 days",
	"30d": "Last 30 days",
	all: "All time",
};

export function createAnalyticsMenu(
	source: AnalyticsMenuDataSource,
	now: () => number = Date.now,
	options?: AnalyticsMenuOptions,
) {
	let rangeId: TimeRangeId = "7d";
	let cachedState: AnalyticsMenuState | undefined;
	const loadState = async (signal: AbortSignal): Promise<AnalyticsMenuState> => {
		if (cachedState?.rangeId === rangeId) return cachedState;
		const range = resolveTimeRange(rangeId, now());
		const loaded = { rangeId, range, path: source.path, result: await source.load(range, signal) };
		if (!signal.aborted && rangeId === loaded.rangeId) cachedState = loaded;
		return loaded;
	};
	const getState = ({ signal }: { signal: AbortSignal }): Promise<AnalyticsMenuState> =>
		loadState(signal);
	const menu: MenuDefinition<AnalyticsMenuState, Screen, Action> = {
		start: "main",
		screens: {
			main: ({ state }) => ({
				kind: "actions",
				title: `Analytics · ${RANGE_LABELS[state.rangeId]}`,
				lines: overviewLines(state.result),
				items: [
					{ id: "range", label: "Change time range", to: "range" },
					{ id: "tokens", label: "Tokens & cost", to: "tokens" },
					{ id: "sessions", label: "Sessions & activity", to: "sessions" },
					{ id: "skills", label: "Skills", to: "skills" },
					{ id: "tools", label: "Tools", to: "tools" },
					{ id: "reliability", label: "Provider reliability", to: "reliability" },
					{ id: "responses", label: "Response cycles", to: "responses" },
					{ id: "privacy", label: "Data & privacy", to: "privacy" },
					{ id: "close", label: "Close", close: true },
				],
				hint: "close",
			}),
			range: ({ state }) => ({
				kind: "choice",
				title: "Analytics time range",
				items: (Object.keys(RANGE_LABELS) as TimeRangeId[]).map((id) => ({
					id,
					label: RANGE_LABELS[id],
				})),
				action: "setRange",
				currentItemId: state.rangeId,
				initialItemId: state.rangeId,
				hint: "back",
			}),
			tokens: ({ state }) => ({
				kind: "detail",
				title: `Tokens & cost · ${RANGE_LABELS[state.rangeId]}`,
				lines: tokenLines(state.result),
				hint: "back",
			}),
			sessions: ({ state }) => ({
				kind: "detail",
				title: `Sessions & activity · ${RANGE_LABELS[state.rangeId]}`,
				lines: sessionLines(state.result),
				hint: "back",
			}),
			skills: ({ state }) => skillsScreen(state.result),
			tools: ({ state }) => toolsScreen(state.result),
			reliability: ({ state }) => ({
				kind: "detail",
				title: `Provider reliability · ${RANGE_LABELS[state.rangeId]}`,
				lines: reliabilityLines(state.result),
				hint: "back",
			}),
			responses: ({ state }) => ({
				kind: "detail",
				title: `Response cycles · ${RANGE_LABELS[state.rangeId]}`,
				lines: responseLines(state.result),
				hint: "back",
			}),
			privacy: ({ state }) => ({
				kind: "actions",
				title: "Analytics data & privacy",
				lines: privacyLines(state),
				items: [
					{
						id: "clear",
						label: "Clear analytics data…",
						action: "clearData",
						disabled: state.result.kind !== "ready",
					},
				],
				hint: "back",
			}),
		},
		actions: {
			setRange: async ({ itemId, signal }) => {
				if (!isRangeId(itemId)) return { kind: "rejected", error: new Error("Unknown range") };
				rangeId = itemId;
				cachedState = undefined;
				await loadState(signal);
				return signal.aborted ? { kind: "close" } : { kind: "to", screen: "main" };
			},
			clearData: async ({ ctx, state, signal }) => {
				if (state.result.kind !== "ready") return { kind: "stay" };
				if (!options) throw new Error("Analytics confirmation is unavailable");
				const count = state.result.snapshot.overview.responseCycles;
				const confirmation = await options.runConfirmation(ctx, {
					title: "Delete analytics data?",
					message: `This will clear all local analytics history from:\n\n${safeDisplayText(state.path)}\n\nThe selected range currently shows ${count} response cycles. Other running Pi processes may add new records afterward.`,
					confirmLabel: "Delete data",
					cancelLabel: "Keep data",
					signal,
					isCurrent: options.isCurrent,
					// Keep the dashboard's existing domain-level error route as the only notifier.
					onError: () => undefined,
				});
				if (signal.aborted || !options.isCurrent()) return { kind: "close" };
				if (confirmation.kind === "closed") {
					return confirmation.reason === "close" ? { kind: "close" } : { kind: "stay" };
				}
				if (confirmation.kind === "stale") return { kind: "close" };
				if (confirmation.kind === "unsupported") {
					throw new Error(`Analytics confirmation is unavailable in ${confirmation.mode} mode`);
				}
				if (confirmation.kind === "error") throw confirmation.error;

				const result = await source.clearAll(signal);
				cachedState = undefined;
				const isCurrent = options.isCurrent();
				if (isCurrent) {
					try {
						ctx.ui.notify("Cleared local analytics data.", "info");
						if (result.cleanupIncomplete) {
							ctx.ui.notify(
								"Some obsolete analytics files are still in use. Stop other Pi processes and clear again to remove them.",
								"warning",
							);
						}
					} catch {
						// The host can dispose the current UI after the ownership check.
					}
				}
				return signal.aborted || !isCurrent ? { kind: "close" } : { kind: "to", screen: "main" };
			},
		},
	};
	return {
		menu,
		getState,
		preload: (signal: AbortSignal) => loadState(signal),
		get rangeId() {
			return rangeId;
		},
	};
}

export async function showAnalyticsMenu(
	ctx: ExtensionCommandContext,
	source: AnalyticsMenuDataSource,
	options: { signal: AbortSignal; isCurrent: () => boolean },
): Promise<void> {
	const { runConfirmation, runMenu, runTask } = await import("@narumitw/pi-tui-kit");
	if (options.signal.aborted || !options.isCurrent()) return;
	const controller = createAnalyticsMenu(source, Date.now, {
		runConfirmation,
		isCurrent: options.isCurrent,
	});
	const loading = await runTask(ctx, {
		label: "Loading local analytics…",
		signal: options.signal,
		isCurrent: options.isCurrent,
		task: ({ signal }) => controller.preload(signal),
		onError: () => undefined,
	});
	if (loading.kind !== "completed") {
		if (loading.kind === "error") {
			ctx.ui.notify(
				"Analytics failed: The local analytics query could not be completed. Existing data was not changed.",
				"error",
			);
		}
		return;
	}
	await runMenu(ctx, controller.menu, {
		getState: controller.getState,
		signal: options.signal,
		isCurrent: options.isCurrent,
		onError: (_ctx, error) => {
			ctx.ui.notify(`Analytics failed: ${safeErrorMessage(error)}`, "error");
		},
	});
}

function overviewLines(result: AnalyticsLoadResult): string[] {
	if (result.kind === "unavailable") {
		return [result.message, "", "No analytics are being collected."];
	}
	const stats = result.snapshot.overview;
	if (stats.responseCycles === 0) {
		const sessions = result.snapshot.sessions;
		return [
			"No response cycles recorded yet.",
			"Collection is active. Complete one Pi response cycle, then open /analytics again.",
			...(sessions.count > 0
				? [
						"",
						metric("Imported sessions", sessions.count),
						metric("Active days", `${sessions.activeDays}/${sessions.totalDays}`),
						metric("Tokens", `${formatTokens(sessions.tokens)} · ${formatCost(sessions.cost)}`),
					]
				: []),
			"",
			"Includes settled response cycles only.",
		];
	}
	return [
		metric("Response cycles", stats.responseCycles),
		metric("LLM calls", stats.llmCalls),
		metric(
			"Calls per response",
			`${formatDecimal(stats.callsPerResponse)} · P95 ${stats.p95CallsPerResponse}`,
		),
		metric("Tool calls", stats.toolCalls),
		metric("Tool errors", stats.toolErrors),
		metric("Skill activations", stats.skillActivations),
		metric("Provider errors", stats.providerErrors),
		metric("Recovered errors", stats.recoveredErrors),
		metric(
			"Tokens",
			`${formatTokens(result.snapshot.tokens.tokens)} · ${formatCost(result.snapshot.tokens.cost)}`,
		),
		metric(
			"Sessions",
			`${result.snapshot.sessions.count} · ${result.snapshot.sessions.activeDays}/${result.snapshot.sessions.totalDays} active days`,
		),
		"",
		"Includes settled response cycles only.",
	];
}

function skillsScreen(result: AnalyticsLoadResult) {
	if (result.kind === "unavailable") {
		return {
			kind: "browse" as const,
			title: "Skills",
			lines: [result.message],
			items: [],
			hint: "back" as const,
		};
	}
	return {
		kind: "browse" as const,
		title: "Skills",
		lines:
			result.snapshot.skills.length === 0
				? ["No skill activations detected in this time range."]
				: undefined,
		items: result.snapshot.skills.map(skillItem),
		viewportSize: "adaptive" as const,
		hint: "back" as const,
	};
}

function skillItem(skill: SkillStats) {
	return {
		id: skill.name,
		label: safeDisplayText(skill.name),
		statusText: `${skill.count} · ${skill.modelInitiated} model / ${skill.userInitiated} user`,
		searchText: skill.models.map(modelLabel).join(" "),
		details: [
			metric("Activations", skill.count),
			metric("Model initiated", skill.modelInitiated),
			metric("User initiated", skill.userInitiated),
			"",
			"By model",
			...skill.models.map((model) => `${modelLabel(model)}: ${model.count}`),
			"",
			`Last detected: ${formatTimestamp(skill.lastOccurredAtMs)}`,
		],
	};
}

function toolsScreen(result: AnalyticsLoadResult) {
	if (result.kind === "unavailable") {
		return {
			kind: "browse" as const,
			title: "Tools",
			lines: [result.message],
			items: [],
			hint: "back" as const,
		};
	}
	return {
		kind: "browse" as const,
		title: "Tools",
		lines:
			result.snapshot.tools.length === 0
				? ["No tool calls detected in this time range."]
				: undefined,
		items: result.snapshot.tools.map(toolItem),
		viewportSize: "adaptive" as const,
		hint: "back" as const,
	};
}

function toolItem(tool: ToolStats) {
	return {
		id: tool.name,
		label: safeDisplayText(tool.name),
		statusText: `${tool.count} · ${tool.errors} errors`,
		searchText: tool.models.map(modelLabel).join(" "),
		details: [
			metric("Calls", tool.count),
			metric("Errors", tool.errors),
			`Average duration: ${formatDecimal(tool.averageDurationMs)} ms`,
			"",
			"By model",
			...tool.models.map((model) => `${modelLabel(model)}: ${model.count}`),
			"",
			`Last detected: ${formatTimestamp(tool.lastOccurredAtMs)}`,
		],
	};
}

function tokenLines(result: AnalyticsLoadResult): string[] {
	if (result.kind === "unavailable") return [result.message];
	const stats = result.snapshot.tokens;
	if (stats.measuredCalls === 0) {
		return [
			"No token usage recorded in this range.",
			"",
			stats.unmeasuredCalls > 0
				? `${stats.unmeasuredCalls} LLM calls reported no usage counters.`
				: "Complete one Pi response cycle, then open /analytics again.",
		];
	}
	const lines = [
		metric("Input (uncached)", formatTokens(stats.input)),
		metric("Cache read", formatTokens(stats.cacheRead)),
		metric("Cache write", formatTokens(stats.cacheWrite)),
		metric("Output", formatTokens(stats.output)),
		metric("Total", formatTokens(stats.tokens)),
		"",
		metric("Cost", formatCost(stats.cost)),
		metric("Cache hit rate", `${formatDecimal(stats.cacheHitRate)}%`),
		metric("Measured calls", stats.measuredCalls),
	];
	if (stats.unmeasuredCalls > 0) {
		lines.push(metric("Calls without usage", stats.unmeasuredCalls));
	}
	lines.push("", "By model");
	for (const item of stats.models) {
		lines.push(
			metric(
				`  ${item.provider ?? "unknown"}/${item.model ?? "unknown"}`,
				`${formatTokens(item.tokens)} · ${formatCost(item.cost)} · ${item.calls} calls`,
			),
		);
		lines.push(
			metric(
				"    in / cache r+w / out",
				`${formatTokens(item.input)} / ${formatTokens(item.cacheRead)}+${formatTokens(item.cacheWrite)} / ${formatTokens(item.output)}`,
			),
		);
	}
	return lines;
}

function sessionLines(result: AnalyticsLoadResult): string[] {
	if (result.kind === "unavailable") return [result.message];
	const stats = result.snapshot.sessions;
	if (stats.count === 0) {
		return [
			"No sessions recorded in this range.",
			"",
			"Sessions are imported from the Pi session log by the backfill script;",
			"see scripts/backfill-sessions.mjs in this package.",
		];
	}
	const lines = [
		metric("Sessions", stats.count),
		metric("LLM calls", stats.llmCalls),
		metric("Tokens", `${formatTokens(stats.tokens)} · ${formatCost(stats.cost)}`),
		metric("Active days", `${stats.activeDays}/${stats.totalDays}`),
		metric("Longest streak", formatDays(stats.longestStreak)),
		metric("Current streak", formatDays(stats.currentStreak)),
		metric("Average session", formatDuration(stats.averageDurationMs)),
		metric("Longest session", formatDuration(stats.longestDurationMs)),
		"",
		"Session length is wall-clock time from first to last entry, including idle time.",
		"",
		"Activity",
		...heatmapLines(stats.days),
		"",
		"By project",
	];
	for (const item of stats.projects) {
		lines.push(
			metric(
				`  ${safeDisplayText(item.project)}`,
				`${formatCount(item.sessions, "session")} · ${formatTokens(item.tokens)} · ${formatCost(item.cost)}`,
			),
		);
	}
	return lines;
}

const HEATMAP_LEVELS = ["·", "░", "▒", "▓", "█"] as const;

/**
 * Renders active days as one row per week (Monday first), scaling each cell against the busiest
 * day so the shape stays readable regardless of absolute volume.
 */
function heatmapLines(days: readonly ActivityDay[]): string[] {
	const first = days[0];
	const last = days.at(-1);
	if (!first || !last) return ["No activity."];
	const byDate = new Map(days.map((day) => [day.date, day]));
	const peak = Math.max(...days.map(({ tokens }) => tokens), 1);
	const start = startOfWeek(first.date);
	const end = dayStart(last.date);
	const lines: string[] = ["      Mon Tue Wed Thu Fri Sat Sun"];
	for (let cursor = start; cursor <= end; cursor = addDays(cursor, 7)) {
		const cells: string[] = [];
		for (let offset = 0; offset < 7; offset += 1) {
			const date = dateKey(addDays(cursor, offset));
			const day = byDate.get(date);
			cells.push(day ? ` ${HEATMAP_LEVELS[level(day.tokens, peak)]} ` : "   ");
		}
		lines.push(`${dateKey(cursor).slice(5)} ${cells.join("")}`);
	}
	lines.push("", `  less ${HEATMAP_LEVELS.join(" ")} more · shaded by tokens`);
	return lines;
}

function level(tokens: number, peak: number): number {
	if (tokens <= 0) return 0;
	const ratio = tokens / peak;
	if (ratio > 0.75) return 4;
	if (ratio > 0.5) return 3;
	if (ratio > 0.25) return 2;
	return 1;
}

function dayStart(date: string): Date {
	const [year, month, day] = date.split("-").map(Number);
	return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1);
}

function startOfWeek(date: string): Date {
	const value = dayStart(date);
	// getDay() is Sunday-based; shift so Monday starts the row.
	const offset = (value.getDay() + 6) % 7;
	return addDays(value, -offset);
}

function addDays(value: Date, days: number): Date {
	const next = new Date(value);
	next.setDate(next.getDate() + days);
	return next;
}

function dateKey(value: Date): string {
	const month = String(value.getMonth() + 1).padStart(2, "0");
	const day = String(value.getDate()).padStart(2, "0");
	return `${value.getFullYear()}-${month}-${day}`;
}

function formatDays(value: number): string {
	return formatCount(value, "day");
}

function formatCount(value: number, noun: string): string {
	return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

function formatDuration(value: number): string {
	const totalMinutes = Math.floor(value / 60_000);
	const days = Math.floor(totalMinutes / (60 * 24));
	const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
	const minutes = totalMinutes % 60;
	if (days > 0) return `${days}d ${hours}h ${minutes}m`;
	if (hours > 0) return `${hours}h ${minutes}m`;
	return `${minutes}m`;
}

function formatTokens(value: number): string {
	if (value < 1_000) return String(value);
	if (value < 1_000_000) return `${formatDecimal(value / 1_000)}k`;
	if (value < 1_000_000_000) return `${formatDecimal(value / 1_000_000)}M`;
	return `${formatDecimal(value / 1_000_000_000)}b`;
}

function formatCost(value: number): string {
	if (value === 0) return "$0";
	return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

function reliabilityLines(result: AnalyticsLoadResult): string[] {
	if (result.kind === "unavailable") return [result.message];
	const value = result.snapshot.reliability;
	return [
		"Observed provider errors only; provider-internal failures may be invisible.",
		"",
		metric("HTTP 429", value.http429),
		metric("HTTP 5xx", value.http5xx),
		metric("DNS", value.categories.dns),
		metric("Connection timeout", value.categories.timeout),
		metric("Connection refused", value.categories.connection_refused),
		metric("Connection reset", value.categories.connection_reset),
		metric("TLS", value.categories.tls),
		metric("Other network", value.categories.network_other),
		metric("Other provider", value.categories.provider_other),
		"",
		metric("Recovered", value.recovered),
		metric("Terminal failures", value.terminal),
	];
}

function responseLines(result: AnalyticsLoadResult): string[] {
	if (result.kind === "unavailable") return [result.message];
	const value = result.snapshot.responses;
	return [
		metric("Cycles", value.count),
		metric("LLM calls", value.llmCalls),
		metric("Average", formatDecimal(value.average)),
		metric("Median", formatDecimal(value.median)),
		metric("P95", value.p95),
		metric("Maximum", value.maximum),
		"",
		"Calls per response",
		metric("1 call", value.distribution.one),
		metric("2–3 calls", value.distribution.twoToThree),
		metric("4–6 calls", value.distribution.fourToSix),
		metric("7+ calls", value.distribution.sevenPlus),
	];
}

function privacyLines(state: AnalyticsMenuState): string[] {
	return [
		"Local analytics files:",
		safeDisplayText(state.path),
		"",
		"Stored: timestamps, extension-generated record IDs, model/provider IDs, thinking level, tool and skill names, durations, counts, HTTP statuses, and classified errors.",
		'Stored by the session backfill: session IDs and the working-directory basename (for example "pi-extensions"), never the full path.',
		"Not stored: prompts, responses, thinking, tool arguments/results, raw errors, headers, or credentials.",
		"",
		"No database server, cloud connection, or other remote telemetry is used.",
		"Analytics are non-critical derived metadata; a failed local write may be dropped.",
	];
}

function metric(label: string, value: string | number): string {
	return `${label.padEnd(24)} ${value}`;
}

function formatDecimal(value: number): string {
	return Number.isInteger(value)
		? String(value)
		: value.toFixed(2).replace(/0+$/u, "").replace(/\.$/u, "");
}

function formatTimestamp(value: number): string {
	return new Date(value).toLocaleString();
}

function modelLabel(model: { provider?: string; model?: string }): string {
	if (!model.provider && !model.model) return "unknown";
	return safeDisplayText(`${model.provider ?? "unknown"}/${model.model ?? "unknown"}`);
}

function safeDisplayText(value: unknown): string {
	return Array.from(stripVTControlCharacters(String(value)), (character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) ? " " : character;
	}).join("");
}

function isRangeId(value: string): value is TimeRangeId {
	return value === "today" || value === "7d" || value === "30d" || value === "all";
}

function safeErrorMessage(_error: unknown): string {
	return "The local analytics query could not be completed. Try again; existing data was not changed.";
}
