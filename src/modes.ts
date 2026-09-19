import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { SYMBOL } from "./style.ts";

/**
 * A mode is anything a person turns on and off (plan, fast, agents). Each
 * extension publishes its own with setMode, and p-ui draws all of them on one
 * line right above the editor. An extension never draws its own mode line.
 */
export const MODE_PREFIX = "mode:";

type Registry = { modes: Map<string, string>; listeners: Set<() => void>; line?: string };
// Every extension bundles its own copy of this kit; the process-wide symbol is
// the one place they all share.
const KEY = Symbol.for("prjct.pi-tui-kit.modes");
function registry(): Registry {
	const scope = globalThis as unknown as Record<symbol, Registry | undefined>;
	return (scope[KEY] ??= { modes: new Map(), listeners: new Set() });
}

/**
 * Publish a mode, or clear it with undefined. `label` is short plain text
 * ("plan 2/5", "fast", "agents ● 1"); the symbol and color are added here so
 * every mode looks the same.
 */
export function setMode(ctx: Pick<ExtensionContext, "ui" | "hasUI">, name: string, label: string | undefined): void {
	if (!ctx.hasUI) return;
	const text = label === undefined ? undefined : ctx.ui.theme.fg("accent", `${SYMBOL.mode} ${label}`);
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
 * The mode line lives here, in one place: right above the editor, drawn once
 * for the whole process however many extensions publish modes. It takes no
 * space while no mode is on.
 */
export const MODE_LINE_WIDGET = "prjct-modes";
function showModeLine(ctx: Pick<ExtensionContext, "ui">): void {
	const shared = registry();
	const key = [...shared.modes.keys()].sort().join("|");
	if (shared.line === key) return;
	shared.line = key;
	if (!shared.modes.size) { ctx.ui.setWidget(MODE_LINE_WIDGET, undefined); return; }
	ctx.ui.setWidget(MODE_LINE_WIDGET, (tui, theme) => {
		const stop = onModes(() => tui.requestRender());
		return {
			dispose: stop,
			invalidate() {},
			render(width: number): string[] {
				const line = modeLine(theme, currentModes());
				return line ? [truncateToWidth(line, width, "")] : [];
			},
		};
	}, { placement: "aboveEditor" });
}

/** The published modes, in a stable order. */
export function currentModes(): string[] {
	return [...registry().modes.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
}

/** Called whenever a mode changes. Returns an unsubscribe. */
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

/** The one mode line: modes joined by a quiet divider, or nothing when none is on. */
export function modeLine(theme: Theme, modes: readonly string[]): string | undefined {
	if (modes.length === 0) return undefined;
	return ` ${modes.join(theme.fg("dim", "  ·  "))}`;
}
