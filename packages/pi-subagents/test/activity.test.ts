import assert from "node:assert/strict";
import { test } from "vitest";
import {
	ActivityLog,
	MAX_ACTIVITY_TEXT_BYTES,
	redactSecrets,
	summarizeToolArgs,
	summarizeToolResult,
	toDisplayLine,
} from "../src/activity.js";

test("redacts named credential assignments while keeping the name readable", () => {
	assert.equal(redactSecrets("API_KEY=abcdef123456"), "API_KEY=***");
	assert.equal(redactSecrets('export GITHUB_TOKEN="hunter2"'), "export GITHUB_TOKEN=***");
	assert.equal(redactSecrets("db_password: s3cr3t-value"), "db_password=***");
	assert.equal(redactSecrets("AWS_SECRET_ACCESS_KEY = xyz/abc+123"), "AWS_SECRET_ACCESS_KEY=***");
	// A name that does not mark a credential is left alone.
	assert.equal(redactSecrets("LIMIT=50"), "LIMIT=50");
});

test("redacts well-known credential shapes that carry no adjacent name", () => {
	for (const secret of [
		"sk-abcdefghijklmnopqrstuvwxyz",
		"ghp_abcdefghijklmnopqrstuvwxyz12",
		"xoxb-1234567890-abcdefghij",
		"AKIAIOSFODNN7EXAMPLE",
		"AIzaSyAbCdEfGhIjKlMnOpQrStUvWxYz12345",
		"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmno",
		"0123456789abcdef0123456789abcdef01234567",
	]) {
		const redacted = redactSecrets(`value ${secret} tail`);
		assert.ok(!redacted.includes(secret), `expected ${secret} to be redacted, got ${redacted}`);
		assert.ok(redacted.includes("***"));
	}
	assert.equal(
		redactSecrets('curl -H "Authorization: Bearer abcdefghijklmnop"'),
		'curl -H "Authorization=***',
	);
});

test("redacts a private key block without leaving any of its body", () => {
	const redacted = redactSecrets(
		"-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----",
	);
	assert.equal(redacted, "***");
	// An unterminated block is still redacted rather than passed through.
	assert.equal(redactSecrets("-----BEGIN PRIVATE KEY-----\nMIIEow"), "***");
});

test("collapses a display line to one row within the byte budget", () => {
	assert.equal(toDisplayLine("  read\n\tsrc/a.ts  "), "read src/a.ts");
	const long = toDisplayLine("x".repeat(MAX_ACTIVITY_TEXT_BYTES * 2));
	assert.ok(Buffer.byteLength(long, "utf8") <= MAX_ACTIVITY_TEXT_BYTES);
	assert.ok(long.endsWith("… [truncated]"));
	// Terminal control sequences never survive into a rendered line, and a
	// colour sequence goes whole rather than leaving its `[31m` behind.
	assert.equal(toDisplayLine("a[31mbc"), "abc");
});

test("summarizes each known tool by what it acts on, never by file body", () => {
	assert.equal(summarizeToolArgs("read", { path: "src/auth.ts" }), "src/auth.ts");
	assert.equal(
		summarizeToolArgs("read", { path: "src/a.ts", offset: 10, limit: 5 }),
		"src/a.ts (10..15)",
	);
	assert.equal(summarizeToolArgs("bash", { command: "npm test" }), "npm test");
	assert.equal(
		summarizeToolArgs("grep", { pattern: "verifyToken", path: "src/" }),
		'"verifyToken" src/',
	);
	assert.equal(summarizeToolArgs("ls", { path: "src" }), "src");
	// A write reports its size, so a secret being written never reaches the panel.
	assert.equal(
		summarizeToolArgs("write", { path: ".env", content: "API_KEY=sk-abcdefghijklmnopqrst" }),
		".env (31 bytes)",
	);
	assert.equal(
		summarizeToolArgs("edit", { path: "a.ts", oldString: "a", newString: "bb" }),
		"a.ts → (2 bytes)",
	);
});

test("summarizes an unknown tool from its short scalar fields only", () => {
	assert.equal(
		summarizeToolArgs("subagent_send", { recipient: "job_1", message: "hi" }),
		"recipient=job_1 message=hi",
	);
	const summary = summarizeToolArgs("mystery", { blob: "y".repeat(500), count: 3 });
	assert.equal(summary, "blob=(500 bytes) count=3");
});

test("redacts a credential passed through a tool argument", () => {
	const summary = summarizeToolArgs("bash", {
		command: 'curl -H "Authorization: Bearer abcdefghijklmnop"',
	});
	assert.ok(!summary.includes("abcdefghijklmnop"), summary);
	assert.ok(summary.includes("***"), summary);
});

test("summarizes a tool result from its text content", () => {
	assert.equal(
		summarizeToolResult({ content: [{ type: "text", text: "7 matches" }], details: {} }),
		"7 matches",
	);
	// Non-text parts and unusable shapes contribute nothing rather than throwing.
	assert.equal(summarizeToolResult({ content: [{ type: "image", data: "..." }] }), "");
	assert.equal(summarizeToolResult(undefined), "");
	assert.equal(summarizeToolResult("plain"), "plain");
});

test("pairs a tool result onto the entry its call created", () => {
	const log = new ActivityLog();
	log.toolStart("call_1", "read", { path: "a.ts" }, 1_000);
	log.toolEnd("call_1", "read", { content: [{ type: "text", text: "42 lines" }] }, false, 1_200);
	const events = log.snapshot();
	assert.equal(events.length, 1);
	assert.deepEqual(
		{ ...events[0] },
		{
			seq: 1,
			at: 1_000,
			kind: "tool",
			tool: "read",
			detail: "a.ts",
			outcome: "ok",
			result: "42 lines",
		},
	);
});

test("records a failed tool call with an error outcome", () => {
	const log = new ActivityLog();
	log.toolStart("call_1", "bash", { command: "false" }, 1_000);
	log.toolEnd("call_1", "bash", { content: [{ type: "text", text: "exit 1" }] }, true, 1_100);
	assert.equal(log.snapshot()[0]?.outcome, "error");
});

test("records an unpaired result as its own entry rather than dropping it", () => {
	const log = new ActivityLog();
	log.toolEnd("unknown", "grep", undefined, false, 2_000);
	const events = log.snapshot();
	assert.equal(events.length, 1);
	assert.equal(events[0]?.tool, "grep");
	assert.equal(events[0]?.outcome, "ok");
});

test("drops the oldest events past capacity and reports how many", () => {
	const log = new ActivityLog(3);
	for (let index = 0; index < 5; index++) log.output(`line ${index}`, 1_000 + index);
	const events = log.snapshot();
	assert.deepEqual(
		events.map((event) => event.detail),
		["line 2", "line 3", "line 4"],
	);
	assert.equal(log.droppedCount, 2);
	// Sequence numbers keep counting, so a reader can see events went missing.
	assert.deepEqual(
		events.map((event) => event.seq),
		[3, 4, 5],
	);
});

test("does not complete an entry the capacity bound already evicted", () => {
	const log = new ActivityLog(2);
	log.toolStart("call_1", "read", { path: "a.ts" }, 1_000);
	log.output("first", 1_100);
	log.output("second", 1_200);
	log.toolEnd("call_1", "read", { content: [{ type: "text", text: "done" }] }, false, 1_300);
	const events = log.snapshot();
	// The evicted start is gone, and the result stands alone instead of resurrecting it.
	assert.deepEqual(
		events.map((event) => event.detail),
		["second", ""],
	);
	assert.equal(events.at(-1)?.result, "done");
});

test("ignores empty output and notices so the log holds no blank rows", () => {
	const log = new ActivityLog();
	log.output("   \n\t ", 1_000);
	log.notice("", 1_000);
	assert.deepEqual(log.snapshot(), []);
});

test("snapshots are copies, so a reader cannot mutate the log", () => {
	const log = new ActivityLog();
	log.output("line", 1_000);
	const snapshot = log.snapshot();
	const first = snapshot[0];
	assert.ok(first);
	first.detail = "tampered";
	assert.equal(log.snapshot()[0]?.detail, "line");
});
