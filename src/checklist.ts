import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Input, Key, matchesKey, wrapTextWithAnsi, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import { panelHeight } from "./panel.ts";
import { SYMBOL, fit, spread } from "./style.ts";

/** One choice: what it is, and an optional short fact on the right. */
export type ChecklistItem = { id: string; label: string; meta?: string };

export type ChecklistSpec = {
	title: string;
	/** One or two lines under the title: what the choice is for. */
	message?: string;
	items: readonly ChecklistItem[];
	/** Ids checked when it opens. */
	initial?: readonly string[];
	/** Fewest choices Enter accepts, counting a written "Other". Defaults to 1. */
	min?: number;
	/** First row checks or clears every item. Defaults to true. */
	all?: boolean;
	/** Last row lets the person write a choice the list does not have. Defaults to true. */
	other?: boolean;
};

/** What was chosen: the checked ids in list order, and the written "Other" when there is one. */
export type ChecklistResult = { ids: string[]; other?: string };

type Row = { kind: "all" } | { kind: "item"; item: ChecklistItem } | { kind: "other" };

/**
 * The shared multi-select. Docked like the panel: it takes the editor's place
 * below the transcript instead of floating over it, and Esc gives it back.
 * Resolves with what was chosen, or undefined when cancelled.
 * Exported for tests; extensions call openChecklist.
 */
export function createChecklist(spec: ChecklistSpec, tui: TUI, theme: Theme, done: (result: ChecklistResult | undefined) => void): Component & Focusable & { handleInput(data: string): void } {
	const checked = new Set(spec.initial ?? []);
	const input = new Input({ placeholder: "write your own" });
	const state = { index: 0, short: false, editing: false };
	const min = spec.min ?? 1;
	const rows: Row[] = [
		...(spec.all === false ? [] : [{ kind: "all" } as const]),
		...spec.items.map(item => ({ kind: "item", item }) as const),
		...(spec.other === false ? [] : [{ kind: "other" } as const]),
	];
	const other = (): string => input.getValue().trim();
	const allOn = (): boolean => spec.items.length > 0 && spec.items.every(item => checked.has(item.id));
	const count = (): number => checked.size + (other() ? 1 : 0);
	const move = (by: number): void => { state.index = Math.max(0, Math.min(rows.length - 1, state.index + by)); };
	const toggleAll = (): void => {
		if (allOn()) checked.clear(); else spec.items.forEach(item => checked.add(item.id));
	};
	const finish = (): void => {
		if (count() < min) { state.short = true; return; }
		done({ ids: spec.items.filter(item => checked.has(item.id)).map(item => item.id), ...(other() ? { other: other() } : {}) });
	};

	/** The row's left side; items put their meta on the right. */
	const left = (row: Row, here: boolean): string => {
		const cursor = here ? theme.fg("accent", SYMBOL.cursor) : " ";
		const box = (on: boolean): string => on ? theme.fg("accent", SYMBOL.active) : theme.fg("dim", SYMBOL.idle);
		const label = (text: string): string => here ? theme.bold(text) : text;
		if (row.kind === "all") return `${cursor} ${box(allOn())} ${label("All")}`;
		if (row.kind === "item") return `${cursor} ${box(checked.has(row.item.id))} ${label(row.item.label)}`;
		if (state.editing) return `${cursor} ${box(true)} ${label("Other:")} ${input.getValue() || theme.fg("dim", "write your own")}${CURSOR_MARKER}`;
		return `${cursor} ${box(Boolean(other()))} ${label(other() ? "Other:" : "Other…")}${other() ? ` ${other()}` : ""}`;
	};

	return {
		focused: true,
		invalidate() {},
		render(width: number): string[] {
			const height = panelHeight(tui.terminal?.rows);
			const rule = theme.fg("dim", "─".repeat(Math.max(0, width)));
			const head = [spread(theme.bold(spec.title), theme.fg("dim", `${count()} selected`), width), rule];
			const wrapped = spec.message ? [...wrapTextWithAnsi(theme.fg("muted", spec.message), Math.max(8, width - 2)).map(text => ` ${text}`), ""] : [];
			// The footer always shows; on a short terminal the message gives way to the rows first.
			const message = height - head.length - wrapped.length - 2 >= 3 ? wrapped : [];
			const room = Math.max(1, height - head.length - message.length - 2);
			const start = Math.max(0, Math.min(state.index - Math.floor(room / 2), rows.length - room));
			const body = rows.slice(start, start + room).map((row, offset) =>
				spread(left(row, start + offset === state.index), row.kind === "item" && row.item.meta ? theme.fg("dim", row.item.meta) : "", width));
			while (body.length < room) body.push("");
			const dot = theme.fg("dim", " · ");
			const keys = state.short ? theme.fg("warning", `Select at least ${min} · esc cancel`)
				: state.editing ? `${theme.fg("accent", "enter")} done${dot}${theme.fg("accent", "esc")} discard`
					: `${theme.fg("accent", "space")} toggle${dot}${theme.fg("accent", "a")} all${dot}${theme.fg("accent", "enter")} continue${dot}${theme.fg("dim", "esc")}`;
			return [...head, ...message, ...body, rule, ` ${keys}`].map(text => fit(text, width));
		},
		handleInput(data: string): void {
			state.short = false;
			if (state.editing) {
				if (matchesKey(data, Key.enter)) state.editing = false;
				else if (matchesKey(data, Key.escape)) { input.setValue(""); state.editing = false; }
				else input.handleInput(data);
				tui.requestRender();
				return;
			}
			if (matchesKey(data, Key.escape) || data === "q") { done(undefined); return; }
			const row = rows[state.index];
			if (matchesKey(data, Key.enter)) finish();
			else if (data === " " && row) {
				if (row.kind === "all") toggleAll();
				else if (row.kind === "item") { if (checked.has(row.item.id)) checked.delete(row.item.id); else checked.add(row.item.id); }
				else if (other()) input.setValue("");
				else state.editing = true;
			}
			else if (data === "a") toggleAll();
			else if (matchesKey(data, Key.up) || data === "k") move(-1);
			else if (matchesKey(data, Key.down) || data === "j") move(1);
			else if (matchesKey(data, Key.home)) state.index = 0;
			else if (matchesKey(data, Key.end)) state.index = rows.length - 1;
			tui.requestRender();
		},
	};
}

/** Open the shared docked multi-select. */
export async function openChecklist(ctx: Pick<ExtensionCommandContext, "ui" | "hasUI">, spec: ChecklistSpec): Promise<ChecklistResult | undefined> {
	if (!ctx.hasUI) return undefined;
	return ctx.ui.custom<ChecklistResult | undefined>((tui, theme, _keys, done) => createChecklist(spec, tui, theme, done));
}
