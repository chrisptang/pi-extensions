import type { ProviderErrorCategory, SessionRecord, SettledRun } from "../types.js";

export type TimeRangeId = "today" | "7d" | "30d" | "all";
export interface TimeRange {
	id?: TimeRangeId;
	fromMs: number;
	toMs: number;
}

export interface OverviewStats {
	responseCycles: number;
	llmCalls: number;
	callsPerResponse: number;
	p95CallsPerResponse: number;
	toolCalls: number;
	toolErrors: number;
	skillActivations: number;
	providerErrors: number;
	recoveredErrors: number;
}

export interface ModelCount {
	provider?: string;
	model?: string;
	count: number;
}

export interface SkillStats {
	name: string;
	count: number;
	modelInitiated: number;
	userInitiated: number;
	lastOccurredAtMs: number;
	models: ModelCount[];
}

export interface ToolStats {
	name: string;
	count: number;
	errors: number;
	averageDurationMs: number;
	lastOccurredAtMs: number;
	models: ModelCount[];
}

export interface ReliabilityStats {
	http429: number;
	http5xx: number;
	recovered: number;
	terminal: number;
	categories: Record<ProviderErrorCategory, number>;
}

export interface ResponseStats {
	count: number;
	llmCalls: number;
	average: number;
	median: number;
	p95: number;
	maximum: number;
	distribution: { one: number; twoToThree: number; fourToSix: number; sevenPlus: number };
}

export interface TokenTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export interface ModelTokenStats extends TokenTotals {
	provider?: string;
	model?: string;
	calls: number;
	tokens: number;
}

export interface TokenStats extends TokenTotals {
	/** Prompt tokens billed at full rate, excluding cache reads and writes. */
	tokens: number;
	/** Calls whose usage counters were reported by the provider. */
	measuredCalls: number;
	/** Calls that finished without usage counters, so their tokens are absent here. */
	unmeasuredCalls: number;
	cacheHitRate: number;
	models: ModelTokenStats[];
}

export interface ActivityDay {
	/** Local calendar day as YYYY-MM-DD. */
	date: string;
	sessions: number;
	llmCalls: number;
	tokens: number;
	cost: number;
}

export interface ProjectStats {
	project: string;
	sessions: number;
	llmCalls: number;
	tokens: number;
	cost: number;
}

export interface SessionStats {
	count: number;
	llmCalls: number;
	/** Distinct local calendar days with at least one session. */
	activeDays: number;
	/** Calendar days spanned by the range, bounded by the first recorded session. */
	totalDays: number;
	longestStreak: number;
	currentStreak: number;
	/** Prompt, cache and output tokens across imported sessions. */
	tokens: number;
	cost: number;
	averageDurationMs: number;
	longestDurationMs: number;
	projects: ProjectStats[];
	/** One entry per active day, oldest first. */
	days: ActivityDay[];
}

export interface AnalyticsSnapshot {
	overview: OverviewStats;
	skills: SkillStats[];
	tools: ToolStats[];
	reliability: ReliabilityStats;
	responses: ResponseStats;
	tokens: TokenStats;
	sessions: SessionStats;
}

const DAY_MS = 24 * 60 * 60 * 1_000;
const ERROR_CATEGORIES: readonly ProviderErrorCategory[] = [
	"dns",
	"timeout",
	"connection_refused",
	"connection_reset",
	"tls",
	"network_other",
	"provider_other",
];

export function resolveTimeRange(id: TimeRangeId, now = Date.now()): TimeRange {
	let fromMs = 0;
	if (id === "today") {
		const date = new Date(now);
		fromMs = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
	} else if (id === "7d") fromMs = now - 7 * DAY_MS;
	else if (id === "30d") fromMs = now - 30 * DAY_MS;
	return { id, fromMs, toMs: now + 1 };
}

export async function querySnapshot(
	runs: AsyncIterable<SettledRun> | Iterable<SettledRun>,
	range: TimeRange,
	signal?: AbortSignal,
	sessions: readonly SessionRecord[] = [],
): Promise<AnalyticsSnapshot> {
	const generationCounts: number[] = [];
	const seenRunIds = new Set<string>();
	const skills = new Map<string, SkillStats>();
	const tools = new Map<string, ToolStats & { totalDurationMs: number }>();
	const categories = Object.fromEntries(
		ERROR_CATEGORIES.map((category) => [category, 0]),
	) as Record<ProviderErrorCategory, number>;
	let toolErrors = 0;
	let providerErrors = 0;
	let recoveredErrors = 0;
	let http429 = 0;
	let http5xx = 0;
	let terminal = 0;
	const tokenModels = new Map<string, ModelTokenStats>();
	const tokenTotals: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	let measuredCalls = 0;
	let unmeasuredCalls = 0;

	for await (const run of runs) {
		throwIfAborted(signal);
		if (seenRunIds.has(run.id)) continue;
		seenRunIds.add(run.id);
		if (run.startedAtMs < range.fromMs || run.startedAtMs >= range.toMs) continue;
		generationCounts.push(run.generations.length);
		toolErrors += run.toolErrorCount;
		providerErrors += run.providerErrorCount;
		recoveredErrors += run.recoveredErrorCount;

		for (const skill of run.skills) {
			const item = skills.get(skill.name) ?? {
				name: skill.name,
				count: 0,
				modelInitiated: 0,
				userInitiated: 0,
				lastOccurredAtMs: 0,
				models: [],
			};
			item.count += 1;
			if (skill.initiatedBy === "user") item.userInitiated += 1;
			else item.modelInitiated += 1;
			item.lastOccurredAtMs = Math.max(item.lastOccurredAtMs, skill.occurredAtMs);
			mergeModelCount(item.models, {
				provider: skill.provider,
				model: skill.model,
				count: 1,
			});
			skills.set(skill.name, item);
		}

		for (const tool of run.tools) {
			const item = tools.get(tool.name) ?? {
				name: tool.name,
				count: 0,
				errors: 0,
				averageDurationMs: 0,
				totalDurationMs: 0,
				lastOccurredAtMs: 0,
				models: [],
			};
			item.count += 1;
			item.errors += tool.isError ? 1 : 0;
			item.totalDurationMs += tool.durationMs ?? 0;
			item.averageDurationMs = item.totalDurationMs / item.count;
			item.lastOccurredAtMs = Math.max(item.lastOccurredAtMs, tool.startedAtMs);
			mergeModelCount(item.models, {
				provider: tool.provider,
				model: tool.model,
				count: 1,
			});
			tools.set(tool.name, item);
		}

		for (const error of run.providerErrors) {
			categories[error.category] += 1;
			terminal += error.terminal ? 1 : 0;
		}
		for (const generation of run.generations) {
			for (const response of generation.responses) {
				if (response.status === 429) http429 += 1;
				if (response.status >= 500 && response.status < 600) http5xx += 1;
			}
			const usage = generation.usage;
			if (!usage) {
				unmeasuredCalls += 1;
				continue;
			}
			measuredCalls += 1;
			tokenTotals.input += usage.input;
			tokenTotals.output += usage.output;
			tokenTotals.cacheRead += usage.cacheRead;
			tokenTotals.cacheWrite += usage.cacheWrite;
			tokenTotals.cost += usage.cost;
			const key = `${generation.provider ?? ""}/${generation.model ?? ""}`;
			const item = tokenModels.get(key) ?? {
				provider: generation.provider,
				model: generation.model,
				calls: 0,
				tokens: 0,
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
			};
			item.calls += 1;
			item.input += usage.input;
			item.output += usage.output;
			item.cacheRead += usage.cacheRead;
			item.cacheWrite += usage.cacheWrite;
			item.cost += usage.cost;
			item.tokens = item.input + item.output + item.cacheRead + item.cacheWrite;
			tokenModels.set(key, item);
		}
	}

	const responses = responseStatistics(generationCounts);
	return {
		overview: {
			responseCycles: responses.count,
			llmCalls: responses.llmCalls,
			callsPerResponse: responses.average,
			p95CallsPerResponse: responses.p95,
			toolCalls: sum([...tools.values()].map(({ count }) => count)),
			toolErrors,
			skillActivations: sum([...skills.values()].map(({ count }) => count)),
			providerErrors,
			recoveredErrors,
		},
		skills: [...skills.values()]
			.map((item) => ({ ...item, models: sortModels(item.models) }))
			.sort((left, right) => right.count - left.count || left.name.localeCompare(right.name)),
		tools: [...tools.values()]
			.map(({ totalDurationMs: _, ...item }) => ({ ...item, models: sortModels(item.models) }))
			.sort((left, right) => right.count - left.count || left.name.localeCompare(right.name)),
		reliability: {
			http429,
			http5xx,
			recovered: recoveredErrors,
			terminal,
			categories,
		},
		responses,
		sessions: sessionStatistics(sessions, range),
		tokens: {
			...tokenTotals,
			tokens:
				tokenTotals.input + tokenTotals.output + tokenTotals.cacheRead + tokenTotals.cacheWrite,
			measuredCalls,
			unmeasuredCalls,
			cacheHitRate: cacheHitRate(tokenTotals),
			models: [...tokenModels.values()].sort(
				(left, right) =>
					right.tokens - left.tokens ||
					`${left.provider ?? ""}/${left.model ?? ""}`.localeCompare(
						`${right.provider ?? ""}/${right.model ?? ""}`,
					),
			),
		},
	};
}

function sessionStatistics(sessions: readonly SessionRecord[], range: TimeRange): SessionStats {
	const days = new Map<string, ActivityDay>();
	const projects = new Map<string, ProjectStats>();
	let llmCalls = 0;
	let totalDurationMs = 0;
	let longestDurationMs = 0;

	for (const session of sessions) {
		const tokens =
			session.usage.input +
			session.usage.output +
			session.usage.cacheRead +
			session.usage.cacheWrite;
		llmCalls += session.llmCalls;
		const durationMs = Math.max(0, session.endedAtMs - session.startedAtMs);
		totalDurationMs += durationMs;
		longestDurationMs = Math.max(longestDurationMs, durationMs);

		const date = localDate(session.startedAtMs);
		const day = days.get(date) ?? { date, sessions: 0, llmCalls: 0, tokens: 0, cost: 0 };
		day.sessions += 1;
		day.llmCalls += session.llmCalls;
		day.tokens += tokens;
		day.cost += session.usage.cost;
		days.set(date, day);

		const project = projects.get(session.project) ?? {
			project: session.project,
			sessions: 0,
			llmCalls: 0,
			tokens: 0,
			cost: 0,
		};
		project.sessions += 1;
		project.llmCalls += session.llmCalls;
		project.tokens += tokens;
		project.cost += session.usage.cost;
		projects.set(session.project, project);
	}

	const ordered = [...days.values()].sort((left, right) => left.date.localeCompare(right.date));
	const streaks = streakLengths(
		ordered.map(({ date }) => date),
		localDate(range.toMs - 1),
	);
	return {
		count: sessions.length,
		llmCalls,
		activeDays: ordered.length,
		totalDays: spannedDays(ordered, range),
		longestStreak: streaks.longest,
		currentStreak: streaks.current,
		tokens: ordered.reduce((total, day) => total + day.tokens, 0),
		cost: ordered.reduce((total, day) => total + day.cost, 0),
		averageDurationMs: sessions.length > 0 ? totalDurationMs / sessions.length : 0,
		longestDurationMs,
		projects: [...projects.values()].sort(
			(left, right) => right.sessions - left.sessions || left.project.localeCompare(right.project),
		),
		days: ordered,
	};
}

/**
 * Counts consecutive active days. The current streak is anchored to the range's last day so a
 * range that ends in the past still reports the streak as it stood then, and a gap of one day
 * (yesterday active, today not) keeps the streak alive.
 */
function streakLengths(
	dates: readonly string[],
	lastDate: string,
): { longest: number; current: number } {
	let longest = 0;
	let running = 0;
	let previous: string | undefined;
	let trailing = 0;
	for (const date of dates) {
		running = previous !== undefined && date === nextDate(previous) ? running + 1 : 1;
		longest = Math.max(longest, running);
		previous = date;
		trailing = running;
	}
	if (previous === undefined) return { longest: 0, current: 0 };
	const current = previous === lastDate || nextDate(previous) === lastDate ? trailing : 0;
	return { longest, current };
}

function spannedDays(days: readonly ActivityDay[], range: TimeRange): number {
	const first = days[0];
	if (!first) return 0;
	const fromMs = Math.max(range.fromMs, startOfLocalDay(first.date));
	const dayCount = Math.ceil((range.toMs - fromMs) / DAY_MS);
	return Math.max(days.length, dayCount);
}

function localDate(value: number): string {
	const date = new Date(value);
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

function startOfLocalDay(date: string): number {
	const [year, month, day] = date.split("-").map(Number);
	return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1).getTime();
}

function nextDate(date: string): string {
	return localDate(startOfLocalDay(date) + DAY_MS + DAY_MS / 2);
}

// Share of prompt tokens served from cache; cache writes count as prompt tokens that missed.
function cacheHitRate(totals: TokenTotals): number {
	const prompt = totals.input + totals.cacheRead + totals.cacheWrite;
	return prompt > 0 ? (totals.cacheRead / prompt) * 100 : 0;
}

function responseStatistics(generationCounts: number[]): ResponseStats {
	const sorted = [...generationCounts].sort((left, right) => left - right);
	const count = sorted.length;
	const llmCalls = sum(sorted);
	const nearestRank = (percentile: number) =>
		count === 0 ? 0 : (sorted[Math.max(0, Math.ceil(percentile * count) - 1)] ?? 0);
	const median =
		count === 0
			? 0
			: count % 2 === 1
				? (sorted[Math.floor(count / 2)] ?? 0)
				: ((sorted[count / 2 - 1] ?? 0) + (sorted[count / 2] ?? 0)) / 2;
	return {
		count,
		llmCalls,
		average: count > 0 ? llmCalls / count : 0,
		median,
		p95: nearestRank(0.95),
		maximum: sorted.at(-1) ?? 0,
		distribution: {
			one: sorted.filter((value) => value === 1).length,
			twoToThree: sorted.filter((value) => value >= 2 && value <= 3).length,
			fourToSix: sorted.filter((value) => value >= 4 && value <= 6).length,
			sevenPlus: sorted.filter((value) => value >= 7).length,
		},
	};
}

function mergeModelCount(models: ModelCount[], next: ModelCount): void {
	const existing = models.find(
		({ provider, model }) => provider === next.provider && model === next.model,
	);
	if (existing) existing.count += next.count;
	else models.push(next);
}

function sortModels(models: ModelCount[]): ModelCount[] {
	return models.sort(
		(left, right) =>
			right.count - left.count ||
			`${left.provider ?? ""}/${left.model ?? ""}`.localeCompare(
				`${right.provider ?? ""}/${right.model ?? ""}`,
			),
	);
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted)
		throw signal.reason ?? new DOMException("Analytics query aborted", "AbortError");
}

function sum(values: readonly number[]): number {
	return values.reduce((total, value) => total + value, 0);
}
