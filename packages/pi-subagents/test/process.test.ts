import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import {
	budgetHintTurn,
	buildPiArgs,
	resolveMaxTurns,
	resolveTimeoutMs,
	runChild,
	terminateWindowsProcessTree,
} from "../src/process.js";
import {
	CHILD_CORE_TOOL_NAMES,
	type ChildActivity,
	type ChildRequest,
	type ChildUsage,
} from "../src/types.js";

let directory: string;
let previousPackageDirectory: string | undefined;
let previousExecPath: string;
let previousBunVersion: string | undefined;

beforeEach(() => {
	directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-process-"));
	previousPackageDirectory = process.env.PI_PACKAGE_DIR;
	previousExecPath = process.execPath;
	previousBunVersion = process.versions.bun;
});

afterEach(() => {
	if (previousPackageDirectory === undefined) delete process.env.PI_PACKAGE_DIR;
	else process.env.PI_PACKAGE_DIR = previousPackageDirectory;
	process.execPath = previousExecPath;
	if (previousBunVersion === undefined) delete process.versions.bun;
	else process.versions.bun = previousBunVersion;
	rmSync(directory, { recursive: true, force: true });
	vi.useRealTimers();
	vi.restoreAllMocks();
});

test("buildPiArgs isolates the RPC child and grants only its selected work tools", () => {
	const args = buildPiArgs(childRequest());
	assert.deepEqual(args.slice(0, 6), [
		"--mode",
		"rpc",
		"--no-session",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
	]);
	// No extension is injected into a child at all, so there is no `-e` argument.
	assert.equal(args.includes("-e"), false);
	assert.equal(args[args.indexOf("--model") + 1], "test-provider/test-model");
	assert.equal(args[args.indexOf("--thinking") + 1], "medium");
	assert.ok(args.includes("--no-approve"));
	assert.equal(args[args.indexOf("--tools") + 1], "read,grep,find,ls");
	assert.doesNotMatch(args.join(" "), /\bbash\b|\bwrite\b|append-system-prompt/u);
	assert.equal(args.includes("Task: task"), false);

	const writable = buildPiArgs(
		childRequest({
			tools: ["read", "bash", "write"],
			thinkingLevel: "xhigh",
			projectTrusted: true,
		}),
	);
	assert.ok(writable.includes("--approve"));
	assert.equal(writable[writable.indexOf("--thinking") + 1], "xhigh");
	assert.equal(writable[writable.indexOf("--tools") + 1], "read,bash,write");

	// An empty selection stays empty: nothing is added on the child's behalf.
	const noWorkTools = buildPiArgs(childRequest({ tools: [] }));
	assert.equal(noWorkTools[noWorkTools.indexOf("--tools") + 1], "");
});

test("buildPiArgs tells the child its turn budget through the system prompt", () => {
	const budgeted = buildPiArgs(childRequest({ maxTurns: 40 }));
	const appended = budgeted[budgeted.indexOf("--append-system-prompt") + 1] ?? "";
	assert.match(appended, /budget of 40 turns/u);

	// The agent definition comes first; the budget is appended after it.
	const withAgent = buildPiArgs(childRequest({ systemPrompt: "You review diffs.", maxTurns: 40 }));
	const combined = withAgent[withAgent.indexOf("--append-system-prompt") + 1] ?? "";
	assert.match(combined, /^You review diffs\.\n\nYou have a budget of 40 turns/u);
	assert.equal(withAgent.filter((arg) => arg === "--append-system-prompt").length, 1);
});

test("a child is launched without any way to spawn a grandchild", () => {
	// Nesting is blocked by what the child process holds, not only by the depth
	// guard in the spawn tool, which a child with `bash` could unset.
	const args = buildPiArgs(childRequest());
	// The extension defining subagent_spawn and skill_run is never loaded, and no
	// extension is injected in its place.
	assert.ok(args.includes("--no-extensions"));
	assert.equal(args.includes("-e"), false);

	// A child holds no subagent tool whatsoever: there is no channel back to the
	// parent, so it cannot spawn, cancel, wait on, or message anything.
	const granted = (args[args.indexOf("--tools") + 1] ?? "").split(",").filter(Boolean);
	assert.deepEqual(
		granted.filter((tool) => tool.startsWith("subagent_") || tool === "skill_run"),
		[],
	);

	// No requestable tool list can smuggle a spawn tool past the allowlist.
	for (const tool of ["subagent_spawn", "skill_run", "subagent_cancel"]) {
		assert.equal(
			CHILD_CORE_TOOL_NAMES.includes(tool as (typeof CHILD_CORE_TOOL_NAMES)[number]),
			false,
			`${tool} must not be requestable for a child`,
		);
	}
});

test("runChild uses a bundled Pi executable when its manifest CLI is absent", async () => {
	installFakePi(
		`
async function handle(command) {
  if (command.type !== "prompt") return;
  respond(command);
  event(message("bundled Pi child completed"));
  event({ type: "agent_settled" });
}
`,
		{ bundled: true },
	);

	const result = await runChild(childRequest());
	assert.equal(result.state, "completed");
	assert.equal(result.result, "bundled Pi child completed");
});

test("runChild classifies completed and partial RPC output", async () => {
	installFakePi(`
async function handle(command) {
  if (command.type !== "prompt") return;
  respond(command);
  if (command.message.includes("partial")) {
    event(message("partial evidence", "error"));
    console.error("child failed");
  } else {
    event(message("completed evidence"));
  }
  event({ type: "agent_settled" });
}
`);
	const completed = await runChild(childRequest({ task: "complete" }));
	assert.equal(completed.state, "completed");
	assert.equal(completed.result, "completed evidence");

	const partial = await runChild(childRequest({ task: "partial" }));
	assert.equal(partial.state, "partial");
	assert.equal(partial.result, "partial evidence");
	assert.match(partial.error ?? "", /child failed/);
});

test("runChild retries a missed premature-stream error in the same RPC child", async () => {
	installFakePi(`
let prompts = 0;
async function handle(command) {
  if (command.type !== "prompt") return;
  respond(command);
  prompts++;
  if (prompts === 1) {
    event({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "stream disconnected before completion: stream closed before response.completed",
      },
    });
    event({ type: "agent_settled" });
    return;
  }
  event(message(command.message + " completed"));
  event({ type: "agent_settled" });
}
`);
	const result = await runChild(childRequest());
	assert.equal(result.state, "completed");
	assert.match(result.result ?? "", /continue after transient failure.*completed/iu);
});

test("runChild stops after three transient continuation retries", async () => {
	vi.useFakeTimers();
	installFakePi(`
async function handle(command) {
  if (command.type !== "prompt") return;
  respond(command);
  event({
    type: "message_end",
    message: {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "stream disconnected before completion",
    },
  });
  event({ type: "agent_settled" });
}
`);
	let resolveNotice!: () => void;
	let nextNotice = new Promise<void>((resolve) => {
		resolveNotice = resolve;
	});
	const notices: ChildActivity[] = [];
	const work = runChild(
		childRequest({
			onActivity: (activity) => {
				if (activity.type !== "notice" || !/Transient child model failure/u.test(activity.text))
					return;
				notices.push(activity);
				resolveNotice();
			},
		}),
	);
	for (const delayMs of [2_000, 4_000, 8_000]) {
		await nextNotice;
		nextNotice = new Promise<void>((resolve) => {
			resolveNotice = resolve;
		});
		await vi.advanceTimersByTimeAsync(delayMs);
	}
	const result = await work;
	assert.equal(result.state, "failed");
	assert.equal(notices.length, 3);
});

test("runChild does not retry non-transient assistant errors", async () => {
	installFakePi(`
let prompts = 0;
async function handle(command) {
  if (command.type !== "prompt") return;
  respond(command);
  prompts++;
  if (prompts > 1) {
    event(message("unexpected retry"));
  } else {
    event({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "authentication failed" }],
        stopReason: "error",
        errorMessage: "Authentication failed: invalid API key",
      },
    });
  }
  event({ type: "agent_settled" });
}
`);
	const result = await runChild(childRequest());
	assert.equal(result.state, "partial");
	assert.equal(result.result, "authentication failed");
	assert.doesNotMatch(result.result ?? "", /unexpected retry/u);
});

test("runChild cancels transient retry backoff", async () => {
	installFakePi(`
async function handle(command) {
  if (command.type !== "prompt") return;
  respond(command);
  event({
    type: "message_end",
    message: {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "stream disconnected before completion",
    },
  });
  event({ type: "agent_settled" });
}
`);
	const controller = new AbortController();
	const result = await runChild(
		childRequest({
			signal: controller.signal,
			onActivity: (activity) => {
				if (activity.type === "notice" && /Transient child model failure/u.test(activity.text)) {
					controller.abort();
				}
			},
		}),
	);
	assert.equal(result.state, "cancelled");
});

test("runChild retries an error turn even when it reaches the turn budget", async () => {
	installFakePi(`
let prompts = 0;
async function handle(command) {
  if (command.type !== "prompt") return;
  respond(command);
  prompts++;
  if (prompts === 1) {
    event({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "stream disconnected before completion",
      },
    });
    event({ type: "turn_end", message: { stopReason: "error" }, toolResults: [] });
    event({ type: "agent_settled" });
    return;
  }
  event(message("recovered at the turn budget"));
  event({ type: "agent_settled" });
}
`);
	const result = await runChild(childRequest({ maxTurns: 1 }));
	assert.equal(result.state, "completed");
	assert.equal(result.result, "recovered at the turn budget");
});

test("runChild applies the turn budget after a failed call is retried", async () => {
	installFakePi(`
let prompts = 0;
async function handle(command) {
  respond(command);
  if (command.type === "prompt") {
    prompts++;
    if (prompts === 1) {
      event({
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "stream disconnected before completion",
        },
      });
      event({ type: "turn_end", message: { stopReason: "error" }, toolResults: [] });
      event({ type: "agent_settled" });
      return;
    }
    event(message("working after retry", "toolUse"));
    event({ type: "turn_end", message: { stopReason: "toolUse" }, toolResults: [{}] });
    return;
  }
  if (command.type === "steer") {
    event(message("wrapped after retry"));
    event({ type: "turn_end", message: { stopReason: "stop" }, toolResults: [] });
    event({ type: "agent_settled" });
  }
}
`);
	const result = await runChild(childRequest({ maxTurns: 2 }));
	assert.equal(result.state, "completed");
	assert.equal(result.result, "wrapped after retry");
	assert.match(result.limitations.join("\n"), /turn budget of 2.*may be incomplete/u);
});

test("runChild counts Pi native retries against its transient retry budget", async () => {
	installFakePi(`
async function handle(command) {
  if (command.type !== "prompt") return;
  respond(command);
  event({ type: "auto_retry_start", attempt: 1 });
  event({ type: "auto_retry_start", attempt: 2 });
  event({ type: "auto_retry_start", attempt: 3 });
  event({
    type: "message_end",
    message: {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "stream disconnected before completion",
    },
  });
  event({ type: "agent_settled" });
}
`);
	const result = await runChild(childRequest());
	assert.equal(result.state, "failed");
	assert.match(result.error ?? "", /stream disconnected before completion/u);
});

test("runChild disables a fresh Pi retry budget before fallback continuation", async () => {
	installFakePi(`
let prompts = 0;
async function handle(command) {
  if (command.type !== "prompt") return;
  respond(command);
  prompts++;
  if (prompts === 1) {
    event({ type: "auto_retry_start", attempt: 1 });
    event({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "stream disconnected before completion",
      },
    });
    event({ type: "agent_settled" });
    return;
  }
  event(message("continued with the remaining shared budget"));
  event({ type: "agent_settled" });
}
`);
	const result = await runChild(childRequest());
	assert.equal(result.state, "completed");
	assert.equal(result.result, "continued with the remaining shared budget");
});

test("runChild clears a native-retry failure after a later successful assistant message", async () => {
	installFakePi(`
async function handle(command) {
  if (command.type !== "prompt") return;
  respond(command);
  event({
    type: "message_end",
    message: {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "503 service unavailable",
    },
  });
  event({ type: "auto_retry_start", attempt: 1 });
  event(message("recovered after native retry"));
  event({ type: "agent_settled" });
}
`);
	const result = await runChild(childRequest());
	assert.equal(result.state, "completed");
	assert.equal(result.result, "recovered after native retry");
	assert.equal(result.error, undefined);
});

test("runChild requires a settled terminal result and preserves incomplete evidence", async () => {
	installFakePi(`
async function handle(command) {
  if (command.type !== "prompt") return;
  respond(command);
  if (command.message.includes("length")) event(message("cut-off evidence", "length"));
  else if (command.message.includes("nonterminal")) event(message("intermediate evidence", "toolUse"));
  else process.stdout.write("{malformed\\n");
  event({ type: "agent_settled" });
}
`);
	const lengthLimited = await runChild(childRequest({ task: "length" }));
	assert.equal(lengthLimited.state, "partial");
	assert.equal(lengthLimited.result, "cut-off evidence");
	assert.match(lengthLimited.error ?? "", /model limit/i);
	assert.match(lengthLimited.limitations.join("\n"), /model output limit/i);

	const nonterminal = await runChild(childRequest({ task: "nonterminal" }));
	assert.equal(nonterminal.state, "partial");
	assert.equal(nonterminal.result, "intermediate evidence");
	assert.match(nonterminal.error ?? "", /without a terminal assistant result/i);

	const missing = await runChild(childRequest({ task: "missing" }));
	assert.equal(missing.state, "failed");
	assert.match(missing.error ?? "", /without a terminal assistant result/i);
	assert.match(missing.limitations.join("\n"), /malformed/i);
});

test("runChild ignores an oversized RPC event and preserves later terminal output", async () => {
	installFakePi(`
async function handle(command) {
  if (command.type !== "prompt") return;
  respond(command);
  process.stdout.write("x".repeat(256 * 1024 + 1) + "\\n");
  event(message("usable output"));
  event({ type: "agent_settled" });
}
`);
	const result = await runChild(childRequest());
	assert.equal(result.state, "completed");
	assert.equal(result.result, "usable output");
	assert.match(result.limitations.join("\n"), /malformed or oversized/i);
});

test("runChild bounds child result text below the complete tool-output budget", async () => {
	installFakePi(`
async function handle(command) {
  if (command.type !== "prompt") return;
  respond(command);
  event(message("x".repeat(40 * 1024)));
  event({ type: "agent_settled" });
}
`);
	const result = await runChild(childRequest());
	assert.equal(result.state, "completed");
	assert.equal(result.truncated, true);
	assert.ok(Buffer.byteLength(result.result ?? "", "utf8") <= 32 * 1024);
	assert.match(result.limitations.join("\n"), /truncated/i);
});

test("handles late credential-pipe errors after child launch failure", async () => {
	installFakePi("async function handle() {}\n");
	const removedCwd = path.join(directory, "removed-cwd");
	mkdirSync(removedCwd);
	rmSync(removedCwd, { recursive: true });

	const result = await runChild(childRequest({ cwd: removedCwd }));
	assert.equal(result.state, "failed");
	assert.match(result.error ?? "", /ENOENT|not found/iu);
	await new Promise<void>((resolve) => setImmediate(resolve));
});

test("resolves optional wait timeouts with Pi bash semantics", () => {
	assert.equal(resolveTimeoutMs(undefined), undefined);
	assert.equal(resolveTimeoutMs(0.025), 25);
	assert.equal(resolveTimeoutMs(2_147_483.647), 2_147_483_647);
	assert.throws(() => resolveTimeoutMs(0), /finite number of seconds/);
	assert.throws(() => resolveTimeoutMs(Number.POSITIVE_INFINITY), /finite number of seconds/);
	assert.throws(() => resolveTimeoutMs(2_147_483.648), /maximum is 2147483\.647 seconds/);
});

test("resolves turn budgets as positive integers", () => {
	assert.equal(resolveMaxTurns(undefined), undefined);
	assert.equal(resolveMaxTurns(100), 100);
	for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
		assert.throws(() => resolveMaxTurns(invalid), /positive integer/);
	}
});

test("places the remaining-budget reminder at 90% with at least three turns to spare", () => {
	assert.equal(budgetHintTurn(100), 90);
	assert.equal(budgetHintTurn(50), 45);
	assert.equal(budgetHintTurn(10), 7);
	assert.equal(budgetHintTurn(4), 1);
	// Too small for a reminder to precede the wrap-up request by a useful margin.
	assert.equal(budgetHintTurn(3), undefined);
});

test("runChild reminds a child of its remaining turns before the budget is reached", async () => {
	installFakePi(`
const toolTurn = () => event({ type: "turn_end", message: {}, toolResults: [{}] });
async function handle(command) {
  respond(command);
  if (command.type === "prompt") {
    for (let i = 0; i < 7; i++) toolTurn();
    return;
  }
  if (command.type === "steer") {
    event(message("Reminded: " + command.message));
    event({ type: "turn_end", message: {}, toolResults: [] });
    event({ type: "agent_settled" });
  }
}
`);
	const activity: ChildActivity[] = [];
	const result = await runChild(
		childRequest({ maxTurns: 10, onActivity: (entry) => activity.push(entry) }),
	);
	assert.equal(result.state, "completed");
	assert.match(result.result ?? "", /^Reminded: You have used 7 of your 10 turns; 3 remain\./u);
	// The budget itself was never reached, so the result carries no limitation.
	assert.deepEqual(result.limitations, []);
	assert.ok(
		activity.some(
			(entry) =>
				entry.type === "notice" &&
				/7\/10 turns used; reminded the child that 3 remain/u.test(entry.text),
		),
	);
});

test("runChild asks a child at its turn budget to wrap up and keeps its report", async () => {
	installFakePi(`
const toolTurn = () => event({ type: "turn_end", message: {}, toolResults: [{}] });
async function handle(command) {
  respond(command);
  if (command.type === "prompt") {
    toolTurn();
    toolTurn();
    toolTurn();
    return;
  }
  if (command.type === "steer") {
    event(message("Wrapped up: " + command.message));
    event({ type: "turn_end", message: {}, toolResults: [] });
    event({ type: "agent_settled" });
  }
}
`);
	const activity: ChildActivity[] = [];
	const result = await runChild(
		childRequest({ maxTurns: 3, onActivity: (entry) => activity.push(entry) }),
	);
	assert.equal(result.state, "completed");
	assert.match(result.result ?? "", /^Wrapped up: Your turn budget is exhausted\./u);
	assert.match(result.limitations.join("\n"), /turn budget of 3.*may be incomplete/u);
	assert.deepEqual(
		activity.filter((entry) => entry.type === "turn").map((entry) => entry.turns),
		[1, 2, 3, 4],
	);
	assert.ok(
		activity.some(
			(entry) => entry.type === "notice" && /Turn budget of 3 reached/u.test(entry.text),
		),
	);
});

test("runChild lets a report that lands on the budget turn complete untouched", async () => {
	installFakePi(`
async function handle(command) {
  respond(command);
  if (command.type === "steer") {
    event(message("steered"));
    return;
  }
  event({ type: "turn_end", message: {}, toolResults: [{}] });
  event(message("done"));
  event({ type: "turn_end", message: {}, toolResults: [] });
  event({ type: "agent_settled" });
}
`);
	const result = await runChild(childRequest({ maxTurns: 2 }));
	assert.equal(result.state, "completed");
	assert.equal(result.result, "done");
	assert.deepEqual(result.limitations, []);
});

test("runChild stops a child that keeps working past its turn budget", async () => {
	installFakePi(`
async function handle(command) {
  respond(command);
  if (command.type !== "prompt") return;
  event(message("still looking", "toolUse"));
  setInterval(() => event({ type: "turn_end", message: {}, toolResults: [{}] }), 5);
}
`);
	const result = await runChild(childRequest({ maxTurns: 2 }));
	assert.equal(result.state, "budget_exhausted");
	assert.equal(result.result, "still looking");
	assert.match(result.error ?? "", /turn budget of 2 without wrapping up/u);
	assert.doesNotMatch(result.limitations.join("\n"), /may be incomplete/u);
});

test("buildPiArgs tells the child about its context bound when the window is known", () => {
	const bounded = buildPiArgs(childRequest({ maxTurns: 40, contextWindow: 200_000 }));
	const appended = bounded[bounded.indexOf("--append-system-prompt") + 1] ?? "";
	assert.match(appended, /budget of 40 turns.*context window is also a budget.*70% full/u);

	const unbounded = buildPiArgs(childRequest({ maxTurns: 40 }));
	const turnsOnly = unbounded[unbounded.indexOf("--append-system-prompt") + 1] ?? "";
	assert.doesNotMatch(turnsOnly, /context window/u);
});

test("runChild asks a child whose context fills to the ratio to wrap up and keeps its report", async () => {
	installFakePi(`
const toolTurn = (totalTokens) => {
  event({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "looking" }],
      stopReason: "toolUse",
      usage: { input: totalTokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens },
    },
  });
  event({ type: "turn_end", message: { stopReason: "toolUse" }, toolResults: [{}] });
};
async function handle(command) {
  respond(command);
  if (command.type === "prompt") {
    toolTurn(500);
    toolTurn(699);
    toolTurn(700);
    return;
  }
  if (command.type === "steer") {
    event(message("Wrapped up: " + command.message));
    event({ type: "turn_end", message: { stopReason: "stop" }, toolResults: [] });
    event({ type: "agent_settled" });
  }
}
`);
	const activity: ChildActivity[] = [];
	const result = await runChild(
		childRequest({
			maxTurns: 100,
			contextWindow: 1_000,
			onActivity: (entry) => activity.push(entry),
		}),
	);
	assert.equal(result.state, "completed");
	// 699/1000 stays under the 70% ratio; the third turn crosses it.
	assert.match(
		result.result ?? "",
		/^Wrapped up: Your context window is 70% full\. Stop calling tools/u,
	);
	assert.match(result.limitations.join("\n"), /70% of its context window.*may be incomplete/u);
	assert.equal(
		activity.filter((entry) => entry.type === "notice").length,
		1,
		"one wrap-up notice, no turn-budget notice",
	);
	assert.ok(
		activity.some(
			(entry) =>
				entry.type === "notice" &&
				/Context 70% full \(700\/1000 tokens\); asked the child to wrap up/u.test(entry.text),
		),
	);
});

test("runChild ignores context without a known window", async () => {
	installFakePi(`
async function handle(command) {
  respond(command);
  if (command.type !== "prompt") return;
  event({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "looking" }],
      stopReason: "toolUse",
      usage: { input: 900_000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 900_000 },
    },
  });
  event({ type: "turn_end", message: { stopReason: "toolUse" }, toolResults: [{}] });
  event(message("done"));
  event({ type: "turn_end", message: { stopReason: "stop" }, toolResults: [] });
  event({ type: "agent_settled" });
}
`);
	const result = await runChild(childRequest({ maxTurns: 10 }));
	assert.equal(result.state, "completed");
	assert.equal(result.result, "done");
	assert.deepEqual(result.limitations, []);
});

test("runChild stops a child that keeps working past its context wrap-up", async () => {
	installFakePi(`
async function handle(command) {
  respond(command);
  if (command.type !== "prompt") return;
  event({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "still looking" }],
      stopReason: "toolUse",
      usage: { input: 800, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 800 },
    },
  });
  setInterval(() => event({ type: "turn_end", message: { stopReason: "toolUse" }, toolResults: [{}] }), 5);
}
`);
	const result = await runChild(childRequest({ maxTurns: 100, contextWindow: 1_000 }));
	assert.equal(result.state, "budget_exhausted");
	assert.equal(result.result, "still looking");
	assert.match(result.error ?? "", /80% of its context window without wrapping up/u);
	assert.doesNotMatch(result.limitations.join("\n"), /may be incomplete/u);
});

test("runChild honors cancellation after RPC readiness", async () => {
	installFakePi(`
async function handle(command) {
  if (command.type === "prompt") respond(command);
}
setInterval(() => {}, 1000);
`);
	const controller = new AbortController();
	let cancelReady!: () => void;
	const work = runChild(childRequest({ signal: controller.signal, onReady: () => cancelReady() }));
	await new Promise<void>((resolve) => {
		cancelReady = resolve;
	});
	controller.abort();
	assert.equal((await work).state, "cancelled");
});

test("runChild escalates to SIGKILL when a cancelled child ignores SIGTERM", {
	skip: process.platform === "win32",
}, async () => {
	installFakePi(`
process.on("SIGTERM", () => undefined);
async function handle(command) {
  if (command.type === "prompt") respond(command);
}
setInterval(() => {}, 1000);
`);
	const signals: Array<string | number | undefined> = [];
	const originalKill = process.kill.bind(process);
	vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
		if (pid < 0) signals.push(signal);
		return originalKill(pid, signal);
	});
	const controller = new AbortController();
	let resolveReady!: () => void;
	const ready = new Promise<void>((resolve) => {
		resolveReady = resolve;
	});
	const work = runChild(childRequest({ signal: controller.signal, onReady: resolveReady }));
	await ready;
	controller.abort();
	const result = await work;
	assert.equal(result.state, "cancelled");
	assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("Windows process-tree termination awaits taskkill completion", async () => {
	const childKill = vi.fn();
	const child = {
		pid: 4242,
		kill: childKill,
	} as unknown as ChildProcess;
	const treeKiller = new EventEmitter() as ChildProcess;
	treeKiller.kill = vi.fn();
	const spawnTreeKillerMock = vi.fn(() => treeKiller);
	const spawnTreeKiller =
		spawnTreeKillerMock as unknown as typeof import("node:child_process").spawn;
	let settled = false;
	const work = terminateWindowsProcessTree(
		child,
		spawnTreeKiller,
		"C:\\Windows\\System32\\taskkill.exe",
	).then(() => {
		settled = true;
	});
	await Promise.resolve();
	assert.equal(settled, false);
	assert.deepEqual(spawnTreeKillerMock.mock.calls[0]?.slice(0, 2), [
		"C:\\Windows\\System32\\taskkill.exe",
		["/PID", "4242", "/T", "/F"],
	]);
	assert.equal(childKill.mock.calls.length, 0);
	treeKiller.emit("close", 0, null);
	await work;
	assert.equal(settled, true);
});

test("Windows process-tree termination bounds a hung taskkill helper", async () => {
	vi.useFakeTimers();
	const childKill = vi.fn();
	const child = {
		pid: 4242,
		kill: childKill,
	} as unknown as ChildProcess;
	const treeKiller = new EventEmitter() as ChildProcess;
	const treeKillerKill = vi.fn();
	treeKiller.kill = treeKillerKill;
	const spawnTreeKiller = vi.fn(
		() => treeKiller,
	) as unknown as typeof import("node:child_process").spawn;
	let settled = false;
	const work = terminateWindowsProcessTree(
		child,
		spawnTreeKiller,
		"C:\\Windows\\System32\\taskkill.exe",
		10,
	).then(() => {
		settled = true;
	});
	await vi.advanceTimersByTimeAsync(9);
	assert.equal(settled, false);
	await vi.advanceTimersByTimeAsync(1);
	await work;
	assert.equal(settled, true);
	assert.deepEqual(treeKillerKill.mock.calls, [["SIGKILL"]]);
	assert.deepEqual(childKill.mock.calls, [["SIGKILL"]]);
});

test("runChild forwards the child's tool activity and visible output", async () => {
	installFakePi(`
async function handle(command) {
  if (command.type !== "prompt") return;
  respond(command);
  event({
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName: "read",
    args: { path: "src/a.ts" },
  });
  event({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "read",
    result: { content: [{ type: "text", text: "40 lines" }] },
    isError: false,
  });
  event(message("Read the file."));
  event({ type: "agent_settled" });
}
`);
	const activity: ChildActivity[] = [];
	const result = await runChild(childRequest({ onActivity: (event) => activity.push(event) }));
	assert.equal(result.state, "completed");
	assert.deepEqual(activity, [
		{ type: "tool_start", toolCallId: "call_1", tool: "read", args: { path: "src/a.ts" } },
		{
			type: "tool_end",
			toolCallId: "call_1",
			tool: "read",
			result: { content: [{ type: "text", text: "40 lines" }] },
			isError: false,
		},
		{ type: "output", text: "Read the file." },
	]);
});

test("runChild reports a failed tool call and omits thinking from activity", async () => {
	installFakePi(`
async function handle(command) {
  if (command.type !== "prompt") return;
  respond(command);
  // Thinking and partial tool updates are not part of the activity contract.
  event({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking: "secret reasoning" }],
      stopReason: "toolUse",
    },
  });
  event({
    type: "tool_execution_update",
    toolCallId: "call_1",
    toolName: "bash",
    args: { command: "false" },
    partialResult: { content: [{ type: "text", text: "partial" }] },
  });
  event({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "bash",
    result: { content: [{ type: "text", text: "exit 1" }] },
    isError: true,
  });
  event(message("The command failed."));
  event({ type: "agent_settled" });
}
`);
	const activity: ChildActivity[] = [];
	await runChild(childRequest({ onActivity: (event) => activity.push(event) }));
	assert.deepEqual(
		activity.map((event) => event.type),
		["tool_end", "output"],
	);
	assert.equal(activity[0]?.type === "tool_end" && activity[0].isError, true);
	// No activity event carries the child's hidden reasoning.
	assert.ok(!JSON.stringify(activity).includes("secret reasoning"));
});

test("runChild ignores an activity observer that throws", async () => {
	installFakePi(`
async function handle(command) {
  if (command.type !== "prompt") return;
  respond(command);
  event({ type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: {} });
  event(message("still completed"));
  event({ type: "agent_settled" });
}
`);
	const result = await runChild(
		childRequest({
			onActivity: () => {
				throw new Error("observer failure");
			},
		}),
	);
	// A broken display observer cannot change the job's outcome.
	assert.equal(result.state, "completed");
	assert.equal(result.result, "still completed");
});

test("runChild drops a malformed tool event rather than reporting a partial one", async () => {
	installFakePi(`
async function handle(command) {
  if (command.type !== "prompt") return;
  respond(command);
  // Neither event names both a call id and a tool, so neither is reportable.
  event({ type: "tool_execution_start", toolName: "read", args: {} });
  event({ type: "tool_execution_end", toolCallId: "c1", isError: false });
  event(message("done"));
  event({ type: "agent_settled" });
}
`);
	const activity: ChildActivity[] = [];
	await runChild(childRequest({ onActivity: (event) => activity.push(event) }));
	assert.deepEqual(
		activity.map((event) => event.type),
		["output"],
	);
});

test("runChild reports each response's token accounting", async () => {
	installFakePi(`
async function handle(command) {
  if (command.type !== "prompt") return;
  respond(command);
  event({
    type: "message_end",
    message: {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "provider overloaded",
      usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { total: 0.001 } },
    },
  });
  event({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      stopReason: "stop",
      usage: { input: 100, output: 20, cacheRead: 900, cacheWrite: 50, totalTokens: 1070, cost: { total: 0.02 } },
    },
  });
  event({ type: "agent_settled" });
}
`);
	const usage: ChildUsage[] = [];
	const result = await runChild(
		childRequest({
			onActivity: (activity) => {
				if (activity.type === "usage") usage.push(activity.usage);
			},
		}),
	);
	assert.equal(result.state, "completed");
	// A failed response was still billed, so its tokens count; it cannot say how
	// full the child's context is, so it reports no context size.
	assert.deepEqual(usage, [
		{ input: 10, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.001 },
		{ input: 100, output: 20, cacheRead: 900, cacheWrite: 50, contextTokens: 1_070, cost: 0.02 },
	]);
});

test("runChild sums a response's own counts when it reports no total", async () => {
	installFakePi(`
async function handle(command) {
  if (command.type !== "prompt") return;
  respond(command);
  event({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      stopReason: "stop",
      usage: { input: 100, output: 20, cacheRead: 900, cacheWrite: 50, cost: { total: "free" } },
    },
  });
  event({ type: "agent_settled" });
}
`);
	const usage: ChildUsage[] = [];
	await runChild(
		childRequest({
			onActivity: (activity) => {
				if (activity.type === "usage") usage.push(activity.usage);
			},
		}),
	);
	// Child stdout is untrusted, so a nonsensical cost reads as zero rather than
	// poisoning the job's running total.
	assert.deepEqual(usage, [
		{ input: 100, output: 20, cacheRead: 900, cacheWrite: 50, contextTokens: 1_070, cost: 0 },
	]);
});

function childRequest(overrides: Partial<ChildRequest> = {}): ChildRequest {
	return {
		task: "task",
		tools: ["read", "grep", "find", "ls"],
		model: "test-provider/test-model",
		thinkingLevel: "medium",
		cwd: directory,
		projectTrusted: false,
		signal: new AbortController().signal,
		...overrides,
	};
}

function installFakePi(source: string, options: { bundled?: boolean } = {}): void {
	const packageDirectory = path.join(directory, "pi-core");
	const executableName = options.bundled ? "pi" : "fake-pi.mjs";
	const executablePath = path.join(packageDirectory, executableName);
	mkdirSync(packageDirectory, { recursive: true });
	writeFileSync(
		executablePath,
		`${options.bundled ? "#!/usr/bin/env node\n" : ""}const event = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const respond = (command, success = true, error) => event({
  id: command.id,
  type: "response",
  command: command.type,
  success,
  ...(error ? { error } : {}),
});
const message = (text, stopReason = "stop") => ({
  type: "message_end",
  message: { role: "assistant", content: [{ type: "text", text }], stopReason },
});
${source}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  while (true) {
    const newline = input.indexOf("\\n");
    if (newline < 0) break;
    const line = input.slice(0, newline);
    input = input.slice(newline + 1);
    if (!line.trim()) continue;
    const command = JSON.parse(line);
    if (command.type === "set_auto_retry") respond(command);
    else void handle(command);
  }
});
`,
	);
	if (options.bundled) chmodSync(executablePath, 0o755);
	writeFileSync(
		path.join(packageDirectory, "package.json"),
		JSON.stringify({
			name: "@earendil-works/pi-coding-agent",
			bin: { pi: options.bundled ? "./dist/bundle/cli.js" : "./fake-pi.mjs" },
		}),
	);
	process.env.PI_PACKAGE_DIR = packageDirectory;
	if (options.bundled) {
		process.execPath = executablePath;
		process.versions.bun = "1.3.0";
	}
}
