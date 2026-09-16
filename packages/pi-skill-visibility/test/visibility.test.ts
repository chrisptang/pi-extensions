import assert from "node:assert/strict";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import skillVisibility, { filterAutocomplete, filterSkillCatalog } from "../src/visibility.js";

test("filters only configured catalog and completion entries", async () => {
	const entry = (name: string) =>
		`  <skill>\n<name>${name}</name><description>text</description><location>/skills/${name}/SKILL.md</location>\n</skill>\n`;
	const prompt = `before hide\n<available_skills>\n${entry("hide")}${entry("hide")}${entry("hide-more")}${entry("a&amp;b")}</available_skills>\nafter hide`;
	assert.equal(
		filterSkillCatalog(prompt, new Set(["hide", "a&b"])),
		`before hide\n<available_skills>\n${entry("hide-more")}</available_skills>\nafter hide`,
	);

	const provider = {
		triggerCharacters: ["#"],
		async getSuggestions() {
			return {
				prefix: "/",
				items: ["/skill:hide", "skill:hide", "/skill:hide-more", "/help"].map((value) => ({
					value,
					label: value,
				})),
			};
		},
		applyCompletion() {
			assert.equal(this, provider);
			return { lines: ["done"], cursorLine: 0, cursorCol: 4 };
		},
		shouldTriggerFileCompletion() {
			assert.equal(this, provider);
			return false;
		},
	};
	const filtered = filterAutocomplete(provider, new Set(["hide"]));
	assert.deepEqual(
		(
			await filtered.getSuggestions(["/"], 0, 1, {
				signal: new AbortController().signal,
			})
		)?.items.map((item) => item.value),
		["/skill:hide-more", "/help"],
	);
	assert.equal(
		filtered.applyCompletion([""], 0, 0, { value: "x", label: "x" }, "").lines[0],
		"done",
	);
	assert.equal(filtered.shouldTriggerFileCompletion?.([""], 0, 0), false);
});

test("registers the compatibility command and rejects invalid arguments", async () => {
	const mock = createMockPi();
	await skillVisibility(mock.pi);
	assert.ok(mock.commands.has("skills-analysis"));
	assert.deepEqual([...mock.events.keys()].sort(), [
		"before_agent_start",
		"session_shutdown",
		"session_start",
	]);

	const context = createMockContext({ mode: "tui", hasUI: true });
	await mock.commands.get("skills-analysis")?.handler("0", context.ctx);
	assert.match(context.notifications.at(-1)?.message ?? "", /Usage|用法/);
});
