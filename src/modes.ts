import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { SYMBOL, spread } from "./style.ts";

/**
 * A mode is anything a person turns on and off (plan, fast, agents). Each
 * extension publishes its own with setMode, and pi-ui draws all of them on one
 * line right above the editor. An extension never draws its own mode line.
 */
export const MODE_PREFIX = "mode:";
/**
 * A fact is a short live figure, not something turned on (what the session
 * cost). It shares the mode line, right-aligned and quiet, so it never adds a
 * line of its own.
 */
export const FACT_PREFIX = "fact:";

type Registry = { modes: Map<string, string>; facts?: Map<string, string>; listeners: Set<() => void>; line?: string };
// Every extension bundles its own copy of this kit; the process-wide symbol is
// the one place they all share.
const KEY = Symbol.for("prjct.pi-tui-kit.modes");
function registry(): Registry {
	const scope = globalThis as unknown as Record<symbol, Registry | undefined>;
	const shared: Registry = (scope[KEY] ??= { modes: new Map(), listeners: new Set() });
	// A registry an older copy of the kit made has no facts yet.
	shared.facts ??= new Map();
	return shared;
}
const factsOf = (shared: Registry): Map<string, string> => (shared.facts ??= new Map());

/**
 * Publish a mode, or clear it with undefined. `label` is short plain text
 * ("plan 2/5", "fast", "agents ● 1"); the symbol is added here and the color
 * when the line is drawn, so every mode looks the same and follows the
 * palette: a color baked in at publish time stayed on the old palette until
 * the extension happened to publish again.
 */
export function setMode(ctx: Pick<ExtensionContext, "ui" | "hasUI">, name: string, label: string | undefined): void {
	if (!ctx.hasUI) return;
	const text = label === undefined ? undefined : `${SYMBOL.mode} ${label}`;
	const shared = registry();
	if (shared.modes.get(name) !== text) {
		if (text === undefined) shared.modes.delete(name);
		else shared.modes.set(name, text);
		for (const listener of shared.listeners) listener();
	}
	// Also a status, so RPC clients and the footer data can still see it.
	ctx.ui.setStatus(`${MODE_PREFIX}${name}`, text);
	showModeLine(ctx);
}

/**
 * Publish a fact, or clear it with undefined. `text` is short plain text
 * ("$0.05 session · $277.74 project"); it is drawn dim at the right of the mode line.
 */
export function setFact(ctx: Pick<ExtensionContext, "ui" | "hasUI">, name: string, text: string | undefined): void {
	if (!ctx.hasUI) return;
	const shared = registry();
	const facts = factsOf(shared);
	if (facts.get(name) !== text) {
		if (text === undefined) facts.delete(name);
		else facts.set(name, text);
		for (const listener of shared.listeners) listener();
	}
	ctx.ui.setStatus(`${FACT_PREFIX}${name}`, text);
	showModeLine(ctx);
}

/**
 * The mode line lives here, in one place: right above the editor, drawn once
 * for the whole process however many extensions publish modes and facts. It
 * takes no space while there is neither.
 */
export const MODE_LINE_WIDGET = "prjct-modes";
function showModeLine(ctx: Pick<ExtensionContext, "ui">): void {
	const shared = registry();
	const facts = factsOf(shared);
	const key = [...shared.modes.keys(), ...[...facts.keys()].map(name => `${FACT_PREFIX}${name}`)].sort().join("|");
	if (shared.line === key) return;
	shared.line = key;
	if (!shared.modes.size && !facts.size) { ctx.ui.setWidget(MODE_LINE_WIDGET, undefined); return; }
	ctx.ui.setWidget(MODE_LINE_WIDGET, (tui, theme) => {
		const stop = onModes(() => tui.requestRender());
		return {
			dispose: stop,
			invalidate() {},
			render(width: number): string[] {
				const line = modeLine(theme, currentModes(), currentFacts(), width);
				return line ? [truncateToWidth(line, width, "")] : [];
			},
		};
	}, { placement: "aboveEditor" });
}

/** The published modes, in a stable order. */
export function currentModes(): string[] {
	return [...registry().modes.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
}

/** The published facts, in a stable order. */
export function currentFacts(): string[] {
	return [...factsOf(registry()).entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
}

/** Called whenever a mode or a fact changes. Returns an unsubscribe. */
export function onModes(listener: () => void): () => void {
	const shared = registry();
	shared.listeners.add(listener);
	return () => { shared.listeners.delete(listener); };
}

/** The published modes read from footer statuses, in a stable order. */
export function readModes(statuses: ReadonlyMap<string, string>): string[] {
	return [...statuses.entries()]
		.filter(([key, value]) => key.startsWith(MODE_PREFIX) && value.length > 0)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, value]) => value);
}

/** Already colored: published by an older copy of this kit that painted at publish time. */
const painted = (text: string): boolean => text.includes("\x1b[");

/**
 * The one mode line: modes joined by a quiet divider on the left, facts dim on
 * the right (the modes give way first), or nothing when there is neither.
 * Colors come from `theme` now, so a palette change repaints every mode.
 */
export function modeLine(theme: Theme, modes: readonly string[], facts: readonly string[] = [], width?: number): string | undefined {
	if (modes.length === 0 && facts.length === 0) return undefined;
	const left = modes.length ? ` ${modes.map((mode) => painted(mode) ? mode : theme.fg("accent", mode)).join(theme.fg("dim", "  ·  "))}` : "";
	if (!facts.length || width === undefined) return left || undefined;
	return spread(left, theme.fg("dim", `${facts.join("  ·  ")} `), width);
}
