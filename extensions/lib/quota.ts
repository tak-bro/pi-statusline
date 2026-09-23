/**
 * Z.ai GLM Coding Plan quota — fetch, parse, format.
 *
 * Endpoint is reverse-engineered (not in docs.z.ai): GET
 * https://api.z.ai/api/monitor/usage/quota/limit with `Authorization: Bearer <key>`.
 * Used in the wild by zai-quota-hud and zai_quotecheck; may break without notice.
 */

import { COLOR, paint, pickColor } from "./render.ts";

/** One CREDIT_LIMIT entry. `number`+`unit` name the window (unit 3 = hours, 6 = weeks — inferred, unverified). */
export interface QuotaLimit {
	type: string;
	number: number;
	unit: number;
	usage: number;
	currentValue: number;
	remaining: number;
	percentage: number;
	nextResetTime: number;
}

export interface QuotaData {
	limits: QuotaLimit[];
	level?: string;
}

/** Unwrap the `{ code, data }` envelope; null on anything unexpected. */
export const parseQuota = (json: unknown): QuotaData | null => {
	if (typeof json !== "object" || json === null) return null;
	const data = (json as { data?: unknown }).data;
	if (typeof data !== "object" || data === null) return null;
	const limits = (data as { limits?: unknown }).limits;
	if (!Array.isArray(limits) || limits.length === 0) return null;
	return data as QuotaData;
};

const unitLabel = (unit: number, number: number): string =>
	unit === 3 ? `${number}h` : unit === 6 ? `${number * 7}d` : `${number}${unit}`;

/** Countdown "1h 36m" or "36m" until epoch-ms reset time; empty when absent or past. */
export const formatCountdown = (nextResetTime: number, now = Date.now()): string => {
	if (!nextResetTime) return "";
	const ms = nextResetTime - now;
	if (ms <= 0) return "";
	const min = Math.ceil(ms / 60_000);
	const h = Math.floor(min / 60);
	const m = min % 60;
	return h > 0 ? `${h}h ${m}m` : `${m}m`;
};

/** "5h 25% (1h 36m)" — window label, percent, reset countdown in parens. */
export const formatLimit = (l: QuotaLimit, now = Date.now()): string => {
	const pct = Math.round(l.percentage);
	let text = `${unitLabel(l.unit, l.number)} ${pct}%`;
	const cd = formatCountdown(l.nextResetTime, now);
	if (cd) text += ` (${cd})`;
	return paint(pickColor(pct), text);
};

/** "ZAI 5h 25% (1h 36m) • 7d 83% (20h 36m)" — one entry per limit. */
export const formatQuota = (data: QuotaData, now = Date.now()): string => {
	const parts = data.limits.map((l) => formatLimit(l, now));
	return `${paint(COLOR.usage, "ZAI ")}${parts.join(paint(COLOR.usage, " • "))}`;
};

const ENDPOINT = "https://api.z.ai/api/monitor/usage/quota/limit";

/** Fetch + parse; null on any failure — the segment just hides, never errors. */
export const fetchQuota = async (apiKey: string): Promise<QuotaData | null> => {
	try {
		const res = await fetch(ENDPOINT, {
			headers: { Authorization: `Bearer ${apiKey}`, "Accept-Language": "en-US,en" },
		});
		if (!res.ok) return null;
		return parseQuota(await res.json());
	} catch {
		return null;
	}
};

// --- cache: render() fires every frame, so the network is touched at most once per TTL ---

const TTL_MS = 60_000;

let cache: { text: string | null; at: number } | null = null;

/** Clear memoized quota — exported for tests. */
export const resetQuotaCache = (): void => {
	cache = null;
};

/**
 * Cached segment text, or null when no key / stale data / fetch pending.
 * A stale cache triggers a background refresh; `onUpdate` fires (once) when fresh text lands.
 */
export const quotaSegment = (apiKey: string | undefined, onUpdate: () => void): string | null => {
	if (!apiKey) return null;
	if (cache && Date.now() - cache.at < TTL_MS) return cache.text;

	// serve the stale value one last time, then refresh in the background
	const stale = cache?.text ?? null;
	void fetchQuota(apiKey).then((data) => {
		if (data) cache = { text: formatQuota(data), at: Date.now() };
		// on failure keep serving the last good text; retry after a full TTL
		else cache = stale !== null ? { text: stale, at: Date.now() } : null;
		if (cache?.text) onUpdate();
	});
	cache = { text: null, at: Date.now() };
	return stale;
};
