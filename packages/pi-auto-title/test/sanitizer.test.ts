import assert from "node:assert/strict";
import { test } from "vitest";
import { cleanTitle } from "../src/generator.js";

test("cleanTitle removes surrounding quotes and prefixes", () => {
	assert.equal(cleanTitle('"Title: Refactor Database Pool"'), "Refactor Database Pool");
	assert.equal(cleanTitle("“标题：修复重连逻辑”"), "修复重连逻辑");
	assert.equal(cleanTitle("'Topic: Update Login UI.'"), "Update Login UI");
	assert.equal(cleanTitle("`session: Fix Auth Middleware`"), "Fix Auth Middleware");
});

test("cleanTitle removes markdown formatting and fences", () => {
	assert.equal(cleanTitle("**Fix Memory Leak**"), "Fix Memory Leak");
	assert.equal(cleanTitle("```\nOptimize Query Performance\n```"), "Optimize Query Performance");
});

test("cleanTitle removes trailing punctuation", () => {
	assert.equal(cleanTitle("Add OAuth Support..."), "Add OAuth Support");
	assert.equal(cleanTitle("构建流水线修复！"), "构建流水线修复");
});

test("cleanTitle enforces maxLength truncation", () => {
	const longTitle =
		"This is a very very long session title that definitely exceeds the maximum length limit";
	const cleaned = cleanTitle(longTitle, 30);
	assert.ok(cleaned.length <= 30);
	assert.equal(cleaned, "This is a very very long sessi");
});
