/**
 * Pure rendering helpers — palette, context bar, row packing.
 *
 * Colors mirror tak-cc-statusline's statusline.sh so the two harnesses look
 * identical side by side. pi's Theme has a fixed named palette (accent/dim/...)
 * with no arbitrary hex, so these are emitted as raw truecolor SGR; on a
 * 256-color terminal pi's theme mode reports "256color" and the caller falls
 * back to theme.fg().
 */

export const BAR_WIDTH = 10; // cells in the context bar
export const SEP_W = 3; // visible width of " | " and " • "

export const RESET = "\x1b[0m";

export const SEP = `\x1b[90m | ${RESET}`;
export const DOT = `\x1b[90m • ${RESET}`;

/** Foreground truecolor escape. */
const rgb = (r: number, g: number, b: number) => `\x1b[38;2;${r};${g};${b}m`;

export const COLOR = {
	model: "\x1b[38;5;208m", // orange (256-color, same in both modes)
	dir: rgb(76, 208, 222), // cyan
	branch: rgb(192, 103, 222), // purple
	barEmpty: rgb(80, 85, 95),
	usage: rgb(156, 162, 175),
} as const;

export const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
export const paint = (color: string, s: string) => `${color}${s}${RESET}`;

/** Usage color ramp: green < 50 ≤ yellow < 75 ≤ rose < 90 ≤ red. */
export const pickColor = (pct: number): string => {
	if (pct >= 90) return rgb(225, 85, 100);
	if (pct >= 75) return rgb(225, 130, 160);
	if (pct >= 50) return rgb(230, 195, 110);
	return rgb(130, 215, 145);
};

/**
 * Progress bar. `pct` is clamped to 0..100; a non-zero percentage always shows
 * at least one filled cell so the bar visibly reacts on the first turn.
 */
export const buildBar = (pct: number, width = BAR_WIDTH, color = pickColor(pct)): string => {
	const p = Math.min(100, Math.max(0, pct));
	let filled = Math.round((p * width) / 100);
	if (p > 0 && filled === 0) filled = 1;
	if (filled > width) filled = width;
	return `${color}${"█".repeat(filled)}${RESET}${COLOR.barEmpty}${"░".repeat(width - filled)}${RESET}`;
};

/** Compact token count: 913 → "913", 1234 → "1.2k", 45_000_000 → "45.0M". */
export const fmtTokens = (n: number): string => {
	if (n < 1000) return `${n}`;
	if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
};

/**
 * Session cost. Two decimals read as `$0.00` on cheap providers — a 15k-token turn on
 * glm-5.3-flash bills a fraction of a cent — so widen the precision until the figure is
 * non-zero, up to four places. Below that the amount is not worth a segment: return "".
 */
export const fmtCost = (cost: number): string => {
	if (!(cost > 0)) return "";
	for (const places of [2, 3, 4]) {
		const text = cost.toFixed(places);
		if (Number(text) > 0) return `$${text}`;
	}
	return "";
};

/** Join non-empty parts with `sep`, ignoring the blanks. */
export const join = (parts: string[], sep: string): string => parts.filter((p) => p !== "").join(sep);
