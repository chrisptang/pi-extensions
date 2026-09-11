import {
	type AgentDefinition,
	discoverAllAgents,
	discoverPrimaryAgents,
	normalizeAgentName,
} from "./agent-definitions.js";

/**
 * Two-tier agent lookup.
 *
 * The primary tier is `~/.pi/agent/agents/` alone, and it is the only tier the
 * main session advertises. A name that is not there is looked up across the
 * fallback directories on demand, which is what lets a skill name an agent the
 * session never loaded without paying for every definition up front.
 */
export class AgentRegistry {
	private primary: Map<string, AgentDefinition> | undefined;
	private fallback: Map<string, AgentDefinition> | undefined;
	private diagnostics: string[] = [];
	/**
	 * Seeding happens once at load, before any scan, so its diagnostics would
	 * otherwise be lost. They are kept here and reported alongside the scan's,
	 * which is how a silently replaced built-in becomes visible in `/agents`.
	 */
	private seedDiagnostics: string[] = [];

	constructor(
		private readonly loadPrimary: () => ReturnType<
			typeof discoverPrimaryAgents
		> = discoverPrimaryAgents,
		private readonly loadAll: () => ReturnType<typeof discoverAllAgents> = discoverAllAgents,
	) {}

	/** Drop cached scans so a session picks up files written since the last one. */
	reset(): void {
		this.primary = undefined;
		this.fallback = undefined;
		this.diagnostics = [];
		// Seed diagnostics are not rescanned, so they deliberately survive a reset.
	}

	/** Record what seeding did, so `/agents` can report a replaced built-in. */
	noteSeed(diagnostics: readonly string[]): void {
		this.seedDiagnostics = [...diagnostics];
	}

	/** Definitions from the Pi directory only, sorted by name. */
	listPrimary(): AgentDefinition[] {
		return [...this.ensurePrimary().values()].sort((left, right) =>
			left.name.localeCompare(right.name),
		);
	}

	/** Seed and primary-scan diagnostics, for the command surface. */
	primaryDiagnostics(): string[] {
		this.ensurePrimary();
		return [...this.seedDiagnostics, ...this.diagnostics];
	}

	/**
	 * Find one agent by name, case-insensitively. The Pi directory is consulted
	 * first; only a miss there triggers the wider scan.
	 */
	find(requested: string): AgentDefinition | undefined {
		const name = normalizeAgentName(requested);
		if (!name) return undefined;
		const primary = this.ensurePrimary().get(name);
		if (primary) return primary;
		if (!this.fallback) this.fallback = this.loadAll().agents;
		return this.fallback.get(name);
	}

	/** Names available for an error message, primary tier first. */
	knownNames(): string[] {
		const names = new Set(this.ensurePrimary().keys());
		if (this.fallback) for (const name of this.fallback.keys()) names.add(name);
		return [...names].sort();
	}

	private ensurePrimary(): Map<string, AgentDefinition> {
		if (!this.primary) {
			const discovery = this.loadPrimary();
			this.primary = discovery.agents;
			this.diagnostics = discovery.diagnostics;
		}
		return this.primary;
	}
}
