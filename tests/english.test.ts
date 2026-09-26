import assert from "node:assert/strict";
import { test } from "node:test";
import { ENGLISH_SYSTEM, cheapestModel, isEnglish, sessionComplete, toEnglishFields, toEnglishInstructions, type Complete } from "../src/index.ts";

const recorder = (reply: string | (() => never)) => {
	const calls: { system: string; user: string }[] = [];
	const complete: Complete = async (system, user) => {
		calls.push({ system, user });
		return typeof reply === "function" ? reply() : reply;
	};
	return { calls, complete };
};

test("Spanish instructions are detected; English, short text and identifiers pass", () => {
	assert.equal(isEnglish("Revisa el importador y dime por qué pierde las filas con BOM"), false);
	assert.equal(isEnglish("¿Qué falla?"), false);
	assert.equal(isEnglish("Read src/importer.ts and report why rows with a BOM are dropped"), true);
	assert.equal(isEnglish("fix the tests"), true);
	assert.equal(isEnglish("src/el/la/que.ts pi-subagents.ts"), true);
});

test("English costs nothing: no call is made", async () => {
	const { calls, complete } = recorder("unused");
	const text = "Read src/importer.ts and report why rows are dropped.";
	assert.equal(await toEnglishInstructions(text, complete), text);
	assert.equal(calls.length, 0);
});

test("other languages are rewritten once, with the plain-English system prompt", async () => {
	const { calls, complete } = recorder("Read src/importer.ts. Report why rows with a BOM are dropped.");
	const out = await toEnglishInstructions("Lee src/importer.ts y dime por qué se pierden las filas con BOM", complete);
	assert.equal(out, "Read src/importer.ts. Report why rows with a BOM are dropped.");
	assert.equal(calls.length, 1);
	assert.equal(calls[0]!.system, ENGLISH_SYSTEM);
});

test("a failed, empty or runaway rewrite delivers the original", async () => {
	const spanish = "Lee el archivo y dime por qué falla la prueba";
	assert.equal(await toEnglishInstructions(spanish, recorder("").complete), spanish);
	assert.equal(await toEnglishInstructions(spanish, recorder(() => { throw new Error("no model"); }).complete), spanish);
	assert.equal(await toEnglishInstructions(spanish, recorder("x".repeat(5000)).complete), spanish);
});

test("fields are judged one by one", async () => {
	const { calls, complete } = recorder("Map the store.");
	const out = await toEnglishFields({ subject: "store", task: "Mapea el store y dime que hace cada modulo por favor", context: undefined }, complete);
	assert.deepEqual(out, { subject: "store", task: "Map the store.", context: undefined });
	assert.equal(calls.length, 1);
});

test("the cheapest reachable model is picked by input plus output price", () => {
	const ctx = { modelRegistry: { getAvailable: () => [
		{ provider: "openai", id: "big", cost: { input: 5, output: 20 } },
		{ provider: "openrouter", id: "flash", cost: { input: 0.1, output: 0.4 } },
		{ provider: "xai", id: "mid", cost: { input: 1, output: 2 } },
	] } };
	assert.equal(cheapestModel(ctx)?.id, "flash");
	assert.equal(cheapestModel({}), undefined);
});

test("the session's own model rewrites, through Pi's registry", async () => {
	const seen: { model?: unknown; system?: string; user?: string }[] = [];
	const model = { provider: "openai-codex", id: "gpt-6-sol" };
	const ctx = { model, modelRegistry: { getAvailable: () => [{ provider: "openrouter", id: "free", cost: { input: 0, output: 0 } }],
		complete: async (used: never, context: never) => {
			const c = context as { systemPrompt: string; messages: { content: string }[] };
			seen.push({ model: used, system: c.systemPrompt, user: c.messages[0]?.content });
			return { stopReason: "stop", content: [{ type: "text", text: " Map the store. " }] };
		} } };
	assert.equal(await sessionComplete(ctx)("sys", "Mapea el store"), "Map the store.");
	assert.deepEqual(seen, [{ model, system: "sys", user: "Mapea el store" }]);
	assert.equal(await sessionComplete({ modelRegistry: ctx.modelRegistry })("sys", "x"), "");
	const failing = { model, modelRegistry: { complete: async () => ({ stopReason: "error", content: [] }) } };
	assert.equal(await sessionComplete(failing)("sys", "x"), "");
});
