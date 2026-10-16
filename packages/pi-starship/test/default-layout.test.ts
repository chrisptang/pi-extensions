import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import {
	BUILT_IN_CONFIG,
	BUILT_IN_EXAMPLE,
	normalizeConfig,
	validateConfigDocument,
} from "../src/config.js";
import { renderStatusline, type StarshipRuntimeSnapshot } from "../src/modules/index.js";
import { wrapFormattedStatusline } from "../src/pi-starship.js";

function snapshot(overrides: Partial<StarshipRuntimeSnapshot> = {}): StarshipRuntimeSnapshot {
	return {
		cwd: "/work/h5-pda",
		gitRoot: "/work/h5-pda",
		gitBranch: "feat/plaintext-login",
		model: { provider: "agy", id: "agy/gemini-3.8-flash-high" },
		thinkingLevel: "high",
		turnCount: 4,
		activeTools: new Map(),
		isStreaming: false,
		contextUsage: { tokens: 32_000, contextWindow: 512_000, percent: 6.25 },
		tokenTotals: {
			input: 8_000,
			cacheRead: 270_000,
			cacheWrite: 10_000,
			output: 4_400,
			cost: 0.092,
			hasUsage: true,
		},
		usingSubscription: false,
		extensionStatuses: new Map([["unrelated", "untouched"]]),
		now: new Date(2026, 9, 16),
		...overrides,
	};
}

function lines(runtime = snapshot(), width = 100) {
	return wrapFormattedStatusline(renderStatusline(BUILT_IN_CONFIG, runtime, width).ansi, width).map(
		stripVTControlCharacters,
	);
}

const usage = "ΣIn 288k · ΣOut 4.4k · Ctx 32k/512k 6.3% · $0.092";

test("default aligns workspace and model above a complete, stable usage row", () => {
	const output = lines();
	assert.equal(output.length, 2);
	assert.match(
		output[0] ?? "",
		/^h5-pda \/ feat\/plaintext-login {2,}gemini-3\.8-flash-high · high$/u,
	);
	assert.equal(output[1], usage);
	const rendered = renderStatusline(BUILT_IN_CONFIG, snapshot(), 100);
	assert.ok(
		rendered.chunks.every(({ style }) => !style?.bold && !style?.background && !style?.foreground),
	);
	assert.doesNotMatch(output.join("\n"), /agy\/|Cache|π|idle|completed|untouched/u);
	assert.deepEqual(validateConfigDocument("/unused.toml", BUILT_IN_EXAMPLE).diagnostics, []);
});

test("narrow layouts shorten only environment labels and retain every usage character", () => {
	const runtime = snapshot({
		cwd: `/work/${"long-directory-".repeat(8)}tail`,
		gitRoot: undefined,
		gitBranch: `feat/${"long-branch-".repeat(8)}login`,
		model: { provider: "agy", id: `agy/gemini-${"long-model-".repeat(8)}high` },
	});
	for (const width of [160, 100, 80, 60, 40, 20, 10, 2, 1]) {
		const output = lines(runtime, width);
		assert.ok(
			output.every((line) => visibleWidth(line) <= width),
			`${width}: ${output}`,
		);
		const compact = output.join("").replaceAll(/\s/gu, "");
		assert.ok(compact.endsWith(usage.replaceAll(/\s/gu, "")), `${width}: ${output}`);
		assert.match(output.join(""), /…/u);
	}
	assert.equal(lines(runtime, 100).length, 2);
	assert.deepEqual(lines(runtime, 0), []);
});

test("default only shows ongoing activity, with no dangling separator when idle", () => {
	for (const lastCompletedTool of [undefined, "read"]) {
		assert.doesNotMatch(
			lines(snapshot({ lastCompletedTool }))[0] ?? "",
			/idle|completed|read| · {2}/u,
		);
	}
	assert.match(lines(snapshot({ isStreaming: true }))[0] ?? "", / · thinking/u);
	assert.match(
		lines(
			snapshot({
				activeTools: new Map([
					["bash", 2],
					["read", 1],
				]),
			}),
		)[0] ?? "",
		/running bash×2\+1/u,
	);
	assert.match(
		lines(snapshot({ uiPrompt: { kind: "confirm", title: "Deploy?" } }))[0] ?? "",
		/waiting for confirm · Deploy\?/u,
	);
});

test("default uses current theme roles for context warnings, conflicts and user waits", () => {
	const renderedRoles = (runtime: StarshipRuntimeSnapshot) => {
		const roles: Array<{ role: string; text: string }> = [];
		renderStatusline(BUILT_IN_CONFIG, runtime, 200, true, {
			fg(role, text) {
				roles.push({ role, text });
				return text;
			},
		});
		return roles;
	};
	for (const [percent, role] of [
		[0, "muted"],
		[59.9, "muted"],
		[60, "warning"],
		[79.9, "warning"],
		[80, "error"],
		[100, "error"],
	] as const) {
		const roles = renderedRoles(
			snapshot({ contextUsage: { tokens: 32_000, contextWindow: 512_000, percent } }),
		);
		assert.ok(
			roles.some((entry) => entry.role === role && entry.text.includes("Ctx")),
			`${percent}`,
		);
	}
	const gitStatus: NonNullable<StarshipRuntimeSnapshot["gitStatus"]> = {
		ahead: 0,
		behind: 0,
		stashed: 0,
		conflicted: 0,
		deleted: 0,
		renamed: 0,
		modified: 0,
		staged: 0,
		typechanged: 0,
		untracked: 0,
		worktreeAdded: 0,
		worktreeDeleted: 0,
		worktreeModified: 0,
		worktreeTypechanged: 0,
		indexAdded: 0,
		indexDeleted: 0,
		indexModified: 0,
		indexTypechanged: 0,
	};
	assert.doesNotMatch(lines(snapshot({ gitStatus }))[0] ?? "", /untracked|conflicted|up.to.date/u);
	assert.match(
		lines(snapshot({ gitStatus: { ...gitStatus, untracked: 1 } }))[0] ?? "",
		/1 untracked/u,
	);
	assert.ok(
		renderedRoles(snapshot({ gitStatus: { ...gitStatus, conflicted: 2 } })).some(
			({ role, text }) => role === "error" && text.includes("2 conflicted"),
		),
	);
	assert.ok(
		renderedRoles(snapshot({ uiPrompt: { kind: "input" } })).some(
			({ role, text }) => role === "warning" && text.includes("waiting for input"),
		),
	);
	assert.ok(
		renderedRoles(snapshot({ tokenTotals: { ...snapshot().tokenTotals, cost: 99 } })).every(
			({ role, text }) => !text.includes("$99.00") || role === "muted",
		),
	);
});

test("unknown usage, subscription estimates and tool costs keep their existing meaning", () => {
	const known = snapshot();
	assert.equal(
		lines(
			snapshot({
				usingSubscription: true,
				tokenTotals: { ...known.tokenTotals, cost: 1.234, toolCost: 0.058 },
			}),
		)[1],
		"ΣIn 288k · ΣOut 4.4k · Ctx 32k/512k 6.3% · $1.23 (tools $0.058) estimate",
	);
	assert.equal(
		lines(
			snapshot({ tokenTotals: { ...known.tokenTotals, hasUsage: false }, contextUsage: undefined }),
		)[1],
		"ΣIn — · ΣOut — · Ctx —/— — · $—",
	);
	assert.match(
		lines(
			snapshot({
				tokenTotals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, hasUsage: true },
			}),
		)[1] ?? "",
		/^ΣIn 0 · ΣOut 0.*\$0\.000$/u,
	);
});

test("default sanitizes terminal text before measuring and shrinking without changing raw values", () => {
	const branch = `feat/\x1b[31munsafe\n\u202e${"界".repeat(60)}login`;
	const runtime = snapshot({
		gitBranch: branch,
		activeTools: new Map([["bash\n\x1b]0;bad\x07", 1]]),
	});
	const output = lines(runtime, 100);
	assert.ok(output.every((line) => visibleWidth(line) <= 100));
	assert.equal(output.join("").includes(String.fromCharCode(27)), false);
	assert.equal(output.join("").includes("\u202e"), false);
	assert.equal(runtime.gitBranch, branch);
	assert.match(output.join(""), /login/u);
	for (const width of [1, 2, 3]) {
		assert.ok(
			lines(runtime, width).every((line) => visibleWidth(line) <= width),
			`wide characters must fit ${width} column(s)`,
		);
	}
});

test("custom documents retain their legacy module defaults and do not opt into shrinking", () => {
	const { config } = normalizeConfig({ format: "$model$activity$context$cost" });
	const plain = stripVTControlCharacters(
		renderStatusline(config, snapshot({ lastCompletedTool: "read" }), 20).ansi,
	);
	assert.match(plain, /🤖 agy\/gemini-3\.8-flash-high/u);
	assert.match(plain, /completed read/u);
	assert.equal(config.modules.model.style, "bold blue");
	assert.equal(config.modules.context.display[0]?.style, "bold green");
});
