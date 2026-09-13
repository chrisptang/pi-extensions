import { sanitizeTerminalText } from "./text.js";

/** Events retained per job. The oldest are dropped once the buffer is full. */
export const MAX_ACTIVITY_EVENTS = 200;
/** Per-entry display budget. A longer summary is truncated, never dropped. */
export const MAX_ACTIVITY_TEXT_BYTES = 512;

export type ActivityKind = "tool" | "output" | "notice";

export interface ActivityEvent {
	/** Monotonic per-job sequence, so a renderer can detect gaps and dedupe. */
	seq: number;
	at: number;
	kind: ActivityKind;
	/** Tool name for `tool` events; absent otherwise. */
	tool?: string;
	/** Redacted single-line argument summary, or the visible output text. */
	detail: string;
	/** Set on a `tool` event once its result arrives. */
	outcome?: "ok" | "error";
	/** Redacted single-line result summary, when the result carried one. */
	result?: string;
}

/**
 * Values whose own name marks them as a credential. The child runs with the
 * user's permissions, so its tool arguments and output can legitimately contain
 * secrets; the panel is a display surface and must not become the place they
 * leak to a screen share or a terminal scrollback.
 */
const SECRET_ASSIGNMENT =
	/\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)[A-Z0-9_]*)\s*[=:]\s*("[^"]*"|'[^']*'|\S+)/giu;
/** Well-known credential shapes that carry no adjacent name to key off. */
const SECRET_PATTERNS: RegExp[] = [
	/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/gu,
	/\bgh[pousr]_[A-Za-z0-9]{16,}/gu,
	/\bxox[abprs]-[A-Za-z0-9-]{10,}/gu,
	/\bAKIA[0-9A-Z]{16}\b/gu,
	/\bAIza[0-9A-Za-z_-]{20,}/gu,
	/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/gu,
	/-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END[A-Z ]*PRIVATE KEY-----|$)/gu,
	/\b(?:Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{12,}/giu,
	/\b[0-9a-f]{40,}\b/giu,
];
const REDACTED = "***";

/**
 * Redact credential-shaped text before it reaches the panel.
 *
 * This is a display safeguard, not a security boundary: it cannot recognize
 * every secret. Argument summarization does the heavier lifting by never
 * emitting file bodies in the first place.
 */
export function redactSecrets(value: string): string {
	// Shape patterns run first. The name rule is greedier about where a value
	// starts — `Authorization: Bearer <token>` looks to it like the name
	// `Authorization` assigned the value `Bearer` — and running it first would
	// leave the token itself standing.
	let redacted = value;
	for (const pattern of SECRET_PATTERNS) redacted = redacted.replace(pattern, REDACTED);
	return redacted.replace(SECRET_ASSIGNMENT, (_match, name: string) => `${name}=${REDACTED}`);
}

/** Collapse to one sanitized, redacted, length-bounded display line. */
export function toDisplayLine(value: string): string {
	const collapsed = redactSecrets(sanitizeTerminalText(value)).replace(/\s+/gu, " ").trim();
	return truncateDisplay(collapsed);
}

const TRUNCATION_SUFFIX = "… [truncated]";

function truncateDisplay(value: string): string {
	const bytes = Buffer.from(value, "utf8");
	if (bytes.length <= MAX_ACTIVITY_TEXT_BYTES) return value;
	// The suffix is measured in bytes, not characters: its ellipsis is multi-byte,
	// so budgeting by length would push the result past the cap.
	const budget = Math.max(
		0,
		MAX_ACTIVITY_TEXT_BYTES - Buffer.byteLength(TRUNCATION_SUFFIX, "utf8"),
	);
	const head = bytes
		.subarray(0, budget)
		.toString("utf8")
		.replace(/\uFFFD+$/u, "");
	return `${head}${TRUNCATION_SUFFIX}`;
}

/**
 * Summarize tool arguments for display.
 *
 * Each known tool contributes only the fields that say what it is acting on.
 * File bodies are deliberately reduced to a byte count: `write` and `edit`
 * carry whole file contents, and rendering those would both flood the panel and
 * put whatever the child is writing — a `.env`, a key file — on screen.
 */
export function summarizeToolArgs(tool: string, args: unknown): string {
	const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
	const parts = summarizeKnownTool(tool, record) ?? summarizeUnknownTool(record);
	return toDisplayLine(parts.join(" "));
}

function summarizeKnownTool(tool: string, args: Record<string, unknown>): string[] | undefined {
	switch (tool) {
		case "read":
			return [pathOf(args), rangeOf(args)].filter(nonEmpty);
		case "write":
			return [pathOf(args), byteCountOf(args.content)].filter(nonEmpty);
		case "edit":
			return [pathOf(args), editShapeOf(args)].filter(nonEmpty);
		case "bash":
		case "powershell":
			return [stringOf(args.command)].filter(nonEmpty);
		case "grep":
			return [quoted(stringOf(args.pattern)), stringOf(args.path)].filter(nonEmpty);
		case "find":
		case "ls":
			return [stringOf(args.path ?? args.pattern ?? args.glob)].filter(nonEmpty);
		default:
			return undefined;
	}
}

/**
 * An unrecognized tool — a child communication tool, or one added by a future
 * Pi release — still gets a summary, but only from its short scalar fields.
 * Anything long is reported by size, on the same reasoning as a file body.
 */
function summarizeUnknownTool(args: Record<string, unknown>): string[] {
	const parts: string[] = [];
	for (const [key, value] of Object.entries(args).slice(0, 4)) {
		if (typeof value === "string") {
			parts.push(value.length <= 64 ? `${key}=${value}` : `${key}=${byteCountOf(value)}`);
		} else if (typeof value === "number" || typeof value === "boolean") {
			parts.push(`${key}=${String(value)}`);
		}
	}
	return parts;
}

function pathOf(args: Record<string, unknown>): string {
	return stringOf(args.path ?? args.filePath ?? args.file);
}

function rangeOf(args: Record<string, unknown>): string {
	const offset = numberOf(args.offset ?? args.lineOffset);
	const limit = numberOf(args.limit ?? args.lineLimit);
	if (offset === undefined && limit === undefined) return "";
	return `(${offset ?? 0}${limit === undefined ? "+" : `..${(offset ?? 0) + limit}`})`;
}

function editShapeOf(args: Record<string, unknown>): string {
	const replacement = args.newString ?? args.new_string ?? args.replacement;
	if (typeof replacement !== "string") return "";
	return `→ ${byteCountOf(replacement)}`;
}

function byteCountOf(value: unknown): string {
	if (typeof value !== "string") return "";
	return `(${Buffer.byteLength(value, "utf8")} bytes)`;
}

function quoted(value: string): string {
	return value === "" ? "" : `"${value}"`;
}

function stringOf(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function numberOf(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonEmpty(value: string): boolean {
	return value !== "";
}

/**
 * Summarize a tool result. Pi tool results carry model-visible content plus
 * arbitrary structured details; only the text content is worth a display line,
 * and only its first line of it.
 */
export function summarizeToolResult(result: unknown): string {
	if (typeof result === "string") return toDisplayLine(result);
	if (!result || typeof result !== "object") return "";
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) return "";
	const text = content
		.filter(
			(part): part is { type: "text"; text: string } =>
				!!part &&
				typeof part === "object" &&
				(part as { type?: unknown }).type === "text" &&
				typeof (part as { text?: unknown }).text === "string",
		)
		.map((part) => part.text)
		.join(" ");
	return toDisplayLine(text);
}

/**
 * Per-job ring buffer of activity events.
 *
 * A tool call and its result share one entry, so the panel shows a stable row
 * that gains an outcome rather than two rows the reader has to pair up. The
 * pairing is by tool-call id, which the child's events always carry.
 */
export class ActivityLog {
	private readonly events: ActivityEvent[] = [];
	private readonly pending = new Map<string, ActivityEvent>();
	private sequence = 0;
	private dropped = 0;

	constructor(private readonly capacity: number = MAX_ACTIVITY_EVENTS) {}

	/** Number of events evicted by the capacity bound, for display honesty. */
	get droppedCount(): number {
		return this.dropped;
	}

	toolStart(toolCallId: string, tool: string, args: unknown, at: number): ActivityEvent {
		const event = this.append({
			seq: ++this.sequence,
			at,
			kind: "tool",
			tool: toDisplayLine(tool),
			detail: summarizeToolArgs(tool, args),
		});
		this.pending.set(toolCallId, event);
		return event;
	}

	/**
	 * Complete the entry the matching start created. A result whose start was
	 * already evicted, or never seen, becomes its own entry so the activity is
	 * still reported rather than silently dropped.
	 */
	toolEnd(toolCallId: string, tool: string, result: unknown, isError: boolean, at: number): void {
		const outcome = isError ? "error" : "ok";
		const summary = summarizeToolResult(result);
		const started = this.pending.get(toolCallId);
		this.pending.delete(toolCallId);
		if (started && this.events.includes(started)) {
			started.outcome = outcome;
			if (summary) started.result = summary;
			return;
		}
		this.append({
			seq: ++this.sequence,
			at,
			kind: "tool",
			tool: toDisplayLine(tool),
			detail: "",
			outcome,
			...(summary ? { result: summary } : {}),
		});
	}

	/** Assistant text the child made visible. Thinking never reaches here. */
	output(text: string, at: number): void {
		const detail = toDisplayLine(text);
		if (!detail) return;
		this.append({ seq: ++this.sequence, at, kind: "output", detail });
	}

	/** Runtime-level note, such as a lifecycle transition. */
	notice(text: string, at: number): void {
		const detail = toDisplayLine(text);
		if (!detail) return;
		this.append({ seq: ++this.sequence, at, kind: "notice", detail });
	}

	snapshot(): ActivityEvent[] {
		return this.events.map((event) => ({ ...event }));
	}

	private append(event: ActivityEvent): ActivityEvent {
		this.events.push(event);
		while (this.events.length > this.capacity) {
			const evicted = this.events.shift();
			this.dropped++;
			if (evicted) {
				for (const [id, pending] of this.pending) {
					if (pending === evicted) this.pending.delete(id);
				}
			}
		}
		return event;
	}
}
