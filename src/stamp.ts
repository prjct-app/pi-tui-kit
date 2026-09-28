import type { Theme } from "@earendil-works/pi-coding-agent";

/** Who wrote a transcript entry: the person (u) or Pi (p). */
export type Speaker = "u" | "p";

const SPEAKER_COLOR = { u: "accent", p: "toolTitle" } as const;

/** 24-hour local clock: "16:30". */
export function clock(at: number): string {
	const date = new Date(at);
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** "u. 16:18" / "p. 16:30", in the active palette's colors. */
export function stamp(theme: Theme, speaker: Speaker, at: number): string {
	return `${theme.fg(SPEAKER_COLOR[speaker], `${speaker}.`)} ${theme.fg("dim", clock(at))}`;
}
