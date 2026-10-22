import type { MessageUpdateEvent } from "@earendil-works/pi-coding-agent";
import { defineModule } from "./types.js";

export const speedModule = defineModule({
	name: "speed",
	variables: ["symbol", "ttft", "tok_per_sec"],
	defaults: {
		format: "[TTFT $ttft · $tok_per_sec tok/s ]($style)",
		symbol: "",
		style: "dimmed",
		disabled: false,
	},
	values: ({ runtime }) => ({
		ttft:
			runtime.responseSpeed?.ttftSeconds === undefined
				? "—"
				: `${runtime.responseSpeed.ttftSeconds.toFixed(2)}s`,
		tok_per_sec:
			runtime.responseSpeed?.tokensPerSecond === undefined
				? "—"
				: runtime.responseSpeed.tokensPerSecond.toFixed(1),
	}),
});

export function hasResponseContent(event: MessageUpdateEvent["assistantMessageEvent"]): boolean {
	switch (event.type) {
		case "text_delta":
		case "thinking_delta":
		case "toolcall_delta":
			return event.delta.length > 0;
		case "text_start":
		case "text_end":
		case "thinking_start":
		case "thinking_end":
		case "toolcall_start":
		case "toolcall_end": {
			const block = event.partial.content[event.contentIndex];
			if (block?.type === "text") return block.text.length > 0;
			if (block?.type === "thinking") {
				return block.thinking.length > 0 || (block.redacted === true && !!block.thinkingSignature);
			}
			return block?.type === "toolCall" && block.name.length > 0;
		}
		default:
			return false;
	}
}
