import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { paint, spread, type Tone } from "./style.ts";

/** One transcript line for a tool call or an extension message. */
export type RowSpec = {
	/** State symbol from SYMBOL. */
	symbol: string;
	tone?: Tone;
	/** Short upper-case action: RUN, READ, MCP, MEM, AGENT, PLAN. Padded to one column. */
	verb: string;
	/** What it acted on. One line; newlines are shown as ↵. */
	target: string;
	/** Right-aligned outcome: "exit 0 · 1.2s", "3 results", "failed". */
	meta?: string;
	metaTone?: Tone;
};

/** Same column as p-ui's built-in tool rows. */
const VERB_WIDTH = 8;

/** The row as a string, the same grammar p-ui uses for built-in tools. */
export function rowLine(theme: Theme, spec: RowSpec, width: number): string {
	const verb = theme.fg("toolTitle", theme.bold(spec.verb.toUpperCase().slice(0, VERB_WIDTH).padEnd(VERB_WIDTH)));
	const target = theme.fg("toolOutput", spec.target.replace(/\r?\n/g, " ↵ "));
	const left = `${paint(theme, spec.tone, spec.symbol)} ${verb}${target}`;
	return spread(left, spec.meta ? paint(theme, spec.metaTone ?? "dim", spec.meta) : "", width);
}

/**
 * A transcript row component. Pi redraws the whole transcript every frame, so
 * the row caches its line per width and only rebuilds when the width changes.
 * Build a new row when the data changes.
 */
export function row(theme: Theme, spec: RowSpec): Component {
	const cache = { width: -1, lines: [] as string[] };
	return {
		render(width: number): string[] {
			if (cache.width !== width) cache.lines = [rowLine(theme, spec, width)];
			cache.width = width;
			return cache.lines;
		},
		invalidate() { cache.width = -1; },
	};
}
