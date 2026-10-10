import { sanitizeTerminalText } from "@narumitw/pi-tui-kit/terminal-text";
import { defineModule } from "./types.js";

export const sessionNameModule = defineModule({
	name: "session_name",
	variables: ["symbol", "name"],
	defaults: {
		format: "[ $symbol $name ]($style)",
		symbol: "✎",
		style: "white",
		disabled: false,
	},
	values: ({ runtime }) => {
		const name = runtime.sessionName?.trim();
		if (!name) return undefined;
		return { name: sanitizeTerminalText(name) };
	},
});
