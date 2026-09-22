import assert from "node:assert/strict";
import { test } from "node:test";
import { Compile } from "typebox/compile";
import { isReply, replyHeadline, replyLines, replyProblems, replySchema, type Reply } from "../src/index.ts";

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
