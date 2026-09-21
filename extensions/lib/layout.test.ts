import { describe, expect, test } from "bun:test";
import { pack } from "./layout.ts";
import { SEP } from "./render.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

const identity = "GLM-5.3 · high | proj • feat/x";
const metrics = "█████░░░░░ 50%";

describe("pack", () => {
	test("exactly-fitting width → exactly 1 row", () => {
		const width = identity.length + 3 + metrics.length;
		expect(pack(identity, metrics, width)).toEqual([identity + SEP + metrics]);
	});

	test("one cell below the threshold → exactly 2 rows, identity first", () => {
		const width = identity.length + 3 + metrics.length - 1;
		const rows = pack(identity, metrics, width);
		expect(rows).toEqual([identity, metrics]);
	});

	test("absent metrics → no dangling SEP", () => {
		expect(pack(identity, "", 80)).toEqual([identity]);
	});

	test("absent identity → metrics only", () => {
		expect(pack("", metrics, 80)).toEqual([metrics]);
	});

	test("absent both → nothing", () => {
		expect(pack("", "", 80)).toEqual([]);
	});

	test("absurdly narrow width (10) truncates, never wraps", () => {
		const rows = pack(identity, metrics, 10);
		for (const row of rows) {
			expect(row).not.toContain("\n");
			expect(visibleWidth(row)).toBeLessThanOrEqual(10);
		}
		// 10 cells cannot hold identity+SEP+metrics → must be 2 rows
		expect(rows.length).toBe(2);
	});
});
