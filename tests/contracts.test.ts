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

test("repair fixes the shapes models send without strict sampling", () => {
	const answer = "`git branch` marks the current branch with `*`.";
	// Observed from MiniMax-M3: every one of these looped on validation before.
	const sent: unknown[] = [
		{ kind: "answer", answer, refs: "" },
		{ kind: "answer", answer, refs: [""] },
		{ kind: "answer", answer, refs: [{ path: "" }] },
		{ kind: "answer", answer, refs: { item: "" } },
		{ kind: "answer", answer },
		{ kind: "answer", answer: { answer, refs: "" } },
		JSON.stringify({ kind: "answer", answer, refs: [] }),
		{ reply: { kind: "Answer", answer, refs: "none" } },
		{ kind: "answer", text: answer },
		{ answer, refs: [], extra: "dropped" },
		{ kind: "answer", explanation: answer },
	];
	for (const raw of sent) {
		assert.deepEqual(repairReply(raw), { kind: "answer", answer, refs: [] }, JSON.stringify(raw));
	}
});

test("repair coerces fields by the schema of the kind", () => {
	assert.deepEqual(repairReply({ kind: "answer", answer: "See it.", refs: ["src/a.ts:12", { path: "src/b.ts", line: "7" }, { path: "src/c.ts", line: 0 }] }),
		{ kind: "answer", answer: "See it.", refs: [{ path: "src/a.ts", line: 12 }, { path: "src/b.ts", line: 7 }, { path: "src/c.ts" }] });
	assert.deepEqual(repairReply({
		kind: "change",
		files: { path: "src/a.ts", action: "Added", what: "retry" },
		checks: [{ command: "npm test", passed: "yes" }],
		pending: "none",
		explanation: "",
	}), {
		kind: "change",
		files: [{ path: "src/a.ts", action: "created", what: "retry" }],
		checks: [{ command: "npm test", passed: true }],
		pending: [],
	});
	assert.deepEqual(repairReply({ kind: "needs-input", question: "Keep it?", options: "keep" }),
		{ kind: "needs_input", question: "Keep it?", options: ["keep"] });
	assert.deepEqual(repairReply({ kind: "diagnosis", cause: "Stale key", evidence: ["src/cache.ts:4"], fix: "proposed" }),
		{ kind: "diagnosis", cause: "Stale key", evidence: [{ path: "src/cache.ts", line: 4 }], fix: { status: "proposed", files: [] } });
});

test("repair never invents content, so validation still names what is missing", () => {
	assert.ok(replyProblems(repairReply({ kind: "change", files: ["src/a.ts"], checks: [], pending: [] })).length > 0);
	assert.ok(replyProblems(repairReply({ kind: "answer", refs: [] })).length > 0);
	assert.deepEqual(replyProblems(repairReply({ kind: "essay" })), ["kind: must be one of change, answer, diagnosis, needs_input, blocked"]);
	assert.deepEqual(repairReply("not json"), "not json");
	assert.deepEqual(repairReply(change), change);
	assert.deepEqual(replyProblems(repairReply(change, { kinds: ["answer"] }), { kinds: ["answer"] }), ["kind: must be one of answer"]);
});

test("salvage turns any reply into a plain answer, bounded", () => {
	assert.deepEqual(salvageReply({ kind: "answer", answer: { text: "Done." }, refs: 3 }), { kind: "answer", answer: "Done.", refs: [] });
	assert.deepEqual(salvageReply({}), { kind: "answer", answer: "The reply arrived without any text.", refs: [] });
	const long = salvageReply({ kind: "blocked", reason: "x".repeat(12500) });
	assert.equal(long.answer.length, 12000);
	assert.equal(long.explanation?.length, 500);
	assert.ok(isReply(long));
});

test("a long answer is delivered, not sent back to be shortened", () => {
	// Observed from MiniMax-M3: a 2,000-character cap rejected real task reports.
	assert.ok(isReply({ kind: "answer", answer: "x".repeat(6000), refs: [] }));
	assert.ok(isReply({ kind: "needs_input", question: "q".repeat(1500), options: [] }));
});

test("repair opens lists wrapped in one-key objects and flattens nested lists", () => {
	// Observed from MiniMax-M3 on 2026-09-29.
	assert.deepEqual(repairReply({ kind: "answer", answer: "All green.", refs: [["../api/", "../web/"]] }),
		{ kind: "answer", answer: "All green.", refs: [{ path: "../api/" }, { path: "../web/" }] });
	assert.deepEqual(repairReply({ kind: "needs_input", question: "Which?", options: { item: { item: ["a", "b"] } } }),
		{ kind: "needs_input", question: "Which?", options: ["a", "b"] });
});

test("a lead written under another kind's name still counts", () => {
	assert.deepEqual(repairReply({ kind: "needs_input", answer: "Keep the flag?", options: ["keep", "drop"] }),
		{ kind: "needs_input", question: "Keep the flag?", options: ["keep", "drop"] });
});

test("a change with prose but no usable files is delivered as an answer", () => {
	// Observed from MiniMax-M3: `files` missing, or bare paths wrapped in `{ item: [...] }`.
	assert.deepEqual(repairReply({ kind: "change", explanation: "Block 1 done; 30/30 tests pass." }),
		{ kind: "answer", answer: "Block 1 done; 30/30 tests pass.", refs: [] });
	const wrapped = repairReply({ kind: "change", files: { item: ["src/a.ts", "src/b.ts"] }, checks: [{ command: "npm test", passed: true }], pending: ["review"], explanation: "Scaffolded the package." });
	assert.deepEqual(wrapped, { kind: "answer", answer: "Scaffolded the package.\n✓ npm test\npending: review", refs: [{ path: "src/a.ts" }, { path: "src/b.ts" }] });
	assert.ok(isReply(wrapped));
	// Prose under another kind's field, or only checks and pending items: still the model's own words.
	assert.deepEqual(repairReply({ kind: "change", answer: "Preview is up on :3300." }), { kind: "answer", answer: "Preview is up on :3300.", refs: [] });
	assert.deepEqual(repairReply({ kind: "change", files: "[]", checks: [{ command: "audit", passed: true }], pending: ["migrate realtime"] }),
		{ kind: "answer", answer: "✓ audit\npending: migrate realtime", refs: [] });
	// A valid change stays a change.
	assert.deepEqual(repairReply({ ...change, explanation: "Why." }), { ...change, explanation: "Why." });
});
