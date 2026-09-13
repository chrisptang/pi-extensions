import assert from "node:assert/strict";
import { test } from "vitest";
import {
	CooldownRegistry,
	DEFAULT_COOLDOWN_MS,
	MAX_COOLDOWN_MS,
	parseRetryAfterMs,
} from "../src/cooldown.js";

const model = (provider: string, id: string) => ({ provider, id });

test("parseRetryAfterMs prefers the millisecond header", () => {
	assert.equal(parseRetryAfterMs({ "retry-after-ms": "1500", "retry-after": "30" }, 0), 1500);
});

test("parseRetryAfterMs reads retry-after as seconds", () => {
	assert.equal(parseRetryAfterMs({ "retry-after": "30" }, 0), 30_000);
	assert.equal(parseRetryAfterMs({ "retry-after": "0" }, 0), 0);
});

/** The HTTP-date form is relative to the moment the response arrived. */
test("parseRetryAfterMs reads retry-after as an HTTP date", () => {
	const now = Date.parse("2026-09-13T00:00:00Z");
	const headers = { "retry-after": "Sun, 13 Sep 2026 00:00:45 GMT" };
	assert.equal(parseRetryAfterMs(headers, now), 45_000);
});

test("parseRetryAfterMs ignores a date that has already passed", () => {
	const now = Date.parse("2026-09-13T00:01:00Z");
	assert.equal(
		parseRetryAfterMs({ "retry-after": "Sun, 13 Sep 2026 00:00:00 GMT" }, now),
		undefined,
	);
});

/** Fetch lowercases header names, but a raw provider record may not. */
test("parseRetryAfterMs matches header names case-insensitively", () => {
	assert.equal(parseRetryAfterMs({ "Retry-After": "12" }, 0), 12_000);
	assert.equal(parseRetryAfterMs({ "Retry-After-Ms": "800" }, 0), 800);
});

test("parseRetryAfterMs returns undefined without a usable header", () => {
	assert.equal(parseRetryAfterMs(undefined, 0), undefined);
	assert.equal(parseRetryAfterMs({}, 0), undefined);
	assert.equal(parseRetryAfterMs({ "retry-after": "soon" }, 0), undefined);
	assert.equal(parseRetryAfterMs({ "retry-after": "-5" }, 0), undefined);
});

test("a penalized model cools down for the requested window", () => {
	let now = 1_000;
	const registry = new CooldownRegistry(() => now);
	const target = model("local", "a");

	registry.penalize(target, { "retry-after": "30" });

	assert.equal(registry.isCoolingDown(target), true);
	assert.equal(registry.remainingMs(target), 30_000);

	now += 29_999;
	assert.equal(registry.isCoolingDown(target), true);
	now += 1;
	assert.equal(registry.isCoolingDown(target), false);
	assert.equal(registry.remainingMs(target), 0);
});

test("a rate limit without a header falls back to the default window", () => {
	const registry = new CooldownRegistry(() => 0);
	assert.equal(registry.penalize(model("local", "a")), DEFAULT_COOLDOWN_MS);
});

/** A multi-hour quota reset must not sideline a candidate for the whole session. */
test("a long server-requested delay is capped", () => {
	const registry = new CooldownRegistry(() => 0);
	assert.equal(registry.penalize(model("local", "a"), { "retry-after": "7200" }), MAX_COOLDOWN_MS);
});

test("repeated limits extend rather than shorten a cooldown", () => {
	let now = 0;
	const registry = new CooldownRegistry(() => now);
	const target = model("local", "a");

	registry.penalize(target, { "retry-after": "60" });
	now += 10_000;
	// A shorter second window must not cut the first one short.
	registry.penalize(target, { "retry-after": "5" });

	assert.equal(registry.remainingMs(target), 50_000);
});

test("cooldowns are tracked per model reference", () => {
	const registry = new CooldownRegistry(() => 0);
	registry.penalize(model("local", "a"));

	assert.equal(registry.isCoolingDown(model("local", "a")), true);
	assert.equal(registry.isCoolingDown(model("local", "b")), false);
	assert.equal(registry.isCoolingDown(model("other", "a")), false);
});

test("clear releases every cooldown", () => {
	const registry = new CooldownRegistry(() => 0);
	registry.penalize(model("local", "a"));
	registry.clear();
	assert.equal(registry.isCoolingDown(model("local", "a")), false);
});
