import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { SYMBOL } from "./style.ts";

/**
 * A mode is anything a person turns on and off (plan, fast, agents). Each
 * extension publishes its own through setStatus under this prefix, and p-ui
 * draws all of them together on one line below the editor. An extension never
 * draws its own mode line.
 */
export const MODE_PREFIX = "mode:";

/**
 * Publish a mode, or clear it with undefined. `label` is short plain text
 * ("plan 2/5", "fast", "agents ● 1"); the symbol and color are added here so
 * every mode looks the same.
 */
export function setMode(ctx: Pick<ExtensionContext, "ui" | "hasUI">, name: string, label: string | undefined): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(`${MODE_PREFIX}${name}`, label === undefined ? undefined : ctx.ui.theme.fg("accent", `${SYMBOL.mode} ${label}`));
}

/** The published modes in a stable order, for the line that draws them. */
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
