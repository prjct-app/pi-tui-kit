import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, visibleWidth, wrapTextWithAnsi, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import { SYMBOL, fit, paint, spread, type Tone } from "./style.ts";

/** One row in the list: what it is, its state, and one short fact. */
export type PanelItem = {
	id: string;
	label: string;
	/** State symbol from SYMBOL; paired with a word in `meta` or the detail. */
	symbol?: string;
	tone?: Tone;
	/** Short right-aligned fact: "oauth ✓", "2m ago", "3 tools". */
	meta?: string;
	/** Extra text the search matches besides label and meta. */
	search?: string;
};

/** A labelled value in the detail pane. */
export type PanelField = { label: string; value: string; tone?: Tone };

/** Everything known about one item: facts first, then traceability. */
export type PanelDetail = {
	title: string;
	subtitle?: string;
	subtitleTone?: Tone;
	fields?: PanelField[];
	/** Titled blocks: history, log, output, related ids. Newest first. */
	sections?: { title: string; lines: string[] }[];
};

/** What an action can do to the open panel. */
export type PanelControl = {
	/** Redraw with fresh items and detail. */
	refresh(): void;
	/** One line under the list: the result of what just happened. */
	notice(text: string, tone?: Tone): void;
	/** Move the cursor to an item. */
	select(id: string): void;
	/** Close the panel and return to the editor. */
	close(): void;
};

/** A one-key action on the selected item (or on the panel when nothing is selected). */
export type PanelAction = {
	/** A single printable character, shown in the footer. */
	key: string;
	/** Fixed, or worded for the item ("Authenticate" / "Re-authenticate"). */
	label: string | ((item: PanelItem | undefined) => string);
	/** Shown and allowed only when this returns true. */
	when?: (item: PanelItem | undefined) => boolean;
	/** Destructive actions ask for the key again before running. */
	confirm?: boolean;
	run: (item: PanelItem | undefined, panel: PanelControl) => void | Promise<void>;
};

export type PanelSpec = {
	title: string;
	/** Counts next to the title: "8 servers · 3 signed in". */
	summary?: () => string;
	items: () => PanelItem[];
	detail: (item: PanelItem) => PanelDetail;
	actions?: PanelAction[];
	/** Shown when there are no items; say what to do next. */
	empty?: string;
	/** Live data: call the listener when something changed. Returns an unsubscribe. */
	subscribe?: (changed: () => void) => () => void;
	/** Redraw on a timer, for ages and durations. */
	refreshMs?: number;
	/** Item selected when the panel opens. */
	initial?: string;
};

type State = {
	selected?: string;
	focus: "list" | "detail";
	query: string;
	searching: boolean;
	help: boolean;
	notice?: { text: string; tone: Tone };
	confirm?: string;
	scroll: number;
	busy: boolean;
	closed: boolean;
};

const WIDE = 90;
const labelOf = (action: PanelAction, item: PanelItem | undefined): string =>
	typeof action.label === "function" ? action.label(item) : action.label;
const RESERVED = new Set(["/", "?", "q", "j", "k"]);

/** Panel height: most of a small terminal, bounded on a large one. */
export function panelHeight(rows: number | undefined): number {
	const total = rows && rows > 0 ? rows : 24;
	return Math.max(8, Math.min(24, Math.floor(total * 0.6)));
}

function matches(item: PanelItem, query: string): boolean {
	if (!query) return true;
	const haystack = `${item.label} ${item.meta ?? ""} ${item.search ?? ""}`.toLowerCase();
	return query.toLowerCase().split(/\s+/).filter(Boolean).every(word => haystack.includes(word));
}

function detailLines(theme: Theme, detail: PanelDetail, width: number): string[] {
	const lines: string[] = [theme.bold(detail.title)];
	if (detail.subtitle) lines.push(paint(theme, detail.subtitleTone ?? "muted", detail.subtitle));
	const fields = detail.fields ?? [];
	if (fields.length) {
		lines.push("");
		const labelWidth = Math.min(14, Math.max(...fields.map(field => visibleWidth(field.label))));
		for (const field of fields) {
			const label = theme.fg("dim", fit(field.label, labelWidth));
			const room = Math.max(8, width - labelWidth - 2);
			const wrapped = wrapTextWithAnsi(paint(theme, field.tone, field.value || "—"), room);
			wrapped.forEach((line, index) => lines.push(`${index === 0 ? label : " ".repeat(labelWidth)}  ${line}`));
		}
	}
	for (const section of detail.sections ?? []) {
		lines.push("", theme.fg("accent", section.title));
		if (!section.lines.length) lines.push(theme.fg("dim", "—"));
		for (const line of section.lines) lines.push(...wrapTextWithAnsi(line, Math.max(8, width)));
	}
	return lines;
}

/**
 * The shared panel. It is docked: it takes the editor's place below the
 * transcript instead of floating over it, and Esc gives the editor back.
 * Exported for tests; extensions call openPanel.
 */
export function createPanel(spec: PanelSpec, tui: TUI, theme: Theme, done: () => void): Component & Focusable & { dispose(): void } {
	const state: State = { focus: "list", query: "", searching: false, help: false, scroll: 0, busy: false, closed: false, selected: spec.initial };
	const request = (): void => { if (!state.closed) tui.requestRender(); };
	const close = (): void => { if (state.closed) return; state.closed = true; dispose(); done(); };
	const unsubscribe = spec.subscribe?.(request);
	const timer = spec.refreshMs ? setInterval(request, spec.refreshMs) : undefined;
	timer?.unref?.();
	const dispose = (): void => { unsubscribe?.(); if (timer) clearInterval(timer); };

	const visible = (): PanelItem[] => spec.items().filter(item => matches(item, state.query));
	const current = (items = visible()): PanelItem | undefined =>
		items.find(item => item.id === state.selected) ?? items[0];
	const available = (item: PanelItem | undefined): PanelAction[] =>
		(spec.actions ?? []).filter(action => !action.when || action.when(item));

	const control: PanelControl = {
		refresh: request,
		notice(text, tone = "muted") { state.notice = { text, tone }; request(); },
		select(id) { state.selected = id; state.scroll = 0; request(); },
		close,
	};

	const run = async (action: PanelAction, item: PanelItem | undefined): Promise<void> => {
		const label = labelOf(action, item);
		state.confirm = undefined;
		state.busy = true;
		state.notice = { text: `${label}…`, tone: "dim" };
		request();
		try {
			await action.run(item, control);
			if (state.notice?.text === `${label}…`) state.notice = undefined;
		} catch (error) {
			state.notice = { text: `${label} failed: ${error instanceof Error ? error.message : String(error)}`, tone: "error" };
		} finally {
			state.busy = false;
			request();
		}
	};

	const move = (items: PanelItem[], delta: number): void => {
		if (!items.length) return;
		const index = Math.max(0, items.findIndex(item => item.id === current(items)?.id));
		const next = Math.max(0, Math.min(items.length - 1, index + delta));
		state.selected = items[next]!.id;
		state.scroll = 0;
	};

	const handleInput = (data: string): void => {
		if (state.closed) return;
		if (state.help) { state.help = false; request(); return; }
		if (state.searching) {
			if (matchesKey(data, Key.escape)) { state.searching = false; state.query = ""; }
			else if (matchesKey(data, Key.enter)) state.searching = false;
			else if (matchesKey(data, Key.backspace)) state.query = state.query.slice(0, -1);
			else if (data.length === 1 && data >= " ") state.query = (state.query + data).slice(0, 80);
			state.selected = current()?.id;
			request();
			return;
		}
		const items = visible();
		const item = current(items);
		const wide = (tui.terminal?.columns ?? 120) >= WIDE;
		if (state.confirm && data !== state.confirm) { state.confirm = undefined; state.notice = undefined; }

		if (matchesKey(data, Key.escape)) {
			if (state.focus === "detail") { state.focus = "list"; state.scroll = 0; }
			else if (state.query) state.query = "";
			else { close(); return; }
		} else if (data === "q") { close(); return; }
		else if (data === "/") { state.searching = true; state.focus = "list"; }
		else if (data === "?") state.help = true;
		else if (matchesKey(data, Key.tab)) state.focus = state.focus === "list" ? "detail" : "list";
		else if (matchesKey(data, Key.enter) || (matchesKey(data, Key.right) && state.focus === "list")) { if (item) state.focus = "detail"; }
		else if (matchesKey(data, Key.left) && state.focus === "detail" && !wide) state.focus = "list";
		else if (matchesKey(data, Key.pageDown)) state.scroll += 10;
		else if (matchesKey(data, Key.pageUp)) state.scroll = Math.max(0, state.scroll - 10);
		else if (matchesKey(data, Key.up) || data === "k") {
			if (state.focus === "detail") state.scroll = Math.max(0, state.scroll - 1); else move(items, -1);
		} else if (matchesKey(data, Key.down) || data === "j") {
			if (state.focus === "detail") state.scroll += 1; else move(items, 1);
		} else if (matchesKey(data, Key.home)) { if (state.focus === "detail") state.scroll = 0; else if (items[0]) state.selected = items[0].id; }
		else if (matchesKey(data, Key.end)) { if (state.focus !== "detail" && items.length) state.selected = items.at(-1)!.id; }
		else if (!state.busy) {
			const action = available(item).find(candidate => candidate.key === data);
			if (action) {
				if (action.confirm && state.confirm !== data) {
					state.confirm = data;
					state.notice = { text: `Press ${data} again to ${labelOf(action, item).toLowerCase()}${item ? ` ${item.label}` : ""} · any other key cancels`, tone: "warning" };
				} else void run(action, item);
			}
		}
		request();
	};

	const header = (width: number, items: PanelItem[]): string => {
		const title = theme.fg("accent", theme.bold(spec.title));
		const summary = spec.summary?.() ?? `${items.length}`;
		const left = ` ${title}  ${theme.fg("muted", summary)}`;
		const search = state.searching
			? `${theme.fg("accent", "/")} ${state.query}${theme.fg("accent", "▏")}`
			: state.query ? `${theme.fg("accent", "/")} ${state.query} ${theme.fg("dim", "esc clears")}` : theme.fg("dim", "/ search");
		return spread(left, `${search} `, width);
	};

	const listLines = (items: PanelItem[], width: number, height: number): string[] => {
		if (!items.length) {
			const text = state.query ? `Nothing matches “${state.query}”. esc clears the search.` : spec.empty ?? "Nothing here yet.";
			return wrapTextWithAnsi(theme.fg("muted", text), Math.max(8, width - 2)).map(line => ` ${line}`).slice(0, height);
		}
		const selected = current(items);
		const index = Math.max(0, items.findIndex(item => item.id === selected?.id));
		const start = Math.max(0, Math.min(index - Math.floor(height / 2), items.length - height));
		return items.slice(start, start + height).map(item => {
			const chosen = item.id === selected?.id;
			const cursor = chosen ? theme.fg(state.focus === "list" ? "accent" : "dim", SYMBOL.cursor) : " ";
			const symbol = item.symbol ? `${paint(theme, item.tone, item.symbol)} ` : "";
			const label = chosen ? theme.bold(item.label) : item.label;
			return spread(`${cursor} ${symbol}${label}`, item.meta ? theme.fg("dim", item.meta) : "", width);
		});
	};

	const helpLines = (width: number): string[] => {
		const rows: [string, string][] = [
			["↑↓ j k", "move"], ["enter →", "open detail"], ["tab", "switch list / detail"],
			["pgup pgdn", "scroll detail"], ["/", "search"], ["esc", "back · clear · close"], ["q", "close"],
			...(spec.actions ?? []).map(action => [action.key, `${labelOf(action, undefined)}${action.confirm ? " (asks again)" : ""}`] as [string, string]),
		];
		return [theme.fg("accent", " Keys"), ...rows.map(([key, text]) => fit(`   ${theme.fg("accent", fit(key, 10))} ${text}`, width))];
	};

	const footer = (width: number, item: PanelItem | undefined): string => {
		const actions = state.busy ? [] : available(item).map(action => `${theme.fg("accent", action.key)} ${labelOf(action, item)}`);
		const always = [`${theme.fg("dim", "?")} ${theme.fg("dim", "keys")}`, theme.fg("dim", "esc")];
		return fit(` ${[...actions, ...always].join(theme.fg("dim", " · "))}`, width);
	};

	const render = (width: number): string[] => {
		const items = visible();
		const item = current(items);
		if (item && state.selected !== item.id) state.selected = item.id;
		const height = panelHeight(tui.terminal?.rows);
		const rule = theme.fg("dim", "─".repeat(Math.max(0, width)));
		const notice = state.notice ? fit(` ${paint(theme, state.notice.tone, state.notice.text)}`, width) : undefined;
		const bodyHeight = Math.max(3, height - 4 - (notice ? 1 : 0));
		const wide = width >= WIDE;
		const body: string[] = [];

		if (state.help) body.push(...helpLines(width));
		else if (wide) {
			const listWidth = Math.max(24, Math.min(44, Math.round(width * 0.36)));
			const detailWidth = Math.max(10, width - listWidth - 3);
			const list = listLines(items, listWidth, bodyHeight);
			const detail = item ? detailLines(theme, spec.detail(item), detailWidth - 1) : [];
			state.scroll = Math.min(state.scroll, Math.max(0, detail.length - bodyHeight));
			const shown = detail.slice(state.scroll, state.scroll + bodyHeight);
			const divider = theme.fg(state.focus === "detail" ? "accent" : "dim", SYMBOL.divider);
			for (let row = 0; row < bodyHeight; row += 1) {
				body.push(`${fit(list[row] ?? "", listWidth)} ${divider} ${fit(shown[row] ?? "", detailWidth)}`);
			}
		} else if (state.focus === "detail" && item) {
			const detail = [theme.fg("dim", "‹ esc back"), ...detailLines(theme, spec.detail(item), width - 2)];
			state.scroll = Math.min(state.scroll, Math.max(0, detail.length - bodyHeight));
			body.push(...detail.slice(state.scroll, state.scroll + bodyHeight).map(line => fit(` ${line}`, width)));
		} else body.push(...listLines(items, width, bodyHeight));

		while (body.length < bodyHeight) body.push("");
		return [header(width, items), rule, ...body.slice(0, bodyHeight).map(line => fit(line, width)), ...(notice ? [notice] : []), rule, footer(width, item)];
	};

	return {
		focused: true,
		render,
		handleInput,
		invalidate() {},
		dispose,
	};
}

/** Open a docked panel. Resolves when the person closes it. */
export async function openPanel(ctx: Pick<ExtensionCommandContext, "ui" | "hasUI">, spec: PanelSpec): Promise<void> {
	if (!ctx.hasUI) return;
	await ctx.ui.custom<null>((tui, theme, _keys, done) => createPanel(spec, tui, theme, () => done(null)));
}

/** Plain-text rendering of the same data, for print and RPC modes. */
export function panelText(spec: PanelSpec): string {
	const items = spec.items();
	const lines = [`${spec.title}${spec.summary ? ` · ${spec.summary()}` : ""}`];
	if (!items.length) lines.push(spec.empty ?? "Nothing here yet.");
	for (const item of items) lines.push(`${item.symbol ? `${item.symbol} ` : ""}${item.label}${item.meta ? ` · ${item.meta}` : ""}`);
	return lines.join("\n");
}

export const RESERVED_KEYS: ReadonlySet<string> = RESERVED;
