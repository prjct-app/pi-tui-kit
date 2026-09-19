import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { MODE_PREFIX, ago, row, rowLine, createPanel, modeLine, panelHeight, panelText, readModes, setMode, spread, type PanelSpec } from "../src/index.ts";

const theme: any = {
	fg: (_tone: string, text: string) => text,
	bold: (text: string) => text,
};
const KEY = { up: "\x1b[A", down: "\x1b[B", enter: "\r", escape: "\x1b", tab: "\t", backspace: "\x7f" };

function harness(spec: Partial<PanelSpec> = {}, size = { columns: 120, rows: 30 }) {
	const renders = { count: 0 };
	const closed = { value: false };
	const tui: any = { terminal: size, requestRender: () => { renders.count += 1; } };
	const ran: string[] = [];
	const full: PanelSpec = {
		title: "MCP",
		summary: () => "3 servers",
		items: () => [
			{ id: "linear", label: "linear", symbol: "○", meta: "oauth ✓" },
			{ id: "jira", label: "jira", symbol: "○", meta: "oauth ✓" },
			{ id: "notion", label: "notion", symbol: "✕", tone: "error", meta: "signed out" },
		],
		detail: item => ({ title: item.label, subtitle: "not connected", fields: [{ label: "auth", value: item.meta ?? "" }], sections: [{ title: "Log", lines: ["09-18 14:02 timeout"] }] }),
		actions: [
			{ key: "c", label: "Connect", run: item => { ran.push(`connect ${item?.id}`); } },
			{ key: "x", label: "Logout", confirm: true, when: item => item?.meta === "oauth ✓", run: item => { ran.push(`logout ${item?.id}`); } },
		],
		...spec,
	};
	const panel = createPanel(full, tui, theme, () => { closed.value = true; });
	const screen = (width = size.columns) => panel.render(width).map(line => stripVTControlCharacters(line));
	const press = async (...keys: string[]) => { for (const key of keys) { panel.handleInput!(key); await new Promise(resolve => setImmediate(resolve)); } };
	return { panel, screen, press, ran, closed, renders };
}

test("the docked panel shows list and detail side by side, and every line fits the width", () => {
	const h = harness();
	const lines = h.screen();
	assert.equal(lines.length, panelHeight(30));
	assert.match(lines[0]!, /MCP {2}3 servers/);
	assert.match(lines[0]!, /\/ search/);
	assert.match(lines[2]!, /› ○ linear\s+oauth ✓ │ linear/);
	assert.ok(lines.some(line => line.includes("auth") && line.includes("oauth ✓")), "detail fields beside the list");
	assert.ok(lines.some(line => line.includes("Log")), "traceability section");
	assert.match(lines.at(-1)!, /c Connect · x Logout · \? keys · esc/);
	for (const line of h.panel.render(120)) assert.ok(visibleWidth(line) <= 120);
});

test("moving the cursor changes the detail and the actions that apply", async () => {
	const h = harness();
	await h.press(KEY.down, KEY.down);
	const lines = h.screen();
	assert.ok(lines.some(line => /› ✕ notion/.test(line)));
	assert.doesNotMatch(lines.at(-1)!, /Logout/, "logout only where it applies");
});

test("a destructive action asks for its key again; any other key cancels", async () => {
	const h = harness();
	await h.press("x");
	assert.deepEqual(h.ran, []);
	assert.ok(h.screen().some(line => /Press x again to logout linear/.test(line)));
	await h.press(KEY.down);
	await h.press("x", "x");
	assert.deepEqual(h.ran, ["logout jira"]);
});

test("search filters by label and meta, and esc clears before it closes", async () => {
	const h = harness();
	await h.press("/", "s", "i", "g", "n", KEY.enter);
	const lines = h.screen();
	assert.ok(lines.some(line => /› ✕ notion/.test(line)));
	assert.ok(!lines.some(line => /linear/.test(line.split("│")[0]!)));
	await h.press(KEY.escape);
	assert.equal(h.closed.value, false, "first esc clears the search");
	assert.ok(h.screen().some(line => /linear/.test(line)));
	await h.press(KEY.escape);
	assert.equal(h.closed.value, true);
});

test("a narrow terminal drills from the list into the detail and back", async () => {
	const h = harness({}, { columns: 60, rows: 24 });
	assert.ok(!h.screen(60).some(line => line.includes("│")), "one pane at a time");
	await h.press(KEY.enter);
	assert.ok(h.screen(60).some(line => /‹ esc back/.test(line)));
	await h.press(KEY.escape);
	assert.equal(h.closed.value, false);
	assert.ok(h.screen(60).some(line => /› ○ linear/.test(line)));
});

test("an empty panel says what to do next, and a failing action says why", async () => {
	const empty = harness({ items: () => [], empty: "No servers. Add one to ~/.pi/agent/mcp.json." });
	assert.ok(empty.screen().some(line => /No servers\. Add one/.test(line)));
	const failing = harness({ actions: [{ key: "c", label: "Connect", run: () => { throw new Error("timeout after 10s"); } }] });
	await failing.press("c");
	assert.ok(failing.screen().some(line => /Connect failed: timeout after 10s/.test(line)));
});

test("help lists every key, and q closes", async () => {
	const h = harness();
	await h.press("?");
	assert.ok(h.screen().some(line => /x\s+Logout \(asks again\)/.test(line)));
	await h.press("a");
	await h.press("q");
	assert.equal(h.closed.value, true);
});

test("modes share one prefix and one line", () => {
	const statuses: Array<[string, string | undefined]> = [];
	const ctx: any = { hasUI: true, ui: { theme, setStatus: (key: string, value: string | undefined) => statuses.push([key, value]) } };
	setMode(ctx, "plan", "plan 2/5");
	setMode(ctx, "agents", undefined);
	assert.deepEqual(statuses, [[`${MODE_PREFIX}plan`, "◆ plan 2/5"], [`${MODE_PREFIX}agents`, undefined]]);
	const modes = readModes(new Map([["mode:plan", "◆ plan"], ["other", "x"], ["mode:agents", "◆ agents ● 1"]]));
	assert.deepEqual(modes, ["◆ agents ● 1", "◆ plan"]);
	assert.equal(modeLine(theme, modes), " ◆ agents ● 1  ·  ◆ plan");
	assert.equal(modeLine(theme, []), undefined);
});

test("small helpers", () => {
	assert.equal(ago(Date.now() - 90_000), "2m ago");
	assert.equal(ago(undefined), "—");
	assert.equal(visibleWidth(spread("left side", "right", 20)), 20);
	assert.match(panelText({ title: "MCP", items: () => [], detail: () => ({ title: "" }), empty: "None." }), /MCP\nNone\./);
});

test("transcript rows share one grammar and cache their line", () => {
	const line = rowLine(theme, { symbol: "✓", verb: "mcp", target: "linear.get_issue\nFTY-49", meta: "12 fields" }, 60);
	assert.match(stripVTControlCharacters(line), /^✓ MCP {5}linear\.get_issue ↵ FTY-49 +12 fields$/);
	assert.equal(visibleWidth(line), 60);
	const component = row(theme, { symbol: "●", verb: "agent", target: "reviewer" });
	assert.equal(component.render(40), component.render(40), "same array: cached");
});
