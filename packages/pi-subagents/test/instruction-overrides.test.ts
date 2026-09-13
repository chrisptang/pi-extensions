import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "vitest";
import {
	applyOverride,
	emptyOverrides,
	instructionFilePath,
	loadInstructionOverrides,
	MAX_GUIDELINES,
	MAX_INSTRUCTION_BYTES,
	parseInstructions,
} from "../src/instruction-overrides.js";

const temporary: string[] = [];

afterEach(() => {
	for (const directory of temporary.splice(0)) {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

function writeInstruction(contents: string): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-instructions-"));
	temporary.push(directory);
	const file = path.join(directory, "subagent_instruction.md");
	fs.writeFileSync(file, contents, "utf8");
	return file;
}

test("a missing file leaves the built-in text in place without complaining", () => {
	const overrides = loadInstructionOverrides(path.join(os.tmpdir(), "pi-subagents-absent.md"));
	assert.equal(overrides.tools.size, 0);
	assert.deepEqual(overrides.diagnostics, []);
	assert.equal(overrides.source, undefined);
});

test("a section replaces the tool description", () => {
	const file = writeInstruction(
		["# My rules", "", "## subagent_spawn", "", "Only spawn when I say so.", ""].join("\n"),
	);
	const overrides = loadInstructionOverrides(file);
	assert.deepEqual(overrides.diagnostics, []);
	assert.equal(overrides.tools.get("subagent_spawn")?.description, "Only spawn when I say so.");
	// A section with no Guidelines block leaves the shipped bullets alone.
	assert.equal(overrides.tools.get("subagent_spawn")?.guidelines, undefined);
});

test("a Guidelines block replaces the shipped bullets", () => {
	const file = writeInstruction(
		[
			"## subagent_spawn",
			"",
			"Spawn a job.",
			"",
			"### Guidelines",
			"- Never batch more than two jobs.",
			"* Always state the owning file.",
		].join("\n"),
	);
	const spawn = loadInstructionOverrides(file).tools.get("subagent_spawn");
	assert.equal(spawn?.description, "Spawn a job.");
	assert.deepEqual(spawn?.guidelines, [
		"Never batch more than two jobs.",
		"Always state the owning file.",
	]);
});

test("an empty Guidelines block drops the built-in bullets rather than keeping them", () => {
	const file = writeInstruction(
		["## subagent_spawn", "", "Spawn.", "", "### Guidelines"].join("\n"),
	);
	const spawn = loadInstructionOverrides(file).tools.get("subagent_spawn");
	assert.deepEqual(spawn?.guidelines, []);
});

test("text before the first heading is a human preamble and never reaches the model", () => {
	const file = writeInstruction(
		[
			"This file customizes how my session uses subagents.",
			"Edit it freely.",
			"",
			"## subagent_cancel",
			"",
			"Cancel one job.",
		].join("\n"),
	);
	const overrides = loadInstructionOverrides(file);
	assert.equal(overrides.tools.size, 1);
	assert.equal(overrides.tools.get("subagent_cancel")?.description, "Cancel one job.");
});

test("an unknown section is reported instead of being silently dropped", () => {
	const file = writeInstruction(["## subagent_teleport", "", "Do the thing."].join("\n"));
	const overrides = loadInstructionOverrides(file);
	assert.equal(overrides.tools.size, 0);
	assert.match(overrides.diagnostics[0] ?? "", /Unknown tool section "subagent_teleport"/u);
	// The diagnostic names the valid sections, so the typo is fixable from it alone.
	assert.match(overrides.diagnostics[0] ?? "", /subagent_spawn/u);
});

test("a backticked heading names the same tool", () => {
	const file = writeInstruction(["## `subagent_wait`", "", "Wait."].join("\n"));
	assert.equal(loadInstructionOverrides(file).tools.get("subagent_wait")?.description, "Wait.");
});

test("an oversized file is refused so a runaway edit cannot bloat the system prompt", () => {
	const file = writeInstruction(`## subagent_spawn\n\n${"x".repeat(MAX_INSTRUCTION_BYTES + 1)}\n`);
	const overrides = loadInstructionOverrides(file);
	assert.equal(overrides.tools.size, 0);
	assert.match(overrides.diagnostics[0] ?? "", /past the \d+ byte limit/u);
});

test("guidelines past the cap are dropped and reported", () => {
	const items = Array.from({ length: MAX_GUIDELINES + 3 }, (_, index) => `- rule ${index}`);
	const file = writeInstruction(["## subagent_spawn", "", "### Guidelines", ...items].join("\n"));
	const overrides = loadInstructionOverrides(file);
	assert.equal(overrides.tools.get("subagent_spawn")?.guidelines?.length, MAX_GUIDELINES);
	assert.match(overrides.diagnostics[0] ?? "", /only the first \d+ are used/u);
});

test("an empty section keeps the built-in text and says so", () => {
	const file = writeInstruction(["## subagent_inspect", "", "   ", ""].join("\n"));
	const overrides = loadInstructionOverrides(file);
	assert.equal(overrides.tools.size, 0);
	assert.match(overrides.diagnostics[0] ?? "", /Section for subagent_inspect is empty/u);
});

test("a later duplicate section wins and the collision is reported", () => {
	const file = writeInstruction(
		["## subagent_spawn", "", "First.", "", "## subagent_spawn", "", "Second."].join("\n"),
	);
	const overrides = loadInstructionOverrides(file);
	assert.equal(overrides.tools.get("subagent_spawn")?.description, "Second.");
	assert.match(overrides.diagnostics[0] ?? "", /Duplicate section for subagent_spawn/u);
});

test("a third-level heading does not open a new section", () => {
	const { tools, diagnostics } = parseInstructions(
		["## subagent_spawn", "", "Body.", "", "### Notes", "", "More body."].join("\n"),
	);
	assert.deepEqual(diagnostics, []);
	assert.match(tools.get("subagent_spawn")?.description ?? "", /More body\./u);
});

test("applyOverride replaces only the fields the section defined", () => {
	const builtin = { description: "shipped", guidelines: ["shipped rule"] };
	const overrides = emptyOverrides();
	assert.deepEqual(applyOverride(overrides, "subagent_spawn", builtin), builtin);

	overrides.tools.set("subagent_spawn", { guidelines: ["mine"] });
	assert.deepEqual(applyOverride(overrides, "subagent_spawn", builtin), {
		description: "shipped",
		guidelines: ["mine"],
	});

	overrides.tools.set("subagent_spawn", { description: "mine" });
	assert.deepEqual(applyOverride(overrides, "subagent_spawn", builtin), {
		description: "mine",
		guidelines: ["shipped rule"],
	});
});

test("the instruction file sits beside the agent directory Pi is configured to use", () => {
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = path.join(os.tmpdir(), "pi-subagents-agent-dir");
	try {
		assert.equal(
			instructionFilePath(),
			path.join(os.tmpdir(), "pi-subagents-agent-dir", "subagent_instruction.md"),
		);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
});

test("an unreadable file keeps the built-in text rather than disarming the tools", () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-unreadable-"));
	temporary.push(directory);
	// A directory where a file is expected fails with EISDIR, not ENOENT.
	const overrides = loadInstructionOverrides(directory);
	assert.equal(overrides.tools.size, 0);
	assert.match(overrides.diagnostics[0] ?? "", /using the built-in tool instructions/u);
});
