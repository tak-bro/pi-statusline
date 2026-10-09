/**
 * Subscription quota for the active provider — fetch, parse, format, cache.
 *
 * Every endpoint here is undocumented and may break without notice; any failure
 * just hides the segment.
 * - zai: GET https://api.z.ai/api/monitor/usage/quota/limit, `Authorization: Bearer <key>`
 *   (used in the wild by zai-quota-hud and zai_quotecheck).
 * - anthropic: GET https://api.anthropic.com/api/oauth/usage with the OAuth token and
 *   `anthropic-beta: oauth-2025-04-20` (the endpoint tak-cc-statusline reads).
 * - openai-codex: GET https://chatgpt.com/backend-api/wham/usage with the ChatGPT token
 *   and `ChatGPT-Account-Id` (shape from emanuelcasco/pi-mono-extensions, MIT; unverified).
 */

import { createHash } from "node:crypto";
import { COLOR, paint } from "./render.ts";

/** One rate-limit window, normalized across providers. `resetAt` is epoch ms, 0 when unknown. */
export interface QuotaWindow {
	label: string;
	percent: number;
	resetAt: number;
}

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const obj = (v: unknown): Record<string, unknown> | null =>
	typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;

// --- zai ---

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
	const data = obj(obj(json)?.data);
	if (!data) return null;
	const limits = data.limits;
	if (!Array.isArray(limits) || limits.length === 0) return null;
	return data as unknown as QuotaData;
};

const unitLabel = (unit: number, number: number): string =>
	unit === 3 ? `${number}h` : unit === 6 ? `${number * 7}d` : `${number}${unit}`;

/** Entries with non-numeric fields are dropped: their text would reach the terminal verbatim. */
export const zaiWindows = (data: QuotaData): QuotaWindow[] =>
	data.limits
		.filter((l) => isNum(l.unit) && isNum(l.number) && isNum(l.percentage))
		.map((l) => ({
			label: unitLabel(l.unit, l.number),
			percent: l.percentage,
			resetAt: isNum(l.nextResetTime) ? l.nextResetTime : 0,
		}));

// --- anthropic ---

/** five_hour / seven_day `{ utilization, resets_at: ISO }`; null when neither is usable. */
export const parseAnthropic = (json: unknown): QuotaWindow[] | null => {
	const root = obj(json);
	if (!root) return null;
	const windows: QuotaWindow[] = [];
	for (const [key, label] of [["five_hour", "5h"], ["seven_day", "7d"]] as const) {
		const w = obj(root[key]);
		if (!w || !isNum(w.utilization)) continue;
		const reset = typeof w.resets_at === "string" ? Date.parse(w.resets_at) : NaN;
		windows.push({ label, percent: w.utilization, resetAt: Number.isNaN(reset) ? 0 : reset });
	}
	return windows.length > 0 ? windows : null;
};

// --- openai-codex ---

/** "5h" under a day, else "7d" — from the window length in seconds. */
const windowLabel = (seconds: number): string =>
	seconds >= 86_400 ? `${Math.round(seconds / 86_400)}d` : `${Math.round(seconds / 3600)}h`;

/** rate_limit.primary_window / secondary_window `{ used_percent, reset_at: epoch s, limit_window_seconds }`. */
export const parseCodex = (json: unknown): QuotaWindow[] | null => {
	const rl = obj(obj(json)?.rate_limit);
	if (!rl) return null;
	const windows: QuotaWindow[] = [];
	for (const key of ["primary_window", "secondary_window"]) {
		const w = obj(rl[key]);
		if (!w || !isNum(w.used_percent) || !isNum(w.limit_window_seconds)) continue;
		windows.push({
			label: windowLabel(w.limit_window_seconds),
			percent: w.used_percent,
			resetAt: isNum(w.reset_at) ? w.reset_at * 1000 : 0,
		});
	}
	return windows.length > 0 ? windows : null;
};

/** ChatGPT account id from the access token's JWT claims — the claim pi's codex provider reads. */
export const codexAccountId = (token: string): string | null => {
	try {
		const payload = token.split(".")[1];
		if (!payload) return null;
		const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
		const id = obj(claims["https://api.openai.com/auth"])?.chatgpt_account_id;
		return typeof id === "string" && id ? id : null;
	} catch {
		return null;
	}
};

// --- provider table ---

interface Adapter {
	url: string;
	/** null when the key cannot be used (e.g. a codex token without an account claim). */
	headers(key: string): Record<string, string> | null;
	parse(json: unknown): QuotaWindow[] | null;
}

const ADAPTERS: Record<string, Adapter> = {
	zai: {
		url: "https://api.z.ai/api/monitor/usage/quota/limit",
		headers: (key) => ({ Authorization: `Bearer ${key}`, "Accept-Language": "en-US,en" }),
		parse: (json) => {
			const data = parseQuota(json);
			const windows = data ? zaiWindows(data) : [];
			return windows.length > 0 ? windows : null;
		},
	},
	anthropic: {
		url: "https://api.anthropic.com/api/oauth/usage",
		headers: (key) => ({ Authorization: `Bearer ${key}`, "anthropic-beta": "oauth-2025-04-20" }),
		parse: parseAnthropic,
	},
	"openai-codex": {
		url: "https://chatgpt.com/backend-api/wham/usage",
		headers: (key) => {
			const account = codexAccountId(key);
			return account ? { Authorization: `Bearer ${key}`, "ChatGPT-Account-Id": account } : null;
		},
		parse: parseCodex,
	},
};

export const hasQuota = (provider: string | undefined): provider is string =>
	provider !== undefined && Object.hasOwn(ADAPTERS, provider);

/**
 * The key is sent to the adapter's fixed host, so only ask when the model talks to that
 * host too — a `zai`/`anthropic` entry pointed at a proxy holds a key meant for the proxy.
 * No baseUrl (or an unparsable one) means the provider default.
 */
export const quotaHostMatches = (provider: string, baseUrl: string | undefined): boolean => {
	if (!baseUrl || !hasQuota(provider)) return true;
	try {
		return new URL(baseUrl).hostname === new URL(ADAPTERS[provider]!.url).hostname;
	} catch {
		return true;
	}
};

const FETCH_TIMEOUT_MS = 5000;

/** Fetch + parse; null on any failure — the segment just hides, never errors. */
export const fetchWindows = async (
	provider: string,
	key: string,
	fetcher: Fetcher = fetch,
): Promise<QuotaWindow[] | null> => {
	const adapter = ADAPTERS[provider];
	const headers = adapter?.headers(key);
	if (!adapter || !headers) return null;
	try {
		// a redirect is never the normal path; following one could carry the token elsewhere
		const res = await fetcher(adapter.url, {
			headers,
			redirect: "error",
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!res.ok) return null;
		return adapter.parse(await res.json());
	} catch {
		return null;
	}
};

// --- format ---

/** Countdown "1h 36m" or "36m" until epoch-ms reset time; empty when absent or past. */
export const formatCountdown = (resetAt: number, now = Date.now()): string => {
	if (!resetAt) return "";
	const ms = resetAt - now;
	if (ms <= 0) return "";
	const min = Math.ceil(ms / 60_000);
	const h = Math.floor(min / 60);
	const m = min % 60;
	return h > 0 ? `${h}h ${m}m` : `${m}m`;
};

/** "5h 25% (1h 36m)" — label+percent in usage gray, reset countdown dimmed. */
export const formatWindow = (w: QuotaWindow, now = Date.now()): string => {
	let text = `${w.label} ${Math.round(w.percent)}%`;
	const cd = formatCountdown(w.resetAt, now);
	if (cd) text += paint(COLOR.dim, ` (${cd})`);
	return paint(COLOR.usage, text);
};

/** "5h 25% (1h 36m) • 7d 83% (20h 36m)" — one entry per window. */
export const formatWindows = (windows: QuotaWindow[], now = Date.now()): string =>
	windows.map((w) => formatWindow(w, now)).join(paint(COLOR.usage, " • "));

// --- cache: render() fires every frame, so the network is touched at most once per TTL ---

const TTL_MS = 60_000;
/** How long the last good text may outlive failing refreshes before the segment hides. */
const STALE_MAX_MS = 5 * TTL_MS;

/** Which credential produced the text — never the credential itself. */
const fingerprint = (key: string): string => createHash("sha256").update(key).digest("hex").slice(0, 16);

/** `okAt` = when `text` was last fetched successfully. */
let cache: { provider: string; keyFp: string; text: string | null; at: number; okAt: number } | null = null;
let inflight: string | null = null;
/** Provider of the latest render; a refresh for any other provider lands nowhere. */
let wanted: string | null = null;

/** Clear memoized quota — exported for tests. */
export const resetQuotaCache = (): void => {
	cache = null;
	inflight = null;
	wanted = null;
};

/** `p`, or undefined once FETCH_TIMEOUT_MS passes — a stuck key lookup must not wedge refreshes. */
const withTimeout = <T>(p: Promise<T>): Promise<T | undefined> =>
	new Promise((resolve, reject) => {
		const timer = setTimeout(() => resolve(undefined), FETCH_TIMEOUT_MS);
		p.then(
			(v) => (clearTimeout(timer), resolve(v)),
			(e) => (clearTimeout(timer), reject(e)),
		);
	});

/**
 * Cached segment text for `provider`, or null when unsupported / no data yet.
 *
 * Render stays synchronous: a stale or missing entry starts one background refresh,
 * which resolves the key (so a re-login is picked up within a TTL), fetches, and
 * fires `onUpdate`. Until it lands the previous text keeps showing — but only for
 * the same provider, and a refresh under a different credential drops it.
 * A failed refresh is not retried before the TTL runs out; it keeps the last good
 * text for the same credential up to STALE_MAX_MS, then hides.
 */
export const quotaSegment = (
	provider: string | undefined,
	resolveKey: () => Promise<string | undefined>,
	onUpdate: () => void,
	fetcher: Fetcher = fetch,
): string | null => {
	if (!hasQuota(provider)) return null;
	wanted = provider;
	const current = cache?.provider === provider ? cache : null;
	if (current && Date.now() - current.at < TTL_MS) return current.text;

	if (inflight !== provider) {
		inflight = provider;
		void (async () => {
			let keyFp = "";
			let text: string | null = null;
			try {
				const key = await withTimeout(resolveKey());
				if (key) {
					keyFp = fingerprint(key);
					const windows = await fetchWindows(provider, key, fetcher);
					if (windows) text = formatWindows(windows);
				}
			} catch {
				// resolveKey threw — same as no credential: the segment hides
			}
			if (inflight === provider) inflight = null;
			if (wanted !== provider) return; // the user moved on; don't evict the newer provider
			const now = Date.now();
			if (text !== null) {
				cache = { provider, keyFp, text, at: now, okAt: now };
			} else {
				const prev = cache?.provider === provider && cache.keyFp === keyFp ? cache : null;
				const keep = prev?.text != null && now - prev.okAt < STALE_MAX_MS;
				cache = { provider, keyFp, text: keep ? prev.text : null, at: now, okAt: keep ? prev.okAt : 0 };
			}
			onUpdate();
		})();
	}
	return current?.text ?? null;
};
