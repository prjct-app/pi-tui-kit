import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, visibleWidth, wrapTextWithAnsi, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import { panelHeight } from "./panel.ts";
import { SYMBOL, fit, spread } from "./style.ts";

/** One single-line text field. */
export type FormField = {
	id: string;
	label: string;
	/** Shown dimmed while the field is empty. */
	placeholder?: string;
	/** One line under the fields while this one is focused: what it is for, an example. */
	hint?: string;
	/** Starting value. */
	value?: string;
	required?: boolean;
};

export type FormValues = Record<string, string>;

export type FormSpec = {
	title: string;
	/** One or two lines under the title: what the form is for. */
	message?: string;
	fields: readonly FormField[];
	/** Word for the submit key in the footer: "create", "save". */
	submitLabel?: string;
	/** Checked on submit; a message keeps the form open and shows it. */
	validate?: (values: FormValues) => string | undefined | Promise<string | undefined>;
};

/**
 * A docked form: labelled single-line fields, one focused at a time. Enter
 * moves to the next field and submits from the last; tab and the arrows move;
 * esc cancels. Exported for tests; extensions call openForm.
 */
export function createForm(spec: FormSpec, tui: TUI, theme: Theme, done: (values: FormValues | undefined) => void): Component & Focusable & { handleInput(data: string): void } {
	const inputs = spec.fields.map(field => {
		const input = new Input({ prompt: "", placeholder: field.placeholder ?? "", placeholderStyle: text => theme.fg("dim", text) });
		if (field.value) input.setValue(field.value);
		return input;
	});
	const state = { index: 0, busy: false, error: undefined as string | undefined };
	const labelWidth = Math.max(...spec.fields.map(field => visibleWidth(field.label))) + 2;
	const values = (): FormValues => Object.fromEntries(spec.fields.map((field, i) => [field.id, inputs[i]!.getValue().trim()]));
	const focus = (index: number): void => {
		state.index = (index + inputs.length) % inputs.length;
		inputs.forEach((input, i) => { input.focused = i === state.index; });
		tui.requestRender();
	};
	focus(0);

	const submit = async (): Promise<void> => {
		const missing = spec.fields.findIndex((field, i) => field.required && !inputs[i]!.getValue().trim());
		if (missing >= 0) { state.error = `${spec.fields[missing]!.label} is required.`; focus(missing); return; }
		state.busy = true;
		state.error = undefined;
		tui.requestRender();
		try {
			const error = await spec.validate?.(values());
			if (error) { state.error = error; state.busy = false; tui.requestRender(); return; }
			done(values());
		} catch (error) {
			state.error = error instanceof Error ? error.message : String(error);
			state.busy = false;
			tui.requestRender();
		}
	};

	return {
		focused: true,
		invalidate() { inputs.forEach(input => input.invalidate()); },
		render(width: number): string[] {
			const height = panelHeight(tui.terminal.rows);
			const rule = theme.fg("dim", "─".repeat(width));
			const lines = [spread(theme.bold(spec.title), theme.fg(state.busy ? "accent" : "dim", state.busy ? "checking…" : `${state.index + 1}/${inputs.length}`), width), rule];
			if (spec.message) lines.push(...wrapTextWithAnsi(spec.message, Math.max(8, width - 2)).map(line => ` ${line}`), "");
			spec.fields.forEach((field, i) => {
				const active = i === state.index;
				const marker = active ? theme.fg("accent", SYMBOL.cursor) : " ";
				const label = theme.fg(active ? "accent" : "dim", `${field.label}${field.required ? "" : "?"}`.padEnd(labelWidth));
				// Only the focused field draws a cursor; the others show their value or placeholder.
				const value = inputs[i]!.getValue();
				const field_ = active ? inputs[i]!.render(Math.max(8, width - labelWidth - 3))[0] ?? "" : value || theme.fg("dim", field.placeholder ?? "");
				lines.push(`${marker} ${label}${field_}`);
			});
			const hint = spec.fields[state.index]?.hint;
			if (hint) lines.push("", ...wrapTextWithAnsi(theme.fg("dim", hint), Math.max(8, width - 2)).map(line => ` ${line}`));
			if (state.error) lines.push("", ...wrapTextWithAnsi(theme.fg("error", state.error), Math.max(8, width - 2)).map(line => ` ${line}`));
			while (lines.length < height - 2) lines.push("");
			const last = state.index === inputs.length - 1;
			const keys = state.busy ? "checking… · esc cancel" : `enter ${last ? spec.submitLabel ?? "submit" : "next"} · tab/↑↓ move · esc cancel`;
			lines.push(rule, fit(theme.fg("dim", keys), width));
			return lines.slice(0, height).map(line => fit(line, width));
		},
		handleInput(data: string): void {
			if (matchesKey(data, Key.escape)) { done(undefined); return; }
			if (state.busy) return;
			if (matchesKey(data, Key.enter)) {
				if (state.index === inputs.length - 1) void submit();
				else focus(state.index + 1);
				return;
			}
			if (matchesKey(data, Key.tab) || matchesKey(data, Key.down)) { focus(state.index + 1); return; }
			if (matchesKey(data, Key.shift(Key.tab)) || matchesKey(data, Key.up)) { focus(state.index - 1); return; }
			inputs[state.index]!.handleInput(data);
			state.error = undefined;
			tui.requestRender();
		},
	};
}

/** Open a docked form. Resolves with the trimmed values, or undefined when cancelled. */
export async function openForm(ctx: Pick<ExtensionCommandContext, "ui" | "hasUI">, spec: FormSpec): Promise<FormValues | undefined> {
	if (!ctx.hasUI) return undefined;
	return ctx.ui.custom<FormValues | undefined>((tui, theme, _keys, done) => createForm(spec, tui, theme, done));
}
