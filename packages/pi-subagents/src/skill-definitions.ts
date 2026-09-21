import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { piAgentDirectory } from "./agent-definitions.js";
import { isInheritedModel } from "./agent-model.js";
import { sanitizeTerminalText } from "./text.js";
import {
	CHILD_CORE_TOOL_NAMES,
	DEFAULT_SUBAGENT_TOOLS,
	SUBAGENT_THINKING_LEVELS,
	type SubagentThinkingLevel,
} from "./types.js";

/**
 * A skill body is delivered through `--append-system-prompt`, an argv entry, so
 * the ceiling is the OS argument limit rather than the 50 KiB task bound. The
 * limit below keeps a single skill far away from that ceiling while still
 * admitting the large design-oriented skills that exist in practice.
 */
const MAX_BODY_BYTES = 256 * 1024;
const MAX_DESCRIPTION_LENGTH = 200;
const MAX_SKILLS_PER_DIRECTORY = 256;
const SKILL_NAME = /^[a-z0-9][a-z0-9._-]*$/;

const CORE_TOOL_SET = new Set<string>(CHILD_CORE_TOOL_NAMES);
const THINKING_LEVEL_SET = new Set<string>(SUBAGENT_THINKING_LEVELS);

/**
 * Claude Code tool names mapped onto Pi's child work tools.
 *
 * Skills authored for Claude Code declare `allowed-tools` in Claude's
 * vocabulary, optionally scoped (`Bash(git:*)`). Pi children accept only the
 * unscoped core names, so the scope is dropped and the base name translated.
 * Names with no Pi equivalent (Task, Skill, AskUserQuestion, Artifact, MCP
 * tools) carry no capability into a child and are reported, not silently kept.
 */
const CLAUDE_TOOL_ALIASES = new Map<string, string>([
	["read", "read"],
	["write", "write"],
	["edit", "edit"],
	["multiedit", "edit"],
	["notebookedit", "edit"],
	["bash", "bash"],
	["bashoutput", "bash"],
	["powershell", "powershell"],
	["grep", "grep"],
	["glob", "find"],
	["find", "find"],
	["ls", "ls"],
]);

/** Scan order is precedence order: the first directory defining a name wins. */
export const SKILL_DIRECTORY_KINDS = ["project", "pi", "claude", "agents"] as const;
export type SkillDirectoryKind = (typeof SKILL_DIRECTORY_KINDS)[number];

export interface SkillDefinition {
	/** Lower-cased lookup name, from the `name` frontmatter or the directory. */
	name: string;
	description: string;
	/** Markdown body, appended to the child's system prompt. */
	body: string;
	/** Directory holding SKILL.md; relative references resolve against it. */
	baseDir: string;
	/** Alias or `provider/modelId`; resolved against the parent registry at spawn. */
	model?: string;
	thinkingLevel?: SubagentThinkingLevel;
	tools: string[];
	/** True when frontmatter declared tools, so an explicit empty list is honoured. */
	toolsDeclared: boolean;
	/** Claude-only tool names that cannot be granted to a Pi child. */
	unsupportedTools: string[];
	/** Set by `disable-model-invocation`; such skills stay hidden from the roster. */
	disableModelInvocation: boolean;
	/**
	 * Set by Claude Code's `content: fork`. A user's `/skill:<name>` for such a
	 * skill runs in a subagent instead of expanding into the main session.
	 */
	fork: boolean;
	source: string;
	origin: SkillDirectoryKind;
}

export interface SkillDiscovery {
	skills: Map<string, SkillDefinition>;
	diagnostics: string[];
}

/**
 * Directories scanned for skills, in precedence order.
 *
 * The project directory comes first so a repository can override a global skill,
 * matching how Pi itself resolves project resources ahead of global ones.
 */
export function skillDirectories(
	cwd: string,
): Array<{ kind: SkillDirectoryKind; directory: string }> {
	const home = os.homedir();
	return [
		{ kind: "project", directory: path.join(cwd, ".pi", "skills") },
		{ kind: "pi", directory: path.join(piAgentDirectory(), "skills") },
		{ kind: "claude", directory: path.join(home, ".claude", "skills") },
		{ kind: "agents", directory: path.join(home, ".agents", "skills") },
	];
}

/**
 * Load the project and Pi directories only. This is the roster the main session
 * advertises; Claude and shared directories stay reachable by on-demand lookup.
 */
export function discoverPrimarySkills(cwd: string): SkillDiscovery {
	return discoverSkills(skillDirectories(cwd).slice(0, 2));
}

/** Load every directory, the first definition of a name winning. */
export function discoverAllSkills(cwd: string): SkillDiscovery {
	return discoverSkills(skillDirectories(cwd));
}

function discoverSkills(
	directories: Array<{ kind: SkillDirectoryKind; directory: string }>,
): SkillDiscovery {
	const skills = new Map<string, SkillDefinition>();
	const diagnostics: string[] = [];
	for (const { kind, directory } of directories) {
		for (const file of listSkillFiles(directory, diagnostics)) {
			const definition = readSkillFile(file, kind, diagnostics);
			// First directory to define a name wins; later ones never override it.
			if (definition && !skills.has(definition.name)) skills.set(definition.name, definition);
		}
	}
	return { skills, diagnostics };
}

/**
 * Collect `<directory>/<skill>/SKILL.md` entries.
 *
 * Only this one shape is scanned. Pi also discovers loose root `.md` files and
 * recurses arbitrarily deep, but a skill run as a subagent needs a stable base
 * directory for its relative references, which the directory form guarantees.
 */
function listSkillFiles(directory: string, diagnostics: string[]): string[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(directory, { withFileTypes: true });
	} catch (error) {
		// A missing directory is the normal case for the optional lookup paths.
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			diagnostics.push(`Cannot read skill directory ${directory}: ${errorText(error)}`);
		}
		return [];
	}
	const files: string[] = [];
	for (const entry of entries) {
		// Symlinked skill directories are normal here: the shared `.agents/skills`
		// tree is commonly linked into `~/.pi/agent/skills` one entry at a time.
		if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
		if (entry.name.startsWith(".")) continue;
		const candidate = path.join(directory, entry.name, "SKILL.md");
		if (fs.existsSync(candidate)) files.push(candidate);
	}
	files.sort();
	if (files.length > MAX_SKILLS_PER_DIRECTORY) {
		diagnostics.push(
			`Skill directory ${directory} has more than ${MAX_SKILLS_PER_DIRECTORY} skills; only the first ${MAX_SKILLS_PER_DIRECTORY} are loaded.`,
		);
		return files.slice(0, MAX_SKILLS_PER_DIRECTORY);
	}
	return files;
}

function readSkillFile(
	file: string,
	origin: SkillDirectoryKind,
	diagnostics: string[],
): SkillDefinition | undefined {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch (error) {
		diagnostics.push(`Cannot read skill ${file}: ${errorText(error)}`);
		return undefined;
	}
	if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
		diagnostics.push(`Skill ${file} exceeds ${MAX_BODY_BYTES} bytes.`);
		return undefined;
	}

	const { frontmatter, body: rawBody } = parseFrontmatter<Record<string, unknown>>(raw);
	const baseDir = path.dirname(file);
	const name = normalizeSkillName(readString(frontmatter?.name) ?? path.basename(baseDir));
	if (!name) {
		diagnostics.push(
			`Skill ${file} has an invalid name; use lowercase letters, digits, dots, hyphens, and underscores.`,
		);
		return undefined;
	}

	const body = rawBody.trim();
	if (!body) {
		diagnostics.push(`Skill ${file} has an empty body.`);
		return undefined;
	}

	const { tools, declared, unsupported } = readTools(
		frontmatter?.["allowed-tools"],
		file,
		diagnostics,
	);
	const thinkingLevel = readThinkingLevel(frontmatter?.thinkingLevel, file, diagnostics);
	const model = readModel(frontmatter?.model);

	return {
		name,
		description: readDescription(frontmatter?.description, name),
		body,
		baseDir,
		...(model ? { model } : {}),
		...(thinkingLevel ? { thinkingLevel } : {}),
		tools,
		toolsDeclared: declared,
		unsupportedTools: unsupported,
		disableModelInvocation: frontmatter?.["disable-model-invocation"] === true,
		fork: frontmatter?.content === "fork",
		source: file,
		origin,
	};
}

/** Names are matched case-insensitively, so they are stored lower-cased. */
export function normalizeSkillName(value: string): string | undefined {
	const name = value.trim().toLowerCase();
	return SKILL_NAME.test(name) ? name : undefined;
}

/**
 * `model: inherit` means "keep the main agent's model", which is what omitting
 * the field already does, so it is normalized away at read time. The resolver
 * treats it the same way; dropping it here keeps the stored definition honest
 * about declaring no model.
 */
function readModel(value: unknown): string | undefined {
	const model = readString(value);
	return !model || isInheritedModel(model) ? undefined : model;
}

function readDescription(value: unknown, name: string): string {
	const description = readString(value);
	if (!description) return name;
	const flattened = sanitizeTerminalText(description).replace(/\s+/g, " ").trim();
	return flattened.length > MAX_DESCRIPTION_LENGTH
		? `${flattened.slice(0, MAX_DESCRIPTION_LENGTH - 1)}…`
		: flattened;
}

/**
 * Translate `allowed-tools` into Pi child work tools.
 *
 * Accepts both YAML list and comma-separated string forms, and tolerates the
 * scoped `Bash(git:*)` spelling by keeping only the base name.
 */
function readTools(
	value: unknown,
	file: string,
	diagnostics: string[],
): { tools: string[]; declared: boolean; unsupported: string[] } {
	if (value === undefined || value === null) {
		return { tools: [...DEFAULT_SUBAGENT_TOOLS], declared: false, unsupported: [] };
	}
	const candidates = Array.isArray(value)
		? value
		: typeof value === "string"
			? splitToolList(value)
			: undefined;
	if (!candidates) {
		diagnostics.push(
			`Skill ${file} has an invalid allowed-tools value; using the read-only default.`,
		);
		return { tools: [...DEFAULT_SUBAGENT_TOOLS], declared: false, unsupported: [] };
	}
	const tools: string[] = [];
	const unsupported: string[] = [];
	for (const candidate of candidates) {
		if (typeof candidate !== "string") continue;
		const raw = candidate.trim();
		if (!raw) continue;
		const base = toolBaseName(raw);
		if (!base) continue;
		const mapped = CLAUDE_TOOL_ALIASES.get(base) ?? (CORE_TOOL_SET.has(base) ? base : undefined);
		if (!mapped) {
			const label = sanitizeTerminalText(raw).slice(0, 64);
			if (label && !unsupported.includes(label)) unsupported.push(label);
			continue;
		}
		if (!tools.includes(mapped)) tools.push(mapped);
	}
	return { tools, declared: true, unsupported };
}

/**
 * Split a comma-separated list without breaking the commas inside a tool's
 * scope, as in `Bash(du:*), Bash(df:*)`.
 */
function splitToolList(value: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let current = "";
	for (const character of value) {
		if (character === "(") depth++;
		else if (character === ")") depth = Math.max(0, depth - 1);
		if (character === "," && depth === 0) {
			parts.push(current);
			current = "";
			continue;
		}
		current += character;
	}
	parts.push(current);
	return parts;
}

/** `Bash(git:*)` and `"Read(*)"` both reduce to their base name. */
function toolBaseName(value: string): string {
	const unquoted = value.replace(/^["']|["']$/g, "").trim();
	const parenthesis = unquoted.indexOf("(");
	const base = parenthesis === -1 ? unquoted : unquoted.slice(0, parenthesis);
	return base.trim().toLowerCase();
}

function readThinkingLevel(
	value: unknown,
	file: string,
	diagnostics: string[],
): SubagentThinkingLevel | undefined {
	const level = readString(value)?.toLowerCase();
	if (!level) return undefined;
	if (!THINKING_LEVEL_SET.has(level)) {
		diagnostics.push(`Skill ${file} has an invalid thinkingLevel ${level}; it is ignored.`);
		return undefined;
	}
	return level as SubagentThinkingLevel;
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
