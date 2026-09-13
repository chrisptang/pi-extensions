import { resolveDisplayStyle } from "./display.js";
import { formatCount } from "./helpers.js";
import { defineModule } from "./types.js";

export const contextModule = defineModule({
	name: "context",
	variables: ["symbol", "percentage", "tokens", "window"],
	defaults: {
		format: "[$symbol Ctx $tokens/$window $percentage ]($style)",
		symbol: "🪟",
		style: "none",
		disabled: false,
	},
	displayDefaults: [
		{ threshold: 0, style: "bold green", hidden: false },
		{ threshold: 30, style: "bold green", hidden: false },
		{ threshold: 60, style: "bold yellow", hidden: false },
		{ threshold: 80, style: "bold red", hidden: false },
	],
	styleVariables: ["style"],
	resolveStyleVariables: ({ runtime, display }) => ({
		style:
			resolveDisplayStyle(display, runtime.contextUsage?.percent) ?? display[0]?.style ?? "none",
	}),
	values: ({ runtime }) => {
		const percent = runtime.contextUsage?.percent;
		const tokens = runtime.contextUsage?.tokens;
		const window = runtime.contextUsage?.contextWindow;
		return {
			percentage: percent === null || percent === undefined ? "—" : `${percent.toFixed(1)}%`,
			tokens: tokens === null || tokens === undefined ? "—" : formatCount(tokens),
			window: window === null || window === undefined ? "—" : formatCount(window),
		};
	},
});
