/**
 * Resolution of the Markdown compaction prompt from the project and user scopes.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

/** Basename of the prompt file in both scopes. */
export const PROMPT_FILE_NAME = "compaction.md";

/** Where a resolved prompt came from. */
export type PromptScope = "project" | "user";

export interface ResolvedPrompt {
	scope: PromptScope;
	path: string;
	text: string;
}

export interface PromptResolution {
	/** The prompt to inject, absent when no scope provided usable text. */
	prompt?: ResolvedPrompt;
	/** Read failures, for the caller to report through a mode-appropriate channel. */
	errors: string[];
}

export interface ResolvePromptOptions {
	cwd: string;
	projectTrusted: boolean;
	/** Overrides `getAgentDir()` in tests. */
	agentDir?: string;
}

/** Path of the project-scope prompt file for a workspace. */
export function projectPromptPath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, PROMPT_FILE_NAME);
}

/** Path of the user-scope prompt file. */
export function userPromptPath(agentDir = getAgentDir()): string {
	return join(agentDir, PROMPT_FILE_NAME);
}

/**
 * Read the effective prompt, preferring a trusted project file over the user file.
 *
 * Reads are side-effect free: a missing file yields no prompt and no error, so the
 * extension stays inert until a user creates one of the files. A file that exists but
 * holds only whitespace is treated as absent so the next scope can apply.
 */
export function resolvePrompt(options: ResolvePromptOptions): PromptResolution {
	const candidates: Array<{ scope: PromptScope; path: string }> = [];
	if (options.projectTrusted) {
		candidates.push({ scope: "project", path: projectPromptPath(options.cwd) });
	}
	candidates.push({ scope: "user", path: userPromptPath(options.agentDir) });

	const errors: string[] = [];
	for (const candidate of candidates) {
		const read = readPromptFile(candidate.path);
		if (read.error !== undefined) {
			errors.push(read.error);
			continue;
		}
		if (read.text === undefined) continue;
		return { prompt: { ...candidate, text: read.text }, errors };
	}
	return { errors };
}

function readPromptFile(path: string): { text?: string; error?: string } {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		if (isMissingFile(error)) return {};
		return { error: `Could not read ${path}: ${errorMessage(error)}` };
	}
	const text = raw.trim();
	return text.length > 0 ? { text } : {};
}

function isMissingFile(error: unknown): boolean {
	const code = (error as { code?: unknown } | null)?.code;
	return code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
