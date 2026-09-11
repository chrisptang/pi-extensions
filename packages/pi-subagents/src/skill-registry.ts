import {
	discoverAllSkills,
	discoverPrimarySkills,
	normalizeSkillName,
	type SkillDefinition,
} from "./skill-definitions.js";

/**
 * Two-tier skill lookup.
 *
 * The primary tier is the project and Pi skill directories, and it is the only
 * tier `skill_run` advertises. A name that is not there is looked up across the
 * Claude and shared directories on demand, which lets a large installed skill
 * set stay reachable without spending roster text on every entry.
 */
export class SkillRegistry {
	private primary: Map<string, SkillDefinition> | undefined;
	private fallback: Map<string, SkillDefinition> | undefined;
	private diagnostics: string[] = [];
	private cwd = process.cwd();

	constructor(
		private readonly loadPrimary: (
			cwd: string,
		) => ReturnType<typeof discoverPrimarySkills> = discoverPrimarySkills,
		private readonly loadAll: (
			cwd: string,
		) => ReturnType<typeof discoverAllSkills> = discoverAllSkills,
	) {}

	/** Drop cached scans so a session picks up files written since the last one. */
	reset(cwd?: string): void {
		if (cwd) this.cwd = cwd;
		this.primary = undefined;
		this.fallback = undefined;
		this.diagnostics = [];
	}

	/** Model-invocable definitions from the primary tier, sorted by name. */
	listPrimary(): SkillDefinition[] {
		return [...this.ensurePrimary().values()]
			.filter((definition) => !definition.disableModelInvocation)
			.sort((left, right) => left.name.localeCompare(right.name));
	}

	/** Diagnostics from the primary scan, for the command surface. */
	primaryDiagnostics(): string[] {
		this.ensurePrimary();
		return [...this.diagnostics];
	}

	/**
	 * Find one skill by name, case-insensitively. The primary tier is consulted
	 * first; only a miss there triggers the wider scan.
	 *
	 * `disable-model-invocation` hides a skill from the roster but does not make
	 * it unreachable: the user asking for it by name is an explicit invocation,
	 * which is exactly what that flag reserves the skill for.
	 */
	find(requested: string): SkillDefinition | undefined {
		const name = normalizeSkillName(requested);
		if (!name) return undefined;
		const primary = this.ensurePrimary().get(name);
		if (primary) return primary;
		if (!this.fallback) this.fallback = this.loadAll(this.cwd).skills;
		return this.fallback.get(name);
	}

	/** Names available for an error message, primary tier first. */
	knownNames(): string[] {
		const names = new Set(this.ensurePrimary().keys());
		if (this.fallback) for (const name of this.fallback.keys()) names.add(name);
		return [...names].sort();
	}

	private ensurePrimary(): Map<string, SkillDefinition> {
		if (!this.primary) {
			const discovery = this.loadPrimary(this.cwd);
			this.primary = discovery.skills;
			this.diagnostics = discovery.diagnostics;
		}
		return this.primary;
	}
}
