import { formatCount } from "./helpers.js";
import { defineModule } from "./types.js";

export const tokensModule = defineModule({
	name: "tokens",
	variables: ["symbol", "input", "output", "total", "total_input"],
	defaults: {
		format: "[ΣIn $total_input · ΣOut $output ]($style)",
		symbol: "",
		style: "bold cyan",
		disabled: false,
	},
	values: ({ runtime }) => {
		if (runtime.tokenTotals.hasUsage === false) {
			return { input: "—", output: "—", total: "—", total_input: "—" };
		}
		return {
			input: formatCount(runtime.tokenTotals.input),
			output: formatCount(runtime.tokenTotals.output),
			total: formatCount(runtime.tokenTotals.input + runtime.tokenTotals.output),
			total_input: formatCount(
				runtime.tokenTotals.input + runtime.tokenTotals.cacheRead + runtime.tokenTotals.cacheWrite,
			),
		};
	},
});
