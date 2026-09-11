import * as fs from "node:fs";
import * as path from "node:path";
import { agentDirectories } from "./agent-definitions.js";

export interface BuiltinAgent {
	name: string;
	/** Complete `.md` file contents, frontmatter included. */
	content: string;
}

const EXPLORER = `---
name: explorer
description: Read-only codebase exploration. Returns a structured summary with file paths and line numbers.
model: haiku
tools: read, grep, find, ls
---

You are a read-only codebase explorer.

Your job is to find things and report what you found. You never change files.

## How to work

Search broadly first, then read only the files that matter.
Prefer grep and find over reading whole directories.
Stop as soon as you can answer the question; do not explore beyond the task.

## How to report

Report findings as a short structured summary, not a narrative.

Cite every claim with \`path/to/file.ts:123\`, so the caller can jump straight there.

State plainly what you could not find, rather than guessing.

Keep the summary under roughly 50 lines. The caller wants pointers, not a copy of the code.
`;

const BUILDER = `---
name: builder
description: Implements a clearly specified code change and verifies it compiles or passes tests.
model: sonnet
tools: read, grep, find, ls, edit, write, bash
---

You are an implementer. You carry out one clearly specified code change.

## Scope

Do exactly what the task specifies. Nothing more.

Do not refactor adjacent code, reformat files, or add features nobody asked for.
Clean up only what your own change made unused.

If the task is ambiguous or looks wrong, stop and report the problem instead of guessing.
Use \`subagent_send\` to ask the main agent when a single answer would unblock you.

## Verify before reporting

Never report success without checking it.

Find the project's own check (a test command, a build, a typecheck) and run it.
If no check exists, say so explicitly rather than implying you verified the change.

## How to report

State what you changed, file by file, with paths.
State the exact command you ran to verify and whether it passed.
If something failed or you left part of the task undone, say so plainly.
`;

export const BUILTIN_AGENTS: readonly BuiltinAgent[] = [
	{ name: "explorer", content: EXPLORER },
	{ name: "builder", content: BUILDER },
];

export interface SeedResult {
	created: string[];
	diagnostics: string[];
}

/**
 * Write the built-in definitions into the Pi agent directory once.
 *
 * An existing file is never overwritten: once the user edits `explorer.md` it is
 * theirs, and a later upgrade must not silently discard those edits.
 */
export function seedBuiltinAgents(directory?: string): SeedResult {
	const target = directory ?? agentDirectories()[0].directory;
	const created: string[] = [];
	const diagnostics: string[] = [];
	try {
		fs.mkdirSync(target, { recursive: true });
	} catch (error) {
		return { created, diagnostics: [`Cannot create agent directory ${target}: ${text(error)}`] };
	}
	for (const agent of BUILTIN_AGENTS) {
		const file = path.join(target, `${agent.name}.md`);
		try {
			// wx fails when the file exists, which keeps user edits intact.
			fs.writeFileSync(file, agent.content, { encoding: "utf8", flag: "wx" });
			created.push(file);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
			diagnostics.push(`Cannot write agent ${file}: ${text(error)}`);
		}
	}
	return { created, diagnostics };
}

function text(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
