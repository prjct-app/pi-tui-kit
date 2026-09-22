import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { createChecklist, type ChecklistResult } from "../src/index.ts";

const theme: any = { fg: (_tone: string, text: string) => text, bold: (text: string) => text };
const KEY = { down: "\x1b[B", end: "\x1b[F", enter: "\r", escape: "\x1b" };
const items = [{ id: "scope", label: "Problem and scope" }, { id: "api", label: "Interfaces or API" }, { id: "edge", label: "Edge cases" }];

function harness(spec: Partial<Parameters<typeof createChecklist>[0]> = {}, rows = 30) {
	const result: { value?: ChecklistResult | undefined; closed: boolean } = { closed: false };
	const tui: any = { terminal: { columns: 80, rows }, requestRender: () => {} };
	const list = createChecklist({ title: "Clarify the specification", items, ...spec }, tui, theme, value => { result.value = value; result.closed = true; });
	const text = () => list.render(80).map(line => stripVTControlCharacters(line).replace(/\x1b_[^\x07]*\x07/g, ""));
	const type = (value: string) => [...value].forEach(char => list.handleInput(char));
	return { list, result, text, type };
}

test("docked grammar: title with count, All first, items, Other last, key footer", () => {
	const { text } = harness({ message: "Select one or many topics." });
	const lines = text();
	assert.match(lines[0]!, /^Clarify the specification\s+0 selected$/);
	assert.match(lines[1]!, /^─+$/);
	const rows = lines.filter(line => /[○●]/.test(line)).map(line => line.trim());
	assert.deepEqual(rows, ["› ○ All", "○ Problem and scope", "○ Interfaces or API", "○ Edge cases", "○ Other…"]);
	assert.match(lines.at(-1)!, /space toggle · a all · enter continue/);
	assert.ok(lines.every(line => line.length === 80), "every line fills the dock width");
});

test("All checks and clears every item", () => {
	const { list, result, text } = harness();
	list.handleInput(" ");
	assert.match(text()[0]!, /3 selected/);
	assert.ok(text().some(line => /● All/.test(line)));
	list.handleInput(" ");
	assert.match(text()[0]!, /0 selected/);
	list.handleInput("a");
	list.handleInput(KEY.enter);
	assert.deepEqual(result.value, { ids: ["scope", "api", "edge"] });
});

test("space toggles items and enter returns them in list order", () => {
	const { list, result } = harness();
	list.handleInput(KEY.down); list.handleInput(KEY.down); list.handleInput(KEY.down); list.handleInput(" ");
	list.handleInput("k"); list.handleInput("k"); list.handleInput(" ");
	list.handleInput(KEY.enter);
	assert.deepEqual(result.value, { ids: ["scope", "edge"] });
});

test("Other opens an inline field; what is written comes back and counts as a choice", () => {
	const { list, result, text, type } = harness();
	list.handleInput(KEY.end);
	list.handleInput(" ");
	assert.match(text().at(-1)!, /enter done · esc discard/);
	type("GDPR retention");
	assert.ok(text().some(line => /● Other: GDPR retention/.test(line)));
	list.handleInput(KEY.enter);
	assert.match(text()[0]!, /1 selected/);
	list.handleInput(KEY.enter);
	assert.deepEqual(result.value, { ids: [], other: "GDPR retention" });
});

test("esc while writing discards the text without closing", () => {
	const { list, result, text, type } = harness();
	list.handleInput(KEY.end); list.handleInput(" "); type("x"); list.handleInput(KEY.escape);
	assert.equal(result.closed, false);
	assert.ok(text().some(line => /○ Other…/.test(line)));
});

test("enter with nothing chosen asks for a choice; esc cancels", () => {
	const { list, result, text } = harness();
	list.handleInput(KEY.enter);
	assert.equal(result.closed, false);
	assert.match(text().at(-1)!, /Select at least 1/);
	list.handleInput(KEY.escape);
	assert.equal(result.closed, true);
	assert.equal(result.value, undefined);
});

test("All and Other can be turned off", () => {
	const { text } = harness({ all: false, other: false });
	assert.deepEqual(text().filter(line => /[○●]/.test(line)).map(line => line.trim()), ["› ○ Problem and scope", "○ Interfaces or API", "○ Edge cases"]);
});

test("on a short terminal the footer stays and the message gives way", () => {
	const { text } = harness({ message: "Select one or many topics." }, 12);
	const lines = text();
	assert.ok(lines.length <= 8);
	assert.match(lines.at(-1)!, /enter continue/);
});
