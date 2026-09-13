import type { Api, Model } from "@earendil-works/pi-ai";

/**
 * How long a candidate stays sidelined when the provider rate-limits it without
 * saying for how long. Short enough that a brief burst limit clears on its own,
 * long enough that the next turn does not immediately retry the same model.
 */
export const DEFAULT_COOLDOWN_MS = 60_000;

/**
 * Upper bound on a server-requested cooldown. A provider reporting a multi-hour
 * quota reset would otherwise sideline a candidate for the rest of the session;
 * capping keeps the pool usable while still respecting a plausible `retry-after`.
 */
export const MAX_COOLDOWN_MS = 15 * 60_000;

/** Key a candidate by reference, so one 429 sidelines it in every pool that lists it. */
export function modelKey(model: Pick<Model<Api>, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

/** Headers arrive lowercased from `fetch`, but Bedrock passes a raw record through. */
function header(headers: Record<string, string> | undefined, name: string): string | undefined {
	if (!headers) return undefined;
	const direct = headers[name];
	if (direct !== undefined) return direct;
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === name) return value;
	}
	return undefined;
}

/**
 * Read a cooldown from a rate-limit response, mirroring the header precedence in
 * Pi's own provider retry (`retry-after-ms`, then `retry-after` as either seconds
 * or an HTTP-date). Returns undefined when no header gives a usable duration, so
 * the caller can fall back to {@link DEFAULT_COOLDOWN_MS}.
 */
export function parseRetryAfterMs(
	headers: Record<string, string> | undefined,
	now: number,
): number | undefined {
	const retryAfterMs = header(headers, "retry-after-ms");
	if (retryAfterMs !== undefined) {
		const value = Number.parseFloat(retryAfterMs);
		if (Number.isFinite(value) && value >= 0) return value;
	}

	const retryAfter = header(headers, "retry-after");
	if (retryAfter !== undefined) {
		const seconds = Number.parseFloat(retryAfter);
		// A bare number is a delay in seconds; anything else is an HTTP-date.
		if (Number.isFinite(seconds)) {
			if (seconds >= 0) return seconds * 1000;
		} else {
			const deadline = Date.parse(retryAfter);
			if (!Number.isNaN(deadline) && deadline > now) return deadline - now;
		}
	}
	return undefined;
}

/**
 * Tracks candidates that a provider has rate-limited, so alias resolution can skip
 * them until their cooldown expires. Entries are session-scoped and time-bounded:
 * a 429 sidelines a model rather than disabling it, because rate limits recover.
 */
export class CooldownRegistry {
	private readonly until = new Map<string, number>();

	constructor(private readonly now: () => number = Date.now) {}

	/**
	 * Sideline a model until its cooldown expires. A server-requested delay wins,
	 * clamped to {@link MAX_COOLDOWN_MS}; an absent or unusable header falls back to
	 * {@link DEFAULT_COOLDOWN_MS}. The longer of a new and an existing cooldown wins,
	 * so repeated limits extend rather than shorten the sideline.
	 */
	penalize(model: Pick<Model<Api>, "provider" | "id">, headers?: Record<string, string>): number {
		const now = this.now();
		const requested = parseRetryAfterMs(headers, now);
		const durationMs = Math.min(requested ?? DEFAULT_COOLDOWN_MS, MAX_COOLDOWN_MS);
		const key = modelKey(model);
		const expiry = Math.max(now + durationMs, this.until.get(key) ?? 0);
		this.until.set(key, expiry);
		return expiry - now;
	}

	/** True while the model is sidelined; an expired entry is dropped on read. */
	isCoolingDown(model: Pick<Model<Api>, "provider" | "id">): boolean {
		const key = modelKey(model);
		const expiry = this.until.get(key);
		if (expiry === undefined) return false;
		if (expiry <= this.now()) {
			this.until.delete(key);
			return false;
		}
		return true;
	}

	/** Remaining cooldown in milliseconds, or zero when the model is usable. */
	remainingMs(model: Pick<Model<Api>, "provider" | "id">): number {
		if (!this.isCoolingDown(model)) return 0;
		return (this.until.get(modelKey(model)) ?? 0) - this.now();
	}

	clear(): void {
		this.until.clear();
	}
}
