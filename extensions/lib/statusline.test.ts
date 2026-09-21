import { describe, expect, test } from "bun:test";
import { createFooter, identityLabel, recordUsage, resetUsage, sumUsage } from "../statusline.ts";
import { COLOR, SEP, buildBar, pickColor, RESET } from "./render.ts";
import { beforeEach, describe, expect, test } from "bun:test";

beforeEach(() => resetUsage());

/** Minimal host stand-ins — the factory only touches these shapes. */
function makeCtx(overrides: Partial<{ model: { id: string; name?: string }; thinkingLevel?: string }> = {}) {
	return { cwd: "/tmp/proj", ...overrides };
}

function makeFooterData(branch: string | null) {
	const listeners: Array<() => void> = [];
	return {
		getGitBranch: () => branch,
		onBranchChange: (cb: () => void) => {
			listeners.push(cb);
			return () => {
				const i = listeners.indexOf(cb);
				if (i >= 0) listeners.splice(i, 1);
			};
		},
		notify: () => listeners.forEach((l) => l()),
		subscribed: () => listeners.length,
	};
}

function makeTui() {
	return { renders: 0, requestRender() { this.renders++; } };
}

describe("identityLabel", () => {
	test("appends effort after the model name", () => {
		expect(identityLabel("GLM-5.3", "high")).toBe("GLM-5.3 · high");
	});

	test("strips parenthesized suffixes like statusline.sh's sed", () => {
		expect(identityLabel("Opus 4.5 (preview)", "medium")).toBe("Opus 4.5 · medium");
	});

	test("no effort, or effort off, leaves the bare name", () => {
		expect(identityLabel("GLM-5.3", undefined)).toBe("GLM-5.3");
		expect(identityLabel("GLM-5.3", "off")).toBe("GLM-5.3");
	});
});

describe("sumUsage — incremental assistant-message totals", () => {
	const A = { type: "message", message: { role: "assistant", usage: { input: 100, output: 20, cost: { total: 0.5 } } } };
	const U = { type: "message", message: { role: "user" } };

	test("sums assistant usage only", () => {
		expect(sumUsage([U, A, U, A])).toEqual({ input: 200, output: 40, cost: 1 });
	});

	test("fromIndex skips already-counted entries", () => {
		expect(sumUsage([A, A, A], 2)).toEqual({ input: 100, output: 20, cost: 0.5 });
	});

	test("assistant message without usage is skipped", () => {
		expect(sumUsage([{ type: "message", message: { role: "assistant" } }])).toEqual({ input: 0, output: 0, cost: 0 });
	});
});

describe("createFooter dispose wiring", () => {
	test("dispose clears the parked TUI — later renders are no-ops, not crashes", () => {
		const tui = makeTui();
		const data = makeFooterData("main");
		const component = createFooter(makeCtx({ model: { id: "m" } }), data as never)(tui, {});
		component.dispose();
		// a turn_end after dispose would call requestRender on the parked (dead) TUI
		expect(() => component.invalidate()).not.toThrow();
	});

	test("branch change requests a render; after dispose the unsubscribe ran", () => {
		const tui = makeTui();
		const data = makeFooterData("main");
		const component = createFooter(makeCtx({ model: { id: "m" } }), data as never)(tui, {});
		expect(data.subscribed()).toBe(1);
		data.notify();
		expect(tui.renders).toBe(1);
		component.dispose();
		data.notify();
		expect(tui.renders).toBe(1); // unsubscribed — no render into the dying TUI
	});
});

describe("createFooter metrics — context bar", () => {
	test("percent 42 → bar + colored '42%'", () => {
		const tui = makeTui();
		const data = makeFooterData(null);
		const ctx = makeCtx({ model: { id: "m" }, getContextUsage: () => ({ percent: 42 }) });
		const component = createFooter(ctx, data as never)(tui, {});
		const [row] = component.render(200);
		expect(row.endsWith(`${pickColor(42)}42%${RESET}`)).toBe(true);
		expect(row).toContain("█".repeat(4));
	});

	test("percent null (right after compact) → empty bar drawn, no percent text", () => {
		const tui = makeTui();
		const data = makeFooterData(null);
		const ctx = makeCtx({ model: { id: "m" }, getContextUsage: () => ({ percent: null }) });
		const component = createFooter(ctx, data as never)(tui, {});
		const [row] = component.render(200);
		expect(row).toContain("░".repeat(10));
		expect(row).not.toContain("%\x1b[0m");
		expect(row.endsWith("%")).toBe(false);
	});
});

describe("createFooter usage segment — session tokens·cost", () => {
	const A = { type: "message", message: { role: "assistant", usage: { input: 100, output: 20, cost: { total: 0.5 } } } };

	test("accumulated usage → '120 · $0.50' painted usage color after the bar", () => {
		const tui = makeTui();
		const data = makeFooterData(null);
		recordUsage([A, A]);
		const ctx = makeCtx({ model: { id: "m" } });
		const component = createFooter(ctx, data as never)(tui, {});
		const [row] = component.render(200);
		expect(row.endsWith(`${COLOR.usage}240 · $1.00${RESET}`)).toBe(true);
	});

	test("cost total 0 → tokens only, no '$' (provider-0-cost fallback)", () => {
		const tui = makeTui();
		const data = makeFooterData(null);
		recordUsage([{ type: "message", message: { role: "assistant", usage: { input: 100, output: 20, cost: { total: 0 } } } }]);
		const ctx = makeCtx({ model: { id: "m" } });
		const component = createFooter(ctx, data as never)(tui, {});
		const [row] = component.render(200);
		expect(row.endsWith(`${COLOR.usage}120${RESET}`)).toBe(true);
		expect(row.includes("$")).toBe(false);
	});

	test("no usage yet → row ends with the bar, no dangling SEP", () => {
		const tui = makeTui();
		const data = makeFooterData(null);
		const ctx = makeCtx({ model: { id: "m" } });
		const component = createFooter(ctx, data as never)(tui, {});
		const [row] = component.render(200);
		expect(row.endsWith(buildBar(0))).toBe(true);
	});

	test("branch shrink (tree navigation) recomputes from scratch", () => {
		recordUsage([A, A, A]);
		recordUsage([A]); // shorter than entriesSeen → reset then re-sum
		const tui = makeTui();
		const ctx = makeCtx({ model: { id: "m" } });
		const component = createFooter(ctx, makeFooterData(null) as never)(tui, {});
		const [row] = component.render(200);
		expect(row.endsWith(`${COLOR.usage}120 · $0.50${RESET}`)).toBe(true);
	});
});

describe("createFooter render — tak-cc SGR bytes", () => {
	test("identity row: model(orange,bold) SEP dir(cyan,bold) DOT branch(purple,bold)", () => {
		const tui = makeTui();
		const data = makeFooterData("feat/x");
		const component = createFooter(makeCtx({ model: { id: "glm-5.3", name: "GLM-5.3" }, thinkingLevel: "high" }), data as never)(tui, {});
		const [row] = component.render(120);
		// slice 02: the context segment is always drawn — no usage data → empty bar
		expect(row).toBe(
			"\x1b[38;5;208m\x1b[1mGLM-5.3 · high\x1b[22m\x1b[0m" +
				SEP +
				"\x1b[1m\x1b[38;2;76;208;222mproj\x1b[22m\x1b[0m" +
				"\x1b[90m • \x1b[0m" +
				"\x1b[1m\x1b[38;2;192;103;222mfeat/x\x1b[22m\x1b[0m" +
				SEP +
				buildBar(0),
		);
	});

	test("no branch → no DOT tail; no effort → bare model", () => {
		const tui = makeTui();
		const data = makeFooterData(null);
		const component = createFooter(makeCtx({ model: { id: "glm-5.3", name: "GLM-5.3" } }), data as never)(tui, {});
		const [row] = component.render(120);
		expect(row).toBe(
			"\x1b[38;5;208m\x1b[1mGLM-5.3\x1b[22m\x1b[0m" +
				SEP +
				"\x1b[1m\x1b[38;2;76;208;222mproj\x1b[22m\x1b[0m" +
				SEP +
				buildBar(0),
		);
	});
});
