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
import { buildBar, COLOR, DOT, RESET, SEP, bold, join, paint, pickColor } from "./lib/render.ts";
import { pack } from "./lib/layout.ts";

/** Structural slice of pi's ExtensionContext the footer reads at render time. */
export interface FooterCtx {
	cwd: string;
	model?: { id: string; name?: string } | undefined;
	thinkingLevel?: string | undefined;
	getContextUsage?: (() => { percent: number | null } | undefined) | undefined;
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

				return pack(join(parts, SEP), metricsRow(ctx), width);
			},
		};
	};
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return; // footer is terminal-only
		ctx.ui.setFooter((t, theme, footerData) => createFooter(ctx, footerData)(t, theme));
	});
}
