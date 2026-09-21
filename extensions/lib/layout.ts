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
export function pack(identity: string, metrics: string, width: number): string[] {
	if (identity === "" && metrics === "") return [];
	if (identity === "") return [truncateToWidth(metrics, width)];
	if (metrics === "") return [truncateToWidth(identity, width)];

	const single = `${identity}${SEP}${metrics}`;
	if (visibleWidth(identity) + SEP_W + visibleWidth(metrics) <= width) {
		return [truncateToWidth(single, width)];
	}
	return [truncateToWidth(identity, width), truncateToWidth(metrics, width)];
}
