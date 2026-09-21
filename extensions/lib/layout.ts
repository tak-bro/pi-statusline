/**
 * Row packing — the one real branch of this extension. Everything fits on one
 * row, or the footer splits once between identity and metrics: two rows at
 * most, never a wrap, never a dropped segment (tak-cc-statusline's rule).
 */

import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import { SEP, SEP_W } from "./render.ts";

/**
 * `visibleWidth(identity) + SEP_W + visibleWidth(metrics) <= width` → one row,
 * otherwise two rows with identity first. Each returned row is truncated to
 * `width` — truncation is pi's contract for footer lines; a wrap is not.
 */
export const pack = (identity: string, metrics: string, width: number): string[] => {
	if (identity === "" && metrics === "") return [];
	if (identity === "") return [truncateToWidth(metrics, width)];
	if (metrics === "") return [truncateToWidth(identity, width)];

	const single = `${identity}${SEP}${metrics}`;
	// visibleWidth is additive over SGR, so the guard above bounds `single` already
	if (visibleWidth(identity) + SEP_W + visibleWidth(metrics) <= width) {
		return [single];
	}
	return [truncateToWidth(identity, width), truncateToWidth(metrics, width)];
};
