import { describe, expect, test } from "bun:test";
import { COLOR, RESET, buildBar, pickColor } from "./render.ts";

describe("pickColor", () => {
	test("boundaries flip at 50 / 75 / 90", () => {
		expect(pickColor(49)).toBe("\x1b[38;2;130;215;145m"); // green
		expect(pickColor(50)).toBe("\x1b[38;2;230;195;110m"); // yellow
		expect(pickColor(74)).toBe("\x1b[38;2;230;195;110m"); // yellow
		expect(pickColor(75)).toBe("\x1b[38;2;225;130;160m"); // rose
		expect(pickColor(89)).toBe("\x1b[38;2;225;130;160m"); // rose
		expect(pickColor(90)).toBe("\x1b[38;2;225;85;100m"); // red
	});
});

describe("buildBar", () => {
	const bar = (filled: number, color: string) =>
		`${color}${"█".repeat(filled)}${RESET}${COLOR.barEmpty}${"░".repeat(10 - filled)}${RESET}`;

	test("clamps below 0 and above 100", () => {
		expect(buildBar(-5)).toBe(bar(0, pickColor(0)));
		expect(buildBar(150)).toBe(bar(10, pickColor(100)));
	});

	test("pct > 0 always fills at least one cell", () => {
		expect(buildBar(1)).toBe(bar(1, pickColor(1)));
		expect(buildBar(4)).toBe(bar(1, pickColor(4))); // 0.4 cells → rounds to 0 → min 1
	});

	test("50% fills exactly half the 10-cell bar", () => {
		expect(buildBar(50)).toBe(bar(5, pickColor(50)));
	});

	test("0% fills nothing", () => {
		expect(buildBar(0)).toBe(bar(0, pickColor(0)));
	});
});
