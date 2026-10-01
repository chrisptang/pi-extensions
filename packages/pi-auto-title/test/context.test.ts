import assert from "node:assert/strict";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { buildTitleGenerationContext, extractCompactTurns } from "../src/context.js";

test("extractCompactTurns groups user and assistant messages into rounds", () => {
	const entries = [
		{
			type: "session",
			id: "s1",
			parentId: null,
			timestamp: "2026-10-01T00:00:00Z",
		},
		{
			type: "message",
			id: "m1",
			parentId: "s1",
			timestamp: "2026-10-01T00:00:01Z",
			message: { role: "user", content: "How does the cache work?" },
		},
		{
			type: "message",
			id: "m2",
			parentId: "m1",
			timestamp: "2026-10-01T00:00:02Z",
			message: { role: "assistant", content: "The cache uses LRU in memory." },
		},
		{
			type: "custom",
			id: "c1",
			parentId: "m2",
			timestamp: "2026-10-01T00:00:03Z",
			customType: "random-state",
		},
		{
			type: "message",
			id: "m3",
			parentId: "m2",
			timestamp: "2026-10-01T00:00:04Z",
			message: { role: "user", content: "Can we add Redis persistence to it?" },
		},
		{
			type: "message",
			id: "m4",
			parentId: "m3",
			timestamp: "2026-10-01T00:00:05Z",
			message: { role: "assistant", content: "Yes, we can plug in a Redis backend." },
		},
	];

	const turns = extractCompactTurns(entries as unknown as SessionEntry[]);
	assert.equal(turns.length, 2);
	assert.equal(turns[0].userText, "How does the cache work?");
	assert.equal(turns[0].assistantText, "The cache uses LRU in memory.");
	assert.equal(turns[1].userText, "Can we add Redis persistence to it?");
	assert.equal(turns[1].assistantText, "Yes, we can plug in a Redis backend.");
});

test("buildTitleGenerationContext formats up to maxTurns and truncates", () => {
	const entries = [
		{
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: "2026-10-01T00:00:01Z",
			message: { role: "user", content: "Question 1" },
		},
		{
			type: "message",
			id: "m2",
			parentId: "m1",
			timestamp: "2026-10-01T00:00:02Z",
			message: { role: "assistant", content: "Answer 1" },
		},
		{
			type: "message",
			id: "m3",
			parentId: "m2",
			timestamp: "2026-10-01T00:00:03Z",
			message: { role: "user", content: "Question 2" },
		},
		{
			type: "message",
			id: "m4",
			parentId: "m3",
			timestamp: "2026-10-01T00:00:04Z",
			message: { role: "assistant", content: "Answer 2" },
		},
		{
			type: "message",
			id: "m5",
			parentId: "m4",
			timestamp: "2026-10-01T00:00:05Z",
			message: { role: "user", content: "Question 3 should be ignored" },
		},
	];

	const contextText = buildTitleGenerationContext(entries as unknown as SessionEntry[], {
		maxTurns: 2,
	});
	assert.ok(contextText.includes("User (Turn 1): Question 1"));
	assert.ok(contextText.includes("Assistant (Turn 1): Answer 1"));
	assert.ok(contextText.includes("User (Turn 2): Question 2"));
	assert.ok(contextText.includes("Assistant (Turn 2): Answer 2"));
	assert.ok(!contextText.includes("Question 3"));
});
