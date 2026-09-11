import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { sanitizeTerminalText } from "./message-broker.js";
import {
	CHILD_CORE_TOOL_NAMES,
	DEFAULT_SUBAGENT_TOOLS,
	SUBAGENT_THINKING_LEVELS,
	type SubagentThinkingLevel,
} from "./types.js";

/** Agent bodies become a child system prompt, so they are bounded like a task. */
const MAX_BODY_BYTES = 50 * 1024;
const MAX_DESCRIPTION_LENGTH = 200;
const MAX_AGENTS_PER_DIRECTORY = 64;
const AGENT_NAME = /^[a-z0-9][a-z0-9_-]*$/;

const CORE_TOOL_SET = new Set<string>(CHILD_CORE_TOOL_NAMES);
const THINKING_LEVEL_SET = new Set<string>(SUBAGENT_THINKING_LEVELS);

/** Scan order is precedence order: the first directory defining a name wins. */
export const AGENT_DIRECTORY_KINDS = ["pi", "claude", "agents"] as const;
export type AgentDirectoryKind = (typeof AGENT_DIRECTORY_KINDS)[number];

export interface AgentDefinition {
	/** Lower-cased lookup name, always matching the `name` frontmatter or filename. */
	name: string;
	description: string;
	/** Markdown body appended to the child's system prompt. */
	body: string;
	/** Alias or `provider/modelId`; resolved against the parent's registry at spawn time. */
	model?: string;
	thinkingLevel?: SubagentThinkingLevel;
	tools: string[];
	source: string;
	origin: AgentDirectoryKind;
}

export interface AgentDiscovery {
	agents: Map<string, AgentDefinition>;
	diagnostics: string[];
}

/**
 * Pi's own agent directory, honouring `PI_CODING_AGENT_DIR` the way Pi does so
 * tests and alternate installs stay consistent with the rest of the agent state.
 */
export function piAgentDirectory(): string {
	const override = process.env.PI_CODING_AGENT_DIR;
	if (override?.trim()) return path.resolve(override.trim());
	return path.join(os.homedir(), ".pi", "agent");
}

/**
 * Directories scanned for agent definitions, in precedence order. Only the first
 * entry is loaded by default; the rest are consulted for on-demand lookups.
 */
export function agentDirectories(): Array<{ kind: AgentDirectoryKind; directory: string }> {
	const home = os.homedir();
	return [
		{ kind: "pi", directory: path.join(piAgentDirectory(), "agents") },
		{ kind: "claude", directory: path.join(home, ".claude", "agents") },
		{ kind: "agents", directory: path.join(home, ".agents", "agents") },
	];
}

/** Load the Pi-owned directory only. This is what the main session sees by default. */
export function discoverPrimaryAgents(): AgentDiscovery {
	const [primary] = agentDirectories();
	return discoverAgents([primary]);
}

/** Load every directory, first definition of a name winning. Used for on-demand lookups. */
export function discoverAllAgents(): AgentDiscovery {
	return discoverAgents(agentDirectories());
}

function discoverAgents(
	directories: Array<{ kind: AgentDirectoryKind; directory: string }>,
): AgentDiscovery {
	const agents = new Map<string, AgentDefinition>();
	const diagnostics: string[] = [];
	for (const { kind, directory } of directories) {
		for (const file of listAgentFiles(directory, diagnostics)) {
			const definition = readAgentFile(file, kind, diagnostics);
			// First directory to define a name wins; later ones never override it.
			if (definition && !agents.has(definition.name)) agents.set(definition.name, definition);
		}
	}
	return { agents, diagnostics };
}

function listAgentFiles(directory: string, diagnostics: string[]): string[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(directory, { withFileTypes: true });
	} catch (error) {
		// A missing directory is the normal case for the optional lookup paths.
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			diagnostics.push(`Cannot read agent directory ${directory}: ${errorText(error)}`);
		}
		return [];
	}
	const files = entries
		.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
		.map((entry) => path.join(directory, entry.name))
		.sort();
	if (files.length > MAX_AGENTS_PER_DIRECTORY) {
		diagnostics.push(
			`Agent directory ${directory} has more than ${MAX_AGENTS_PER_DIRECTORY} definitions; only the first ${MAX_AGENTS_PER_DIRECTORY} are loaded.`,
		);
		return files.slice(0, MAX_AGENTS_PER_DIRECTORY);
	}
	return files;
}

function readAgentFile(
	file: string,
	origin: AgentDirectoryKind,
	diagnostics: string[],
): AgentDefinition | undefined {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch (error) {
		diagnostics.push(`Cannot read agent ${file}: ${errorText(error)}`);
		return undefined;
	}
	if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
		diagnostics.push(`Agent ${file} exceeds ${MAX_BODY_BYTES} bytes.`);
		return undefined;
	}

	const { frontmatter, body: rawBody } = parseFrontmatter<Record<string, unknown>>(raw);
	const fallbackName = path.basename(file, path.extname(file));
	const name = normalizeAgentName(readString(frontmatter?.name) ?? fallbackName);
	if (!name) {
		diagnostics.push(
			`Agent ${file} has an invalid name; use lowercase letters, digits, hyphens, and underscores.`,
		);
		return undefined;
	}

	const body = rawBody.trim();
	if (!body) {
		diagnostics.push(`Agent ${file} has an empty body.`);
		return undefined;
	}

	const tools = readTools(frontmatter?.tools, file, diagnostics);
	const thinkingLevel = readThinkingLevel(frontmatter?.thinkingLevel, file, diagnostics);
	const model = readString(frontmatter?.model);

	return {
		name,
		description: readDescription(frontmatter?.description, name),
		body,
		...(model ? { model } : {}),
		...(thinkingLevel ? { thinkingLevel } : {}),
		tools,
		source: file,
		origin,
	};
}

/** Names are matched case-insensitively, so they are stored and compared lower-cased. */
export function normalizeAgentName(value: string): string | undefined {
	const name = value.trim().toLowerCase();
	return AGENT_NAME.test(name) ? name : undefined;
}

function readDescription(value: unknown, name: string): string {
	const description = readString(value);
	if (!description) return name;
	const flattened = sanitizeTerminalText(description).replace(/\s+/g, " ").trim();
	return flattened.length > MAX_DESCRIPTION_LENGTH
		? `${flattened.slice(0, MAX_DESCRIPTION_LENGTH - 1)}…`
		: flattened;
}

function readTools(value: unknown, file: string, diagnostics: string[]): string[] {
	if (value === undefined || value === null) return [...DEFAULT_SUBAGENT_TOOLS];
	const candidates = Array.isArray(value)
		? value
		: typeof value === "string"
			? value.split(",")
			: undefined;
	if (!candidates) {
		diagnostics.push(`Agent ${file} has an invalid tools value; using the read-only default.`);
		return [...DEFAULT_SUBAGENT_TOOLS];
	}
	const tools: string[] = [];
	for (const candidate of candidates) {
		if (typeof candidate !== "string") continue;
		const tool = candidate.trim().toLowerCase();
		if (!tool) continue;
		if (!CORE_TOOL_SET.has(tool)) {
			diagnostics.push(`Agent ${file} requests unavailable tool ${tool}; it is ignored.`);
			continue;
		}
		if (!tools.includes(tool)) tools.push(tool);
	}
	return tools;
}

function readThinkingLevel(
	value: unknown,
	file: string,
	diagnostics: string[],
): SubagentThinkingLevel | undefined {
	const level = readString(value)?.toLowerCase();
	if (!level) return undefined;
	if (!THINKING_LEVEL_SET.has(level)) {
		diagnostics.push(`Agent ${file} has an invalid thinkingLevel ${level}; it is ignored.`);
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
