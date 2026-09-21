/**
 * tak-cc-statusline look for pi. Registers a custom footer that replaces pi's
 * built-in one; the identity row — model · effort | dir • branch — uses the
 * tak-cc palette from ./lib/render.ts (raw SGR, byte-identical to statusline.sh).
 *
 * Why the parked TUI: the setFooter factory receives the TUI, but event
 * handlers only get (event, ctx) and ctx has no tui. So the factory parks tui
 * in this module-scope variable and handlers call tui?.requestRender().
 * dispose() clears the variable and unsubscribes, so a turn_end arriving after
 * teardown never renders into a dead TUI.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import { buildBar, COLOR, DOT, RESET, SEP, bold, fmtTokens, join, paint, pickColor } from "./lib/render.ts";
import { pack } from "./lib/layout.ts";

/** Structural slice of pi's ExtensionContext the footer reads at render time. */
export interface FooterCtx {
	cwd: string;
	model?: { id: string; name?: string } | undefined;
	thinkingLevel?: string | undefined;
	getContextUsage?: (() => { percent: number | null } | undefined) | undefined;
	sessionManager?: { getBranch(): unknown[] } | undefined;
}

interface FooterData {
	getGitBranch(): string | null;
	onBranchChange(cb: () => void): () => void;
}

/** Parked TUI — set by the footer factory, cleared in dispose. */
let tui: { requestRender(): void } | null = null;

/** Any handler wanting a repaint goes through here, never a captured TUI. */
export function requestFooterRender(): void {
	tui?.requestRender();
}

/** "GLM-5.3 (preview)" + effort → "GLM-5.3 · high"; strips parens like statusline.sh. */
export function identityLabel(model: string, effort: string | null | undefined): string {
	let label = model.replace(/\s*\([^)]*\)/g, "");
	if (effort && effort !== "off") label += ` · ${effort}`;
	return label;
}

/** Context segment: colored bar + percent; percent null (right after compact) → empty bar, still drawn. */
function metricsRow(ctx: FooterCtx): string {
	const percent = ctx.getContextUsage?.()?.percent ?? null;
	const bar = buildBar(percent ?? 0);
	if (percent === null) return bar;
	const shown = Math.round(percent);
	return `${bar} ${paint(pickColor(shown), `${shown}%`)}`;
}

// --- session usage (Decision D5: accumulate on turn_end, render() only reads the cache) ---

/** Structural slice of a session-branch entry the accumulator understands. */
export interface BranchEntry {
	type: string;
	message?: { role: string; usage?: { input: number; output: number; cost?: { total: number } } } | undefined;
}

export interface UsageTotals {
	input: number;
	output: number;
	cost: number;
	entriesSeen: number;
}

const emptyUsage = (): UsageTotals => ({ input: 0, output: 0, cost: 0, entriesSeen: 0 });
let usage: UsageTotals = emptyUsage();

/** Reset the running totals — session_start and branch-shrink recovery. */
export function resetUsage(): void {
	usage = emptyUsage();
}

/** Sum assistant-message usage from `entries[fromIndex:]` — pure, exported for tests. */
export function sumUsage(entries: readonly BranchEntry[], fromIndex = 0): { input: number; output: number; cost: number } {
	let input = 0;
	let output = 0;
	let cost = 0;
	for (let i = fromIndex; i < entries.length; i++) {
		const e = entries[i]!;
		if (e.type !== "message" || e.message?.role !== "assistant") continue;
		const u = e.message.usage;
		if (!u) continue;
		input += u.input;
		output += u.output;
		cost += u.cost?.total ?? 0;
	}
	return { input, output, cost };
}

/** Fold the branch's new tail into the cache; a shrunk branch recomputes from zero. */
export function recordUsage(entries: readonly BranchEntry[]): void {
	if (entries.length < usage.entriesSeen) resetUsage();
	const delta = sumUsage(entries, usage.entriesSeen);
	usage = {
		input: usage.input + delta.input,
		output: usage.output + delta.output,
		cost: usage.cost + delta.cost,
		entriesSeen: entries.length,
	};
}

/** Session segment: "1.2k · $0.50"; cost-0 providers show tokens only; nothing before the first reply. */
function sessionSegment(): string {
	const tokens = usage.input + usage.output;
	if (tokens <= 0) return "";
	const cost = usage.cost > 0 ? ` · $${usage.cost.toFixed(2)}` : "";
	return paint(COLOR.usage, `${fmtTokens(tokens)}${cost}`);
}

/** tak-cc footer: identity row (model·effort | dir•branch) + metrics (context bar). */
export function createFooter(ctx: FooterCtx, footerData: FooterData) {
	return (t: { requestRender(): void }, _theme: unknown) => {
		tui = t;
		const unsubBranch = footerData.onBranchChange(requestFooterRender);

		return {
			invalidate() {},
			dispose() {
				unsubBranch();
				tui = null;
			},
			render(width: number): string[] {
				const parts: string[] = [];

				const model = ctx.model?.name ?? ctx.model?.id;
				if (model) {
					// statusline.sh prints color, then bold: \e[38;5;208m\e[1m…\e[22m\e[0m
					parts.push(paint(COLOR.model, bold(identityLabel(model, ctx.thinkingLevel))));
				}

				const dir = basename(ctx.cwd);
				const branch = footerData.getGitBranch();
				if (dir) {
					// statusline.sh bolds before coloring: \e[1m\e[38;2;…m…\e[22m\e[0m
					let group = bold(COLOR.dir + dir) + RESET;
					if (branch) group += DOT + bold(COLOR.branch + branch) + RESET;
					parts.push(group);
				}

				return pack(join(parts, SEP), join([metricsRow(ctx), sessionSegment()], SEP), width);
			},
		};
	};
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		resetUsage();
		recordUsage((ctx.sessionManager?.getBranch() ?? []) as BranchEntry[]);
		if (ctx.mode !== "tui") return; // footer is terminal-only
		ctx.ui.setFooter((t, theme, footerData) => createFooter(ctx, footerData)(t, theme));
	});

	pi.on("turn_end", (_event, ctx) => {
		recordUsage((ctx.sessionManager?.getBranch() ?? []) as BranchEntry[]);
		requestFooterRender();
	});

	pi.on("model_select", () => {
		requestFooterRender();
	});
}
