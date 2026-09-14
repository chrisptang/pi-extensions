import type { SessionRecord, SettledRun } from "../types.js";
import { AnalyticsDatabase, type ClearAnalyticsResult } from "./database.js";
import { type AnalyticsSnapshot, querySnapshot, type TimeRange } from "./queries.js";

export class AnalyticsStore {
	private readonly database: AnalyticsDatabase;

	constructor(
		databasePath: string,
		dependencies: {
			database?: AnalyticsDatabase;
			busyTimeoutMs?: number;
		} = {},
	) {
		this.database =
			dependencies.database ??
			new AnalyticsDatabase(databasePath, { busyTimeoutMs: dependencies.busyTimeoutMs });
	}

	get path(): string {
		return this.database.path;
	}

	recordRun(run: SettledRun, signal?: AbortSignal): Promise<void> {
		return this.database.recordRun(run, signal);
	}

	recordSessions(sessions: readonly SessionRecord[], signal?: AbortSignal): Promise<void> {
		return this.database.recordSessions(sessions, signal);
	}

	async getSnapshot(range: TimeRange, signal?: AbortSignal): Promise<AnalyticsSnapshot> {
		const runs = await this.database.readRuns(range.fromMs, range.toMs, signal);
		const sessions = await this.database.readSessions(range.fromMs, range.toMs, signal);
		return querySnapshot(runs, range, signal, sessions);
	}

	clearAll(signal?: AbortSignal): Promise<ClearAnalyticsResult> {
		return this.database.clearAll(signal);
	}

	close(): Promise<void> {
		return this.database.close();
	}
}
