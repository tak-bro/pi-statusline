import { afterEach, describe, expect, test } from "bun:test";
import {
	codexAccountId,
	type Fetcher,
	fetchWindows,
	formatCountdown,
	formatWindows,
	parseAnthropic,
	parseCodex,
	parseQuota,
	type QuotaData,
	quotaHostMatches,
	quotaSegment,
	resetQuotaCache,
	zaiWindows,
} from "./quota.ts";

const NOW = 1_790_000_000_000;
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

/** Real-shaped sample: 5h window at 5%, weekly window at 24%. */
const zaiSample = {
	code: 200,
	msg: "Operation successful",
	data: {
		limits: [
			{ type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 2000, currentValue: 115, remaining: 1884, percentage: 5, nextResetTime: NOW + 90 * 60_000 },
			{ type: "CREDIT_LIMIT", unit: 6, number: 1, usage: 10000, currentValue: 2492, remaining: 7507, percentage: 24, nextResetTime: NOW + 2 * 24 * 60 * 60_000 },
		],
		level: "lite",
	},
};

const anthropicSample = {
	five_hour: { utilization: 3, resets_at: new Date(NOW + 2 * 3600_000).toISOString() },
	seven_day: { utilization: 43, resets_at: new Date(NOW + 30 * 3600_000).toISOString() },
};

const codexSample = {
	plan_type: "plus",
	rate_limit: {
		primary_window: { used_percent: 12, limit_window_seconds: 18_000, reset_at: (NOW + 3600_000) / 1000 },
		secondary_window: { used_percent: 40, limit_window_seconds: 604_800, reset_at: (NOW + 86_400_000) / 1000 },
	},
};

/** JWT with the ChatGPT account claim pi's codex provider reads; signature is irrelevant here. */
const jwt = (claims: unknown) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
const codexToken = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } });

describe("parseQuota (zai)", () => {
	test("unwraps the envelope", () => {
		const data = parseQuota(zaiSample);
		expect(data).not.toBeNull();
		expect(data!.limits).toHaveLength(2);
		expect(data!.level).toBe("lite");
	});
	test("null on garbage", () => {
		expect(parseQuota(null)).toBeNull();
		expect(parseQuota({})).toBeNull();
		expect(parseQuota({ data: {} })).toBeNull();
		expect(parseQuota({ data: { limits: [] } })).toBeNull();
	});
	test("drops entries with non-numeric fields (their text would reach the terminal)", () => {
		const data = parseQuota(zaiSample) as QuotaData;
		const bad = { ...data.limits[0]!, unit: "\x1b]0;pwn\x07" as unknown as number };
		expect(zaiWindows({ limits: [bad, data.limits[1]!] }).map((w) => w.label)).toEqual(["7d"]);
	});
	test("windows carry label, percent and ms reset", () => {
		const w = zaiWindows(parseQuota(zaiSample) as QuotaData);
		expect(w.map((x) => x.label)).toEqual(["5h", "7d"]);
		expect(w[0]!.resetAt).toBe(NOW + 90 * 60_000);
	});
});

describe("parseAnthropic", () => {
	test("five_hour and seven_day with ISO reset", () => {
		expect(parseAnthropic(anthropicSample)).toEqual([
			{ label: "5h", percent: 3, resetAt: NOW + 2 * 3600_000 },
			{ label: "7d", percent: 43, resetAt: NOW + 30 * 3600_000 },
		]);
	});
	test("skips windows without a numeric utilization; unparsable reset → 0", () => {
		const w = parseAnthropic({ five_hour: { utilization: "3" }, seven_day: { utilization: 1, resets_at: "nope" } });
		expect(w).toEqual([{ label: "7d", percent: 1, resetAt: 0 }]);
	});
	test("null when nothing usable", () => {
		expect(parseAnthropic(null)).toBeNull();
		expect(parseAnthropic({ error: "unauthorized" })).toBeNull();
	});
});

describe("parseCodex", () => {
	test("primary/secondary windows, label from window length, reset seconds → ms", () => {
		expect(parseCodex(codexSample)).toEqual([
			{ label: "5h", percent: 12, resetAt: NOW + 3600_000 },
			{ label: "7d", percent: 40, resetAt: NOW + 86_400_000 },
		]);
	});
	test("null without rate_limit or usable windows", () => {
		expect(parseCodex({})).toBeNull();
		expect(parseCodex({ rate_limit: { primary_window: { used_percent: 1 } } })).toBeNull();
	});
});

describe("codexAccountId", () => {
	test("reads the chatgpt_account_id claim", () => {
		expect(codexAccountId(codexToken)).toBe("acct-1");
	});
	test("null on malformed tokens", () => {
		expect(codexAccountId("not-a-jwt")).toBeNull();
		expect(codexAccountId("a.!!!.c")).toBeNull();
		expect(codexAccountId(jwt({ sub: "x" }))).toBeNull();
	});
});

describe("formatCountdown", () => {
	test("hours+minutes", () => {
		expect(formatCountdown(NOW + 83 * 60_000, NOW)).toBe("1h 23m");
	});
	test("minutes only", () => {
		expect(formatCountdown(NOW + 5 * 60_000, NOW)).toBe("5m");
	});
	test("empty past or absent", () => {
		expect(formatCountdown(NOW - 1, NOW)).toBe("");
		expect(formatCountdown(0, NOW)).toBe("");
	});
});

describe("formatWindows", () => {
	test("one segment per window: label, percent, countdown in parens", () => {
		const text = strip(formatWindows(zaiWindows(parseQuota(zaiSample) as QuotaData), NOW));
		expect(text).toBe("5h 5% (1h 30m) • 7d 24% (48h 0m)");
	});
	test("drops countdown when reset time passed", () => {
		expect(strip(formatWindows([{ label: "5h", percent: 5, resetAt: NOW - 1 }], NOW))).toBe("5h 5%");
	});
});

/** Fetcher stub: records calls, answers from a queue (last answer repeats; an Error rejects). */
const stubFetch = (...answers: Array<{ status?: number; body?: unknown } | Error>) => {
	const calls: Array<{ url: string; headers: Record<string, string>; redirect?: RequestRedirect }> = [];
	const fetcher: Fetcher = async (url, init) => {
		calls.push({ url, headers: init.headers as Record<string, string>, redirect: init.redirect });
		const a = answers.length > 1 ? answers.shift()! : answers[0]!;
		if (a instanceof Error) throw a;
		return new Response(JSON.stringify(a.body ?? {}), { status: a.status ?? 200 });
	};
	return { fetcher, calls };
};

describe("quotaHostMatches", () => {
	test("default or matching host → ask", () => {
		expect(quotaHostMatches("anthropic", undefined)).toBe(true);
		expect(quotaHostMatches("anthropic", "https://api.anthropic.com")).toBe(true);
		expect(quotaHostMatches("zai", "https://api.z.ai/api/coding/paas/v4")).toBe(true);
	});
	test("a proxy baseUrl holds a key for the proxy → don't send it to the vendor", () => {
		expect(quotaHostMatches("anthropic", "https://my-proxy.example.com/v1")).toBe(false);
	});
});

describe("fetchWindows", () => {
	test("anthropic sends the OAuth beta header", async () => {
		const { fetcher, calls } = stubFetch({ body: anthropicSample });
		expect(await fetchWindows("anthropic", "tok", fetcher)).toHaveLength(2);
		expect(calls[0]!.url).toBe("https://api.anthropic.com/api/oauth/usage");
		expect(calls[0]!.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
		expect(calls[0]!.redirect).toBe("error");
	});
	test("codex sends the account id from the token", async () => {
		const { fetcher, calls } = stubFetch({ body: codexSample });
		expect(await fetchWindows("openai-codex", codexToken, fetcher)).toHaveLength(2);
		expect(calls[0]!.headers["ChatGPT-Account-Id"]).toBe("acct-1");
	});
	test("codex token without an account claim → no request", async () => {
		const { fetcher, calls } = stubFetch({ body: codexSample });
		expect(await fetchWindows("openai-codex", "opaque", fetcher)).toBeNull();
		expect(calls).toHaveLength(0);
	});
	test("non-2xx and network errors → null", async () => {
		expect(await fetchWindows("anthropic", "k", stubFetch({ status: 401 }).fetcher)).toBeNull();
		expect(await fetchWindows("anthropic", "k", stubFetch(new Error("offline")).fetcher)).toBeNull();
	});
	test("zai response whose entries are all malformed → null, not an empty success", async () => {
		const bad = { data: { limits: [{ unit: "x", number: 5, percentage: 1 }] } };
		expect(await fetchWindows("zai", "k", stubFetch({ body: bad }).fetcher)).toBeNull();
	});
	test("unknown provider → null", async () => {
		expect(await fetchWindows("openrouter", "k", stubFetch({}).fetcher)).toBeNull();
	});
});

describe("quotaSegment", () => {
	const realNow = Date.now;
	afterEach(() => {
		resetQuotaCache();
		Date.now = realNow;
	});
	/** Resolves once the background refresh has called onUpdate. */
	const settle = () => {
		let done!: () => void;
		const updated = new Promise<void>((r) => (done = r));
		return { onUpdate: () => done(), updated };
	};
	const key = (k: string | undefined) => async () => k;

	test("unsupported provider: null, no fetch, no key lookup", () => {
		const { fetcher, calls } = stubFetch({});
		let asked = false;
		const lookup = async () => {
			asked = true;
			return "k";
		};
		expect(quotaSegment("openrouter", lookup, () => {}, fetcher)).toBeNull();
		expect(quotaSegment(undefined, lookup, () => {}, fetcher)).toBeNull();
		expect(calls).toHaveLength(0);
		expect(asked).toBe(false);
	});

	test("first render null, then the fetched text", async () => {
		const { fetcher } = stubFetch({ body: anthropicSample });
		const s = settle();
		expect(quotaSegment("anthropic", key("k"), s.onUpdate, fetcher)).toBeNull();
		await s.updated;
		expect(strip(quotaSegment("anthropic", key("k"), () => {}, fetcher)!)).toContain("5h 3%");
	});

	test("one fetch per TTL even across many renders", async () => {
		const { fetcher, calls } = stubFetch({ body: anthropicSample });
		const s = settle();
		quotaSegment("anthropic", key("k"), s.onUpdate, fetcher);
		quotaSegment("anthropic", key("k"), () => {}, fetcher);
		await s.updated;
		quotaSegment("anthropic", key("k"), () => {}, fetcher);
		expect(calls).toHaveLength(1);
	});

	test("stale text keeps showing while the TTL refresh is in flight", async () => {
		const { fetcher } = stubFetch({ body: anthropicSample }, { body: { five_hour: { utilization: 9 } } });
		const first = settle();
		quotaSegment("anthropic", key("k"), first.onUpdate, fetcher);
		await first.updated;
		Date.now = () => realNow() + 61_000;
		const second = settle();
		expect(strip(quotaSegment("anthropic", key("k"), second.onUpdate, fetcher)!)).toContain("5h 3%");
		await second.updated;
		expect(strip(quotaSegment("anthropic", key("k"), () => {}, fetcher)!)).toContain("5h 9%");
	});

	test("never shows another provider's text", async () => {
		const { fetcher } = stubFetch({ body: anthropicSample });
		const s = settle();
		quotaSegment("anthropic", key("k"), s.onUpdate, fetcher);
		await s.updated;
		expect(quotaSegment("zai", key("z"), () => {}, stubFetch({ status: 500 }).fetcher)).toBeNull();
	});

	test("a failed fetch is not retried within the TTL", async () => {
		const { fetcher, calls } = stubFetch({ status: 500 });
		const s = settle();
		quotaSegment("anthropic", key("k"), s.onUpdate, fetcher);
		await s.updated;
		expect(quotaSegment("anthropic", key("k"), () => {}, fetcher)).toBeNull();
		expect(calls).toHaveLength(1);
	});

	test("last good text survives failures for a while, then hides", async () => {
		const { fetcher } = stubFetch({ body: anthropicSample }, { status: 500 });
		const first = settle();
		quotaSegment("anthropic", key("k"), first.onUpdate, fetcher);
		await first.updated;
		for (const [offset, shown] of [[61_000, true], [6 * 61_000, false]] as const) {
			Date.now = () => realNow() + offset;
			const s = settle();
			quotaSegment("anthropic", key("k"), s.onUpdate, fetcher);
			await s.updated;
			const out = quotaSegment("anthropic", key("k"), () => {}, fetcher);
			expect(out === null).toBe(!shown);
		}
	});

	test("a late refresh for a provider the user left doesn't evict the current one", async () => {
		let releaseA!: () => void;
		const gate = new Promise<void>((r) => (releaseA = r));
		const slowA: Fetcher = async () => (await gate, new Response(JSON.stringify(anthropicSample)));
		const doneA = settle();
		quotaSegment("anthropic", key("a"), doneA.onUpdate, slowA);
		const b = settle();
		const codex = stubFetch({ body: codexSample });
		quotaSegment("openai-codex", key(codexToken), b.onUpdate, codex.fetcher);
		await b.updated;
		releaseA();
		await new Promise((r) => setTimeout(r, 10));
		expect(strip(quotaSegment("openai-codex", key(codexToken), () => {}, codex.fetcher)!)).toContain("5h 12%");
		expect(codex.calls).toHaveLength(1);
	});

	test("a key lookup that never settles times out instead of wedging refreshes", async () => {
		const { fetcher } = stubFetch({ body: anthropicSample });
		const s = settle();
		quotaSegment("anthropic", () => new Promise<string>(() => {}), s.onUpdate, fetcher);
		await s.updated; // fires after the 5s lookup timeout
		Date.now = () => realNow() + 61_000;
		const t = settle();
		quotaSegment("anthropic", key("k"), t.onUpdate, fetcher);
		await t.updated;
		expect(strip(quotaSegment("anthropic", key("k"), () => {}, fetcher)!)).toContain("5h 3%");
	}, 8000);

	test("a failed refresh keeps the last good text for the same credential", async () => {
		const { fetcher } = stubFetch({ body: anthropicSample }, { status: 500 });
		const first = settle();
		quotaSegment("anthropic", key("k"), first.onUpdate, fetcher);
		await first.updated;
		Date.now = () => realNow() + 61_000;
		const second = settle();
		quotaSegment("anthropic", key("k"), second.onUpdate, fetcher);
		await second.updated;
		expect(strip(quotaSegment("anthropic", key("k"), () => {}, fetcher)!)).toContain("5h 3%");
	});

	test("a different credential drops the old text when its fetch fails", async () => {
		const { fetcher } = stubFetch({ body: anthropicSample }, { status: 401 });
		const first = settle();
		quotaSegment("anthropic", key("account-a"), first.onUpdate, fetcher);
		await first.updated;
		Date.now = () => realNow() + 61_000;
		const second = settle();
		quotaSegment("anthropic", key("account-b"), second.onUpdate, fetcher);
		await second.updated;
		expect(quotaSegment("anthropic", key("account-b"), () => {}, fetcher)).toBeNull();
	});

	test("no key or a throwing lookup hides the segment without fetching", async () => {
		const { fetcher, calls } = stubFetch({ body: anthropicSample });
		const s = settle();
		quotaSegment("anthropic", key(undefined), s.onUpdate, fetcher);
		await s.updated;
		expect(quotaSegment("anthropic", key(undefined), () => {}, fetcher)).toBeNull();

		resetQuotaCache();
		const t = settle();
		const locked = async (): Promise<string> => {
			throw new Error("locked");
		};
		quotaSegment("anthropic", locked, t.onUpdate, fetcher);
		await t.updated;
		expect(quotaSegment("anthropic", key("k"), () => {}, fetcher)).toBeNull();
		expect(calls).toHaveLength(0);
	});
});
