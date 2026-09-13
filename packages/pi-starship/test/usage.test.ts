import assert from "node:assert/strict";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { summarizeFooterUsage } from "../src/usage.js";

function entry(value: unknown): SessionEntry {
	return value as SessionEntry;
}

function usage(input: number, output: number, cacheRead: number, cacheWrite: number, cost: number) {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

test("footer usage matches Pi totals across every usage-bearing entry branch", () => {
	const entries = [
		entry({ type: "message", message: { role: "assistant", usage: usage(10, 2, 30, 5, 0.1) } }),
		entry({ type: "message", message: { role: "toolResult", usage: usage(3, 1, 4, 1, 0.02) } }),
		entry({ type: "compaction", usage: usage(2, 1, 0, 2, 0.03) }),
		entry({ type: "branch_summary", usage: usage(1, 1, 1, 0, 0.04) }),
		entry({ type: "message", message: { role: "assistant", usage: usage(80, 4, 20, 0, 0.01) } }),
		entry({ type: "message", message: { role: "user" } }),
		entry({ type: "custom", customType: "example" }),
	];

	const result = summarizeFooterUsage(entries);
	assert.equal(result.input, 96);
	assert.equal(result.output, 9);
	assert.equal(result.cacheRead, 55);
	assert.equal(result.cacheWrite, 8);
	assert.equal(result.hasUsage, true);
	assert.equal(result.latestCacheHitRate, 20);
	assert.equal(result.sessionCacheHitRate, (55 / 159) * 100);
	assert.ok(Math.abs(result.cost - 0.2) < Number.EPSILON);
});

test("latest and session cache rates remain distinct", () => {
	const result = summarizeFooterUsage([
		entry({ type: "message", message: { role: "assistant", usage: usage(10, 2, 30, 5, 0.1) } }),
		entry({ type: "message", message: { role: "assistant", usage: usage(80, 4, 20, 0, 0.01) } }),
	]);

	assert.equal(result.latestCacheHitRate, 20);
	assert.equal(result.sessionCacheHitRate, (50 / 145) * 100);
});

test("measured zero cache differs from unavailable usage", () => {
	const measuredZero = summarizeFooterUsage([
		entry({ type: "message", message: { role: "assistant", usage: usage(25, 5, 0, 0, 0.01) } }),
	]);
	assert.equal(measuredZero.hasUsage, true);
	assert.equal(measuredZero.sessionCacheHitRate, 0);
	assert.equal(measuredZero.latestCacheHitRate, 0);

	const unavailable = summarizeFooterUsage([
		entry({ type: "message", message: { role: "toolResult" } }),
		entry({ type: "compaction" }),
		entry({ type: "branch_summary" }),
	]);
	assert.deepEqual(unavailable, {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		hasUsage: false,
		sessionCacheHitRate: undefined,
	});
});
