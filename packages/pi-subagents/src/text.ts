/**
 * Text helpers shared by every surface that displays or bounds untrusted text.
 *
 * These previously lived in the message broker, which is gone: they are pure
 * functions with no transport of their own, and the panel, widget, and tool
 * schemas need them whether or not children can send messages.
 */

const ESC = "\u001b";
const BEL = "\u0007";
/** CSI (`ESC [ … m`) and OSC (`ESC ] … BEL` / `ESC ] … ESC \\`) sequences. */
const TERMINAL_SEQUENCE = new RegExp(
	`${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`,
	"gu",
);

/** Bound on a job identifier, applied wherever one enters a tool schema. */
export const MAX_IDENTIFIER_LENGTH = 128;

/**
 * Strip terminal and bidirectional controls from text that came from a child or
 * a definition file, so rendering it cannot move the cursor, repaint the screen,
 * or reorder what the reader sees. Newlines and tabs are kept because they carry
 * layout the reader expects.
 */
export function sanitizeTerminalText(value: string): string {
	// Drop whole CSI and OSC sequences first: stripping only the escape byte would
	// leave their parameters (`[1;32m`) behind as visible text.
	return [...value.replace(TERMINAL_SEQUENCE, "")]
		.filter((character) => {
			const codePoint = character.codePointAt(0) ?? 0;
			if (character === "\n" || character === "\t") return true;
			if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return false;
			return !(
				(codePoint >= 0x202a && codePoint <= 0x202e) ||
				(codePoint >= 0x2066 && codePoint <= 0x2069)
			);
		})
		.join("");
}

/**
 * Format a duration for the panel and the widget: `42s`, `4m1s`, `5m`, `1h2m`.
 * Both surfaces show the same job, so they must agree on the notation.
 */
export function formatDuration(seconds: number): string {
	const whole = Math.max(0, Math.floor(seconds));
	if (whole < 60) return `${whole}s`;
	const hours = Math.floor(whole / 3_600);
	const minutes = Math.floor((whole % 3_600) / 60);
	const rest = whole % 60;
	if (hours > 0) return `${hours}h${minutes > 0 ? `${minutes}m` : ""}`;
	return `${minutes}m${rest > 0 ? `${rest}s` : ""}`;
}

/**
 * Compact token count: `842`, `6.6k`, `663k`, `1.0m`. It matches the notation
 * Pi's own footer uses, so a child's numbers read like the parent's.
 */
export function formatTokenCount(value: number): string {
	const whole = Math.max(0, Math.round(value));
	if (whole < 1_000) return `${whole}`;
	if (whole < 1_000_000) return `${(whole / 1_000).toFixed(whole < 10_000 ? 1 : 0)}k`;
	return `${(whole / 1_000_000).toFixed(1)}m`;
}
