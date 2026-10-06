import assert from "node:assert/strict";
import { test } from "node:test";
import { Compile } from "typebox/compile";
import { isReply, repairReply, replyHeadline, replyLines, replyProblems, replySchema, salvageReply, type Reply } from "../src/index.ts";

const change: Reply = {
	kind: "change",
	files: [{ path: "src/a.ts", action: "modified", what: "adds retry on timeout" }],
	checks: [{ command: "npm test", passed: true }, { command: "tsc", passed: false }],
	pending: [],
};

test("every valid kind passes", () => {
	const replies: Reply[] = [
		change,
		{ kind: "answer", answer: "In src/schema.ts.", refs: [{ path: "src/schema.ts", line: 12 }] },
		{ kind: "diagnosis", cause: "Stale cache key", evidence: [{ path: "src/cache.ts", line: 4, fact: "key omits cwd" }], fix: { status: "applied", files: ["src/cache.ts"] } },
		{ kind: "needs_input", question: "Keep the old flag?", options: ["keep", "drop"] },
		{ kind: "blocked", reason: "No credentials for the registry", tried: ["npm whoami"] },
	];
	for (const reply of replies) assert.deepEqual(replyProblems(reply), [], reply.kind);
});

test("the union schema a tool declares accepts the same replies", () => {
	assert.ok(Compile(replySchema()).Check(change));
	assert.equal(Compile(replySchema(["answer"])).Check(change), false);
});

test("problems name the field a model has to fix", () => {
	assert.match(replyProblems({ kind: "change", checks: [], pending: [] })[0]!, /kind=change|files/);
	assert.deepEqual(replyProblems({ kind: "essay" }), ["kind: must be one of change, answer, diagnosis, needs_input, blocked"]);
	assert.deepEqual(replyProblems(change, { kinds: ["answer"] }), ["kind: must be one of answer"]);
	assert.ok(replyProblems({ ...change, extra: 1 }).length > 0);
});

test("the same data always renders the same lines", () => {
	assert.deepEqual(replyLines(change), [
		"1 file changed",
		"  modified src/a.ts — adds retry on timeout",
		"  ✓ npm test",
		"  ✗ tsc",
	]);
	assert.equal(replyHeadline(change), "1 file · 1/2 checks");
	assert.deepEqual(replyLines({ kind: "answer", answer: "Yes.", refs: [], explanation: "Because." }), ["Yes.", "", "Because."]);
});

test("the contract orders a reply, it does not censor its content", () => {
	assert.ok(isReply({ kind: "answer", answer: "Use `retry()` from src/retry.ts", refs: [], explanation: "Because the upstream times out." }));
	assert.ok(isReply({ ...change, explanation: "Why it was needed." }));
});

test("valid replies and literal content are preserved exactly", () => {
  assert.equal(repairReply(change), change);
  const reply = { kind: "answer", answer: '  {"literal": "\\u00e9"}  ', refs: [] };
  assert.equal(repairReply(reply), reply);
  assert.deepEqual(repairReply(JSON.stringify(reply)), reply);
  assert.deepEqual(repairReply({ reply: { ...reply, kind: "Answer" } }), reply);
});

test("missing, invalid or extra evidence is returned for model correction", () => {
  for (const reply of [
    { kind: "answer", answer: "done" },
    { kind: "answer", answer: "done", refs: [], critical: "migration deletes data" },
    { kind: "change", files: [], checks: [{command: "test", passed: 2}], pending: [] },
    { kind: "answer", answer: "done", refs: [{path: "src/a.ts", line: "8-39"}] },
  ]) {
    assert.deepEqual(repairReply(reply), reply);
    assert.ok(replyProblems(reply).length > 0);
  }
});

test("long replies and complete evidence lists have no arbitrary upper bound", () => {
  const reply = { kind: "answer", answer: "x".repeat(50000) + "CRITICAL_TAIL", refs: Array.from({length: 60}, (_, i) => ({path: `src/${i}.ts`})) };
  assert.ok(isReply(reply));
  assert.equal(repairReply(reply), reply);
  assert.ok(isReply({ ...change, checks: Array.from({length: 30}, (_, i) => ({command: `test ${i}`, passed: false})) }));
});

test("fallback preserves every field and the entire long tail", () => {
  const raw = { kind: "blocked", reason: "x".repeat(50000) + "CRITICAL_TAIL", checked: false, attempts: 0, refs: [{path: "src/a.ts", line: 7}] };
  const fallback = salvageReply(raw);
  assert.deepEqual(JSON.parse(fallback.answer), raw);
  assert.ok(isReply(fallback));
});

test("schemas expose the constraints that execution enforces", async () => {
  const { schemaForModel } = await import("../src/index.ts");
  const { Type } = await import("typebox");
  const full = Type.Object({ name: Type.String({ maxLength: 10, description: "who" }), tags: Type.Array(Type.String(), { maxItems: 3 }) });
  assert.deepEqual(schemaForModel(full), full);
  assert.equal(JSON.stringify(schemaForModel(full, { descriptions: false })).includes("who"), false);
  assert.equal(JSON.parse(JSON.stringify(schemaForModel(full, { descriptions: false }))).properties.name.maxLength, 10);
});
