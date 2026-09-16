import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { analyzeSessions, extractEvidence, parseDays } from "../src/analysis.js";
import { formatReport } from "../src/report.js";

const skills = [
	{ name: "review", filePath: "/skills/different-folder/SKILL.md" },
	{ name: "unused" },
];

test("default and valid day counts; reject ambiguous/unsafe input", () => {
	assert.equal(parseDays(""), 60);
	assert.equal(parseDays(" 7 "), 7);
	for (const value of ["0", "-1", "1.5", "1e2", "2 3", "abc", "Infinity", "99999999999999999"])
		assert.throws(() => parseDays(value));
});

test("three evidence kinds, exact names, duplicate mentions, tool outputs ignored", () => {
	const evidence = extractEvidence(
		[
			{ type: "text", text: "review review /skill:review /skill:historic" },
			{
				type: "toolCall",
				name: "read",
				arguments: { path: "/skills/different-folder/SKILL.md" },
			},
			{ type: "tool_use", name: "Skill", input: { skill: "claude-only" } },
			{
				type: "tool_use",
				name: "Read",
				input: { file_path: "/old/legacy/SKILL.md" },
			},
			{ type: "tool_result", content: "unused" },
		],
		skills,
		skills.map((s) => s.name),
	);
	const reviewEvidence = evidence.get("review");
	assert.ok(reviewEvidence);
	assert.deepEqual([...reviewEvidence].sort(), ["invocation", "load", "mention"]);
	assert.ok(evidence.get("historic")?.has("invocation"));
	assert.ok(evidence.get("claude-only")?.has("invocation"));
	assert.ok(evidence.get("legacy")?.has("load"));
	assert.equal(evidence.has("unused"), false);
	assert.equal(extractEvidence("pre-review review-more prereview", skills, ["review"]).size, 0);
});

test("skip injected lists/reminders; expanded invocation does not count references in skill body", () => {
	const text =
		'<available_skills><skill><name>unused</name></skill></available_skills>\n<system-reminder>unused</system-reminder>\n<skill name="review" location="/skills/review/SKILL.md">unused</skill>';
	const evidence = extractEvidence(text, skills, ["review", "unused"]);
	assert.deepEqual([...evidence], [["review", new Set(["invocation"])]]);
	const claude = extractEvidence(
		"<command-name>/review</command-name>",
		skills,
		new Map([["review", 1]]).keys(),
	);
	const reviewEvidence = claude.get("review");
	assert.ok(reviewEvidence);
	assert.deepEqual([...reviewEvidence].sort(), ["invocation", "mention"]);
});

test("shell reads recognized, writes not counted as loads", () => {
	assert.ok(
		extractEvidence(
			[
				{
					type: "toolCall",
					name: "bash",
					arguments: { command: 'cat "/skills/different-folder/SKILL.md"' },
				},
			],
			skills,
			["review"],
		)
			.get("review")
			?.has("load"),
	);
	assert.equal(
		extractEvidence(
			[
				{
					type: "toolCall",
					name: "write",
					arguments: { path: "/skills/different-folder/SKILL.md" },
				},
			],
			skills,
			["review"],
		).size,
		0,
	);
});

test("JSONL scanning, window boundaries, duplicate replay, source quality and report", async () => {
	const dir = await mkdtemp(join(tmpdir(), "skills-analysis-"));
	const now = Date.parse("2026-09-05T12:00:00Z");
	const since = now - 2 * 86400000;
	const pi = join(dir, "pi");
	const claude = join(dir, "claude");
	const message = (time: number, content: unknown, role = "user") => ({
		type: "message",
		id: String(time),
		timestamp: new Date(time).toISOString(),
		message: { role, content },
	});
	try {
		await mkdir(pi);
		await mkdir(claude);
		const duplicate = message(since, "review");
		await writeFile(
			join(pi, "one.jsonl"),
			[
				duplicate,
				message(since - 1, "unused"),
				message(now + 1, "unused"),
				message(now, "unused", "toolResult"),
				{ type: "custom", data: "unused" },
			]
				.map((v) => JSON.stringify(v))
				.join("\n"),
		);
		await writeFile(join(pi, "copy.jsonl"), JSON.stringify(duplicate));
		await writeFile(
			join(claude, "two.jsonl"),
			JSON.stringify({
				type: "assistant",
				uuid: "claude",
				timestamp: new Date(now).toISOString(),
				message: {
					role: "assistant",
					content: [{ type: "tool_use", name: "Skill", input: { skill: "review" } }],
				},
			}),
		);
		const options = {
			days: 2,
			now,
			skills,
			excluded: new Set(["configured-only"]),
			roots: [
				{ source: "pi" as const, root: pi },
				{ source: "claude" as const, root: claude },
			],
		};
		const result = await analyzeSessions(options);
		const review = result.usage.find((row) => row.name === "review");
		assert.ok(review);
		assert.equal(review.mention, 1);
		assert.equal(review.invocation, 1);
		assert.equal(review.lastUsed, new Date(now).toISOString());
		const firstSource = result.sources[0];
		assert.ok(firstSource);
		assert.equal(firstSource.messages, 1);
		assert.match(formatReport(result), /"unused"/);
		const unused = result.usage.find((row) => row.name === "unused");
		assert.ok(unused);
		assert.equal(unused.lastUsed, undefined);
		await writeFile(
			join(pi, "broken.jsonl"),
			'broken\n{"type":"message","message":{"role":"user","content":"unused"}}\n',
		);
		const bad = await analyzeSessions({
			...options,
			roots: [...options.roots, { source: "pi", root: join(dir, "missing") }],
		});
		const firstBadSource = bad.sources[0];
		const missingRootSource = bad.sources[2];
		assert.ok(firstBadSource);
		assert.ok(missingRootSource);
		assert.equal(firstBadSource.invalid, 2);
		assert.ok(missingRootSource.warnings.length);
		assert.match(formatReport(bad), /本次不自动推荐/);
		assert.match(formatReport(bad), /```json\n\[\]\n```/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("already aborted scan stops rather than producing misleading zero-use results", async () => {
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		analyzeSessions({
			days: 60,
			skills,
			excluded: new Set(),
			roots: [{ source: "pi", root: "/nonexistent" }],
			signal: controller.signal,
		}),
	);
});
