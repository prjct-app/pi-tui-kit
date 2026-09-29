import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { createForm, type FormValues } from "../src/index.ts";

const theme: any = { fg: (_tone: string, text: string) => text, bold: (text: string) => text };
const KEY = { down: "\x1b[B", up: "\x1b[A", tab: "\t", enter: "\r", escape: "\x1b" };
const fields = [
	{ id: "name", label: "name", required: true, hint: "A short label." },
	{ id: "command", label: "command", placeholder: "npm test" },
];

function harness(spec: Partial<Parameters<typeof createForm>[0]> = {}) {
	const result: { value?: FormValues | undefined; closed: boolean } = { closed: false };
	const tui: any = { terminal: { columns: 80, rows: 30 }, requestRender: () => {} };
	const form = createForm({ title: "New job", fields, submitLabel: "create", ...spec }, tui, theme, value => { result.value = value; result.closed = true; });
	const text = () => form.render(80).map(line => stripVTControlCharacters(line).replace(/\x1b_[^\x07]*\x07/g, ""));
	const type = (value: string) => [...value].forEach(char => form.handleInput(char));
	return { form, result, text, type };
}

test("docked grammar: title with position, labelled fields, hint, key footer", () => {
	const { text } = harness();
	const lines = text();
	assert.match(lines[0]!, /^New job\s+1\/2$/);
	assert.match(lines[1]!, /^─+$/);
	assert.ok(lines.some(line => /^› name\s/.test(line)));
	assert.ok(lines.some(line => /^\s+command\?\s+npm test/.test(line)));
	assert.ok(lines.some(line => /A short label\./.test(line)));
	assert.match(lines.at(-1)!, /enter next · tab\/↑↓ move · esc cancel/);
	assert.ok(lines.every(line => line.length === 80));
});

test("enter walks the fields and submits trimmed values from the last", async () => {
	const { form, result, text, type } = harness();
	type(" api tests ");
	form.handleInput(KEY.enter);
	assert.match(text().at(-1)!, /enter create/);
	type("npm test");
	form.handleInput(KEY.enter);
	await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual(result.value, { name: "api tests", command: "npm test" });
});

test("a missing required field keeps the form open and focuses it", async () => {
	const { form, result, text } = harness();
	form.handleInput(KEY.down);
	form.handleInput(KEY.enter);
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(result.closed, false);
	assert.ok(text().some(line => /name is required/.test(line)));
	assert.match(text()[0]!, /1\/2/);
});

test("validation errors are shown and the values are kept", async () => {
	const { form, result, text, type } = harness({ validate: values => values.command ? undefined : "Give a command or an interval." });
	type("x");
	form.handleInput(KEY.tab);
	form.handleInput(KEY.enter);
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(result.closed, false);
	assert.ok(text().some(line => /Give a command or an interval\./.test(line)));
	form.handleInput(KEY.escape);
	assert.equal(result.closed, true);
	assert.equal(result.value, undefined);
});
