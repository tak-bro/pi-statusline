import { describe, expect, test } from "bun:test";
import { formatCountdown, formatQuota, parseQuota, QuotaData } from "./quota.ts";

const NOW = 1_790_000_000_000;

/** Real-shaped sample: 5h window at 5%, weekly window at 24%. */
const sample = {
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

describe("parseQuota", () => {
	test("unwraps the envelope", () => {
		const data = parseQuota(sample);
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

describe("formatQuota", () => {
	test("renders one segment per limit: window, percent, countdown in parens", () => {
		const text = formatQuota(parseQuota(sample) as QuotaData, NOW);
		expect(text).toContain("5h 5%");
		expect(text).toContain("(1h 30m)");
		expect(text).toContain("7d 24%");
		expect(text).toContain("(48h 0m)");
		expect(text).toContain(" • ");
	});
	test("drops countdown when reset time passed", () => {
		const data = parseQuota(sample) as QuotaData;
		data.limits = [{ ...data.limits[0], nextResetTime: NOW - 1 }];
		const text = formatQuota(data, NOW);
		expect(text).toContain("5h 5%");
		expect(text).not.toContain("(");
	});
});
