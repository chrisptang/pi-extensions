import { formatCount } from "./helpers.js";
import { defineModule } from "./types.js";

export const cacheModule = defineModule({
	name: "cache",
	variables: ["symbol", "rate", "session_rate", "read", "write"],
	defaults: {
		format: "[Cache $session_rate ]($style)",
		symbol: "",
		style: "bold green",
		disabled: false,
	},
	values: ({ runtime }) => {
		const { cacheRead, cacheWrite, latestCacheHitRate, sessionCacheHitRate } = runtime.tokenTotals;
		return {
			rate: latestCacheHitRate === undefined ? "—" : `${latestCacheHitRate.toFixed(1)}%`,
			session_rate: sessionCacheHitRate === undefined ? "—" : `${sessionCacheHitRate.toFixed(1)}%`,
			read: formatCount(cacheRead),
			write: formatCount(cacheWrite),
		};
	},
});
