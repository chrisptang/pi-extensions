/**
 * Text helpers shared by every surface that displays or bounds untrusted text.
 *
 * These previously lived in the message broker, which is gone: they are pure
 * functions with no transport of their own, and the panel, widget, and tool
 * schemas need them whether or not children can send messages.
 */

/** Bound on a job identifier, applied wherever one enters a tool schema. */
export const MAX_IDENTIFIER_LENGTH = 128;

/**
 * Strip terminal and bidirectional controls from text that came from a child or
 * a definition file, so rendering it cannot move the cursor, repaint the screen,
 * or reorder what the reader sees. Newlines and tabs are kept because they carry
 * layout the reader expects.
 */
export function sanitizeTerminalText(value: string): string {
	return [...value]
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
