import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Input, Key, matchesKey, wrapTextWithAnsi, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import { panelHeight } from "./panel.ts";
import { fit, spread } from "./style.ts";

export type SecretPromptSpec = {
	title: string;
	message?: string;
	label?: string;
	placeholder?: string;
	validate?: (value: string) => string | undefined | Promise<string | undefined>;
};

type SecretState = { busy: boolean; error?: string };

/** Create the shared docked secret-input screen. The secret is never rendered. */
export function createSecretPrompt(
	spec: SecretPromptSpec,
	tui: TUI,
	theme: Theme,
	done: (value: string | undefined) => void,
): Component & Focusable {
	const input = new Input({ placeholder: spec.placeholder ?? "paste secret" });
	const state: SecretState = { busy: false };
	const submit = async (): Promise<void> => {
		const value = input.getValue().trim();
		if (!value) { state.error = "A value is required."; tui.requestRender(); return; }
		state.busy = true;
		state.error = undefined;
		tui.requestRender();
		try {
			const error = await spec.validate?.(value);
			if (error) { state.error = error; state.busy = false; tui.requestRender(); return; }
			done(value);
		} catch (error) {
			state.error = error instanceof Error ? error.message : String(error);
			state.busy = false;
			tui.requestRender();
		}
	};
	return {
		focused: true,
		invalidate() {},
		render(width: number): string[] {
			const height = panelHeight(tui.terminal.rows);
			const rule = theme.fg("dim", "─".repeat(width));
			const lines = [
				spread(theme.bold(spec.title), theme.fg(state.busy ? "accent" : "dim", state.busy ? "validating…" : "global secret"), width),
				rule,
			];
			if (spec.message) lines.push(...wrapTextWithAnsi(spec.message, Math.max(8, width - 2)).map(line => ` ${line}`), "");
			const value = input.getValue();
			const masked = value ? "•".repeat([...value].length) : theme.fg("dim", spec.placeholder ?? "paste secret");
			lines.push(` ${theme.fg("dim", spec.label ?? "secret")}  ${masked}${CURSOR_MARKER}`);
			if (state.error) lines.push("", ...wrapTextWithAnsi(theme.fg("error", state.error), Math.max(8, width - 2)).map(line => ` ${line}`));
			while (lines.length < height - 2) lines.push("");
			lines.push(rule, fit(theme.fg("dim", state.busy ? "validating… · esc cancel" : "enter validate & save · esc cancel"), width));
			return lines.slice(0, height).map(line => fit(line, width));
		},
		handleInput(data: string): void {
			if (matchesKey(data, Key.escape)) { done(undefined); return; }
			if (state.busy) return;
			if (matchesKey(data, Key.enter)) { void submit(); return; }
			input.handleInput(data);
			state.error = undefined;
			tui.requestRender();
		},
	};
}

/** Open the shared docked secret-input screen. */
export async function openSecretPrompt(
	ctx: Pick<ExtensionCommandContext, "ui" | "hasUI">,
	spec: SecretPromptSpec,
): Promise<string | undefined> {
	if (!ctx.hasUI) return undefined;
	return ctx.ui.custom<string | undefined>((tui, theme, _keys, done) => createSecretPrompt(spec, tui, theme, done));
}
