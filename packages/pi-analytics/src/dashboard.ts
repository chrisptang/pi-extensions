import { stripVTControlCharacters } from "node:util";
import {
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { CustomInteractionContext } from "@narumitw/pi-tui-kit";
import { formatInteractionHints, HorizontalRule } from "@narumitw/pi-tui-kit";

function wrapMetrics(text: string, width: number): string[] {
	const safe = Array.from(stripVTControlCharacters(text), (character) => {
		const code = character.codePointAt(0) ?? 0;
		return (code < 32 && code !== 10) || (code >= 127 && code <= 159) ? " " : character;
	}).join("");
	return safe.split("\n").flatMap((line) => wrapTextWithAnsi(line, width));
}

export const ANALYTICS_TABS = [
	{ id: "tokens", label: "Tokens & cost" },
	{ id: "responses", label: "Response cycles" },
	{ id: "tools", label: "Tools" },
	{ id: "skills", label: "Skills" },
	{ id: "reliability", label: "Provider reliability" },
	{ id: "sessions", label: "Sessions & activity" },
] as const;

export type AnalyticsTab = (typeof ANALYTICS_TABS)[number]["id"];
export type DashboardResult = { tab: AnalyticsTab; cycle: boolean };

// Pi/Kit menus are vertical selectors. This read-only dashboard keeps a horizontal tab strip
// visible while scrolling metrics; it deliberately has no confirm/select affordance in the body.
export function createDashboard(
	{ tui, theme, keybindings, complete, signal }: CustomInteractionContext<DashboardResult>,
	options: {
		tab: AnalyticsTab;
		range: string;
		lines(tab: AnalyticsTab): readonly string[];
	},
) {
	let index = ANALYTICS_TABS.findIndex(({ id }) => id === options.tab);
	let offset = 0;
	let pageSize = 1;
	let maxOffset = 0;
	const rule = new HorizontalRule({ ruleStyle: (text) => theme.fg("borderMuted", text) });
	const actions = [
		"tui.select.cancel",
		"tui.editor.cursorLeft",
		"tui.editor.cursorRight",
		"tui.input.tab",
		"tui.select.up",
		"tui.select.down",
		"tui.select.pageUp",
		"tui.select.pageDown",
	] as const;
	// Probe the actual matcher, not configured strings: aliases and modifier order are accepted
	// by Pi. These are the raw, CSI-u and modifyOtherKeys forms accepted for r / shift+r.
	const cycleKeys = (
		[
			{ key: "r", inputs: ["r", "\u001b[114u", "\u001b[114;1u"] },
			{ key: "shift+r", inputs: ["R", "\u001b[114;2u", "\u001b[82;2u", "\u001b[27;2;82~"] },
		] as const
	).filter(
		({ inputs }) =>
			!inputs.some((data) => actions.some((action) => keybindings.matches(data, action))),
	);
	const hint = formatInteractionHints(keybindings, [
		{ bindings: ["tui.select.cancel"], keys: ["ctrl+c"], label: "close" },
		{
			bindings: ["tui.editor.cursorLeft", "tui.editor.cursorRight", "tui.input.tab"],
			label: "tab",
		},
		{ keys: cycleKeys.map(({ key }) => key), label: "range 7D/30D/ALL" },
		{ bindings: ["tui.select.up", "tui.select.down"], label: "scroll" },
		{ bindings: ["tui.select.pageUp", "tui.select.pageDown"], label: "page" },
	]);
	const tab = () => ANALYTICS_TABS[index] ?? ANALYTICS_TABS[0];
	return {
		invalidate() {},
		render(width: number): string[] {
			if (width <= 0) return [];
			const tabs: string[] = [];
			let row = "";
			for (const item of ANALYTICS_TABS) {
				const label = truncateToWidth(` ${item.label} `, width, "…");
				if (row && visibleWidth(row) + visibleWidth(label) + 1 > width) {
					tabs.push(row);
					row = "";
				}
				const styled =
					item.id === tab().id
						? theme.bg("selectedBg", theme.fg("accent", theme.bold(label)))
						: theme.fg("muted", label);
				row += `${row ? " " : ""}${styled}`;
			}
			if (row) tabs.push(row);
			const header = [
				...rule.render(width),
				theme.fg("accent", theme.bold(`Analytics · ${options.range}`)),
				...tabs,
				...rule.render(width),
			];
			const body = wrapMetrics(options.lines(tab().id).join("\n"), width);
			const footer = wrapMetrics(hint, width).map((line) => theme.fg("muted", line));
			pageSize = Math.max(1, tui.terminal.rows - header.length - footer.length - 3);
			maxOffset = Math.max(0, body.length - pageSize);
			offset = Math.min(offset, maxOffset);
			return [
				...header,
				...body.slice(offset, offset + pageSize),
				theme.fg(
					"dim",
					`${offset + 1}–${Math.min(body.length, offset + pageSize)} / ${body.length}`,
				),
				...footer,
				...rule.render(width),
			].map((line) => truncateToWidth(line, width, ""));
		},
		handleInput(data: string) {
			if (signal.aborted) return;
			const action = actions.find((binding) => keybindings.matches(data, binding));
			if (matchesKey(data, "ctrl+c") || action === "tui.select.cancel") {
				complete({ tab: tab().id, cycle: false });
				return;
			}
			if (
				action === "tui.editor.cursorLeft" ||
				action === "tui.editor.cursorRight" ||
				action === "tui.input.tab"
			) {
				index =
					(index + (action === "tui.editor.cursorLeft" ? -1 : 1) + ANALYTICS_TABS.length) %
					ANALYTICS_TABS.length;
				offset = 0;
			} else if (action === "tui.select.up") offset = Math.max(0, offset - 1);
			else if (action === "tui.select.down") offset = Math.min(maxOffset, offset + 1);
			else if (action === "tui.select.pageUp") offset = Math.max(0, offset - pageSize);
			else if (action === "tui.select.pageDown") offset = Math.min(maxOffset, offset + pageSize);
			else if (cycleKeys.some(({ key }) => matchesKey(data, key))) {
				complete({ tab: tab().id, cycle: true });
				return;
			}
			tui.requestRender();
		},
	};
}
