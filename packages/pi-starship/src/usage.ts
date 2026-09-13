import type { SessionEntry } from "@earendil-works/pi-coding-agent";

interface UsageLike {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number };
}

export interface FooterUsageSummary {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	hasUsage: boolean;
	latestCacheHitRate?: number;
	sessionCacheHitRate?: number;
}

export function summarizeFooterUsage(entries: readonly SessionEntry[]): FooterUsageSummary {
	const totals: FooterUsageSummary = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		hasUsage: false,
	};

	for (const entry of entries) {
		let usage: UsageLike | undefined;
		if (entry.type === "message" && entry.message.role === "assistant") {
			usage = entry.message.usage;
			if (usage) {
				const input = usage.input ?? 0;
				const cacheRead = usage.cacheRead ?? 0;
				const cacheWrite = usage.cacheWrite ?? 0;
				const promptTokens = input + cacheRead + cacheWrite;
				totals.latestCacheHitRate = promptTokens > 0 ? (cacheRead / promptTokens) * 100 : undefined;
			}
		} else if (entry.type === "message" && entry.message.role === "toolResult") {
			usage = entry.message.usage;
		} else if (entry.type === "compaction" || entry.type === "branch_summary") {
			usage = entry.usage;
		}
		if (!usage) continue;

		totals.hasUsage = true;
		totals.input += usage.input ?? 0;
		totals.output += usage.output ?? 0;
		totals.cacheRead += usage.cacheRead ?? 0;
		totals.cacheWrite += usage.cacheWrite ?? 0;
		totals.cost += usage.cost?.total ?? 0;
	}

	const promptTokens = totals.input + totals.cacheRead + totals.cacheWrite;
	totals.sessionCacheHitRate =
		promptTokens > 0 ? (totals.cacheRead / promptTokens) * 100 : undefined;
	return totals;
}
