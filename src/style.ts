import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Theme colors every extension may use. Nothing else: no custom palettes, no backgrounds. */
export type Tone = "accent" | "success" | "warning" | "error" | "muted" | "dim" | "text";

/**
 * One vocabulary of state across every extension. Each symbol is always paired
 * with a word, so meaning never depends on color alone.
 */
export const SYMBOL = {
	/** Running, connected, live. */
	active: "●",
	/** Idle, queued, disconnected. */
	idle: "○",
	/** Finished well. */
	ok: "✓",
	/** Failed. */
	error: "✕",
	/** Needs the person. */
	attention: "!",
	/** A mode that is on. */
	mode: "◆",
	/** Selection cursor. */
	cursor: "›",
	/** Column separator. */
	divider: "│",
} as const;

export const paint = (theme: Theme, tone: Tone | undefined, text: string): string =>
	tone ? theme.fg(tone, text) : text;

/** Truncate to a visible width and pad with spaces, ANSI-aware. */
export function fit(text: string, width: number): string {
	if (width <= 0) return "";
	const clipped = truncateToWidth(text, width, "…");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

/** Left text and right text on one line; the left side gives way first. */
export function spread(left: string, right: string, width: number): string {
	const rightWidth = visibleWidth(right);
	if (!right) return fit(left, width);
	if (rightWidth + 2 > width) return fit(left, width);
	const leftText = truncateToWidth(left, width - rightWidth - 2, "…");
	return leftText + " ".repeat(Math.max(2, width - visibleWidth(leftText) - rightWidth)) + right;
}

/** Relative time a person can scan: "now", "42s ago", "5m ago", "3h ago", "2d ago". */
export function ago(timestamp: number | undefined, now = Date.now()): string {
	if (timestamp === undefined || !Number.isFinite(timestamp)) return "—";
	const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
	if (seconds < 5) return "now";
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours}h ago`;
	return `${Math.round(hours / 24)}d ago`;
}
