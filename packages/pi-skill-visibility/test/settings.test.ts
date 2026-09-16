import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { loadExclusionSettings } from "../src/settings.js";

const CANONICAL = "pi-skill-visibility.json";
const LEGACY = "excluded-skills.json";

async function withAgentDir(run: (agentDir: string) => Promise<void>): Promise<void> {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-skill-visibility-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		await run(agentDir);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		await rm(agentDir, { recursive: true, force: true });
	}
}

test("missing settings stay absent and malformed files fail open", async () => {
	await withAgentDir(async (agentDir) => {
		const settings = await loadExclusionSettings();
		assert.equal(settings.excluded.size, 0);
		assert.equal(existsSync(join(agentDir, CANONICAL)), false);

		await writeFile(join(agentDir, CANONICAL), "{");
		const invalid = await loadExclusionSettings();
		assert.equal(invalid.excluded.size, 0);
		assert.match(invalid.warning ?? "", /Cannot use/);
	});
});

test("migrates a valid legacy file atomically and keeps exact, deduplicated names", async () => {
	await withAgentDir(async (agentDir) => {
		const legacyText = '["hide", "hide", "Hide"]\n';
		await writeFile(join(agentDir, LEGACY), legacyText);
		const settings = await loadExclusionSettings();
		assert.deepEqual([...settings.excluded], ["hide", "Hide"]);
		assert.match(settings.warning ?? "", /Migrated/);
		assert.equal(await readFile(join(agentDir, CANONICAL), "utf8"), legacyText);
		assert.equal(existsSync(join(agentDir, LEGACY)), false);
	});
});

test("canonical settings win over legacy settings without deleting the legacy file", async () => {
	await withAgentDir(async (agentDir) => {
		await writeFile(join(agentDir, CANONICAL), '["canonical"]');
		await writeFile(join(agentDir, LEGACY), '["legacy"]');
		const settings = await loadExclusionSettings();
		assert.deepEqual([...settings.excluded], ["canonical"]);
		assert.match(settings.warning ?? "", /Legacy .* ignored/);
		assert.equal(existsSync(join(agentDir, LEGACY)), true);
	});
});
