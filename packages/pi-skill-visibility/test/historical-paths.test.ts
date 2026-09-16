import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { analyzeSessions, extractEvidence } from "../src/analysis.js";
import { formatReport } from "../src/report.js";

const cwd = "/historical/project";
const skills = [
	{ name: "review", filePath: `${cwd}/.pi/skills/different-folder/SKILL.md` },
	{ name: "unused" },
];
const content = [
	{
		type: "toolCall",
		name: "read",
		arguments: { path: ".pi/skills/different-folder/SKILL.md" },
	},
];

test("resolve historical relative reads against supplied cwd, not current process directory", () => {
	const warnings: string[] = [];
	const evidence = extractEvidence(content, skills, ["review"], {
		cwd,
		warn: (w) => warnings.push(w),
	});
	assert.deepEqual([...evidence], [["review", new Set(["load"])]]);
	assert.equal(warnings.length, 0);
	const unresolved = extractEvidence(content, skills, ["review"], {
		warn: (w) => warnings.push(w),
	});
	assert.ok(unresolved.has("different-folder"));
	assert.equal(unresolved.has("review"), false);
	assert.equal(warnings.length, 1);
});

test("Pi session header and Claude message cwd attribute reads correctly; uncertain paths suppress suggestions", async () => {
	const dir = await mkdtemp(join(tmpdir(), "skill-path-regression-"));
	const pi = join(dir, "pi"),
		claude = join(dir, "claude");
	const now = Date.now();
	const timestamp = new Date(now).toISOString();
	try {
		await mkdir(pi);
		await mkdir(claude);
		await writeFile(
			join(pi, "session.jsonl"),
			[
				{ type: "session", cwd },
				{ type: "message", timestamp, message: { role: "assistant", content } },
			]
				.map((e) => JSON.stringify(e))
				.join("\n"),
		);
		await writeFile(
			join(claude, "session.jsonl"),
			JSON.stringify({
				type: "assistant",
				cwd,
				timestamp,
				message: {
					role: "assistant",
					content: [
						{
							type: "tool_use",
							name: "Read",
							input: { file_path: ".pi/skills/different-folder/SKILL.md" },
						},
					],
				},
			}),
		);
		const options = {
			days: 60,
			now,
			skills,
			excluded: new Set<string>(),
			roots: [
				{ source: "pi" as const, root: pi },
				{ source: "claude" as const, root: claude },
			],
		};
		const result = await analyzeSessions(options);
		assert.equal(result.usage.find((row) => row.name === "review")?.load, 2);
		assert.equal(
			result.usage.some((row) => row.name === "different-folder"),
			false,
		);
		assert.ok(result.sources.every((source) => source.warnings.length === 0));
		const reportMatch = /```json\n([\s\S]*?)\n```/.exec(formatReport(result));
		assert.ok(reportMatch);
		const suggestedSkills = reportMatch[1];
		assert.ok(suggestedSkills);
		assert.deepEqual(JSON.parse(suggestedSkills), ["unused"]);
		await writeFile(
			join(pi, "unknown.jsonl"),
			JSON.stringify({
				type: "message",
				timestamp,
				message: { role: "assistant", content },
			}),
		);
		const uncertain = await analyzeSessions(options);
		const firstUncertainSource = uncertain.sources[0];
		assert.ok(firstUncertainSource);
		assert.ok(firstUncertainSource.warnings.some((w) => w.includes("缺少可靠工作目录")));
		const uncertainReportMatch = /```json\n([\s\S]*?)\n```/.exec(formatReport(uncertain));
		assert.ok(uncertainReportMatch);
		const uncertainSuggestedSkills = uncertainReportMatch[1];
		assert.ok(uncertainSuggestedSkills);
		assert.deepEqual(JSON.parse(uncertainSuggestedSkills), []);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
