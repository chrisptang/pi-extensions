import * as fs from "node:fs";
import * as path from "node:path";
import { piAgentDirectory } from "./agent-definitions.js";

/**
 * User-supplied replacements for the tool text the main session reads.
 *
 * A model that ignores a rule cannot be argued with from inside the extension,
 * so the wording is made the user's to own. The file replaces the shipped
 * `description` and `promptGuidelines` outright rather than appending to them:
 * an appended rule competes with the built-in sentence it was written to
 * correct, and the losing half is the one the user cannot edit.
 */

/** The instructions become tool descriptions, so they are bounded like a task. */
export const MAX_INSTRUCTION_BYTES = 64 * 1024;

/** Guard against a runaway list; far past what a readable Guidelines block holds. */
export const MAX_GUIDELINES = 32;

/** Tools whose prompt text this file may replace. */
export const OVERRIDABLE_TOOLS = [
	"subagent_spawn",
	"subagent_wait",
	"subagent_cancel",
	"subagent_inspect",
	"skill_run",
] as const;

export type OverridableTool = (typeof OVERRIDABLE_TOOLS)[number];

const OVERRIDABLE_SET = new Set<string>(OVERRIDABLE_TOOLS);

export interface ToolInstruction {
	/** Replaces the tool's `description`. Absent when the section had only guidelines. */
	description?: string;
	/** Replaces the tool's `promptGuidelines` wholesale, including with an empty list. */
	guidelines?: string[];
}

export interface InstructionOverrides {
	tools: Map<OverridableTool, ToolInstruction>;
	/** Reported through `/agents` so a typo does not fail silently. */
	diagnostics: string[];
	/** Absent when no file was found, which is the normal case. */
	source?: string;
}

/**
 * Path of the override file. `PI_CODING_AGENT_DIR` is honoured through
 * {@link piAgentDirectory}, so an alternate install keeps its own copy.
 */
export function instructionFilePath(): string {
	return path.join(piAgentDirectory(), "subagent_instruction.md");
}

export function emptyOverrides(): InstructionOverrides {
	return { tools: new Map(), diagnostics: [] };
}

/**
 * Read and parse the override file. A missing file is the normal case and
 * yields no diagnostics; anything else that goes wrong is reported and the
 * built-in text is kept, because a broken override must not disarm the tools.
 */
export function loadInstructionOverrides(file = instructionFilePath()): InstructionOverrides {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return emptyOverrides();
		return {
			tools: new Map(),
			diagnostics: [`Cannot read ${file}: ${text(error)}; using the built-in tool instructions.`],
		};
	}

	const bytes = Buffer.byteLength(raw, "utf8");
	if (bytes > MAX_INSTRUCTION_BYTES) {
		return {
			tools: new Map(),
			diagnostics: [
				`${file} is ${bytes} bytes, past the ${MAX_INSTRUCTION_BYTES} byte limit; using the built-in tool instructions.`,
			],
			source: file,
		};
	}

	const parsed = parseInstructions(raw);
	return { ...parsed, source: file };
}

/**
 * Parse the sectioned markdown.
 *
 * A `## <tool name>` heading opens a section. Prose in it becomes the tool's
 * description; a `### Guidelines` block's list items become its guidelines.
 * Text before the first heading is a preamble for humans and is ignored, so the
 * file can explain itself without leaking commentary into the system prompt.
 */
export function parseInstructions(raw: string): {
	tools: Map<OverridableTool, ToolInstruction>;
	diagnostics: string[];
} {
	const tools = new Map<OverridableTool, ToolInstruction>();
	const diagnostics: string[] = [];

	let tool: OverridableTool | undefined;
	let inGuidelines = false;
	let prose: string[] = [];
	let guidelines: string[] = [];
	let sawGuidelinesHeading = false;

	const flush = () => {
		if (!tool) return;
		const description = prose.join("\n").trim();
		const entry: ToolInstruction = {};
		if (description) entry.description = description;
		// An empty Guidelines block is a deliberate "drop the built-in bullets",
		// so the heading alone is enough to set the field; its absence is not.
		if (sawGuidelinesHeading) entry.guidelines = guidelines.slice(0, MAX_GUIDELINES);
		if (sawGuidelinesHeading && guidelines.length > MAX_GUIDELINES) {
			diagnostics.push(
				`${tool} lists ${guidelines.length} guidelines; only the first ${MAX_GUIDELINES} are used.`,
			);
		}
		if (entry.description === undefined && entry.guidelines === undefined) {
			diagnostics.push(`Section for ${tool} is empty; the built-in instructions are kept.`);
		} else {
			tools.set(tool, entry);
		}
	};

	const reset = () => {
		prose = [];
		guidelines = [];
		inGuidelines = false;
		sawGuidelinesHeading = false;
	};

	for (const line of raw.split(/\r?\n/u)) {
		const section = /^##\s+(?!#)(.+?)\s*$/u.exec(line);
		if (section) {
			flush();
			reset();
			const name = (section[1] ?? "").trim().replace(/^`|`$/gu, "");
			if (OVERRIDABLE_SET.has(name)) {
				if (tools.has(name as OverridableTool)) {
					diagnostics.push(`Duplicate section for ${name}; the last one wins.`);
				}
				tool = name as OverridableTool;
			} else {
				tool = undefined;
				diagnostics.push(
					`Unknown tool section "${name}"; expected one of ${OVERRIDABLE_TOOLS.join(", ")}.`,
				);
			}
			continue;
		}

		if (!tool) continue;

		const sub = /^###\s+(.+?)\s*$/u.exec(line);
		if (sub) {
			inGuidelines = /^guidelines$/iu.test((sub[1] ?? "").trim());
			if (inGuidelines) sawGuidelinesHeading = true;
			continue;
		}

		if (inGuidelines) {
			const item = /^\s*[-*]\s+(.+?)\s*$/u.exec(line);
			if (item) {
				const value = (item[1] ?? "").trim();
				if (value) guidelines.push(value);
			}
			continue;
		}

		prose.push(line);
	}
	flush();

	return { tools, diagnostics };
}

/**
 * Resolve one tool's text. The override replaces each field it defines and
 * leaves the rest on the built-in value, so a section that sets only guidelines
 * keeps the shipped description and its parameter contract intact.
 */
export function applyOverride(
	overrides: InstructionOverrides,
	tool: OverridableTool,
	builtin: { description: string; guidelines?: string[] },
): { description: string; guidelines?: string[] } {
	const override = overrides.tools.get(tool);
	if (!override) return builtin;
	return {
		description: override.description ?? builtin.description,
		guidelines: override.guidelines ?? builtin.guidelines,
	};
}

function text(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
