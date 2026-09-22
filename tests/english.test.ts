import assert from "node:assert/strict";
import { test } from "node:test";
import { ENGLISH_SYSTEM, cheapestModel, isEnglish, toEnglishFields, toEnglishInstructions, type Complete } from "../src/index.ts";

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
