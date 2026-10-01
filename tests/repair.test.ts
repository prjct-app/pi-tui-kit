import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { repairArgs, repairToolArgs } from "../src/index.ts";

const Schema = Type.Object({
	to: Type.String({ minLength: 1, maxLength: 20 }),
	kind: Type.Union([Type.Literal("info"), Type.Literal("question"), Type.Literal("handoff")]),
	body: Type.String({ minLength: 1, maxLength: 30 }),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
	urgent: Type.Optional(Type.Boolean()),
	options: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 3 })),
	fields: Type.Optional(Type.Array(Type.String())),
}, { additionalProperties: false });

test("valid arguments come back untouched", () => {
	const valid = { to: "qa", kind: "info", body: "done" };
	assert.equal(repairArgs(Schema, valid), valid);
});

test("near misses become the schema's shape; the meaning is kept", () => {
	const repaired = repairArgs(Schema, JSON.stringify({
		to: "qa", kind: "Question", message: "ready?", limit: "500", urgent: "yes",
		options: [{ label: "Sí" }, { text: "No", value: "no" }, 3, "x"], fields: "summary", extra: 1,
	}), { aliases: { body: ["message", "text"] } });
	assert.deepEqual(repaired, { to: "qa", kind: "question", body: "ready?", limit: 50, urgent: true, options: ["Sí", "No", "3"], fields: ["summary"] });
	assert.ok(Value.Check(Schema, repaired));
});

test("synonyms map invented enum values; required fields left out stay missing", () => {
	const repaired = repairArgs(Schema, { to: "pm", kind: "answer" }, { synonyms: { answer: "info" } }) as Record<string, unknown>;
	assert.equal(repaired.kind, "info");
	assert.equal(repaired.body, undefined, "a body the model never wrote is not invented");
	assert.ok(!Value.Check(Schema, repaired));
});

test("long text is cut only where the tool allows it", () => {
	const long = "x".repeat(80);
	assert.equal((repairArgs(Schema, { to: "a", kind: "info", body: long }) as { body: string }).body, long, "default: validation still refuses");
	const cut = (repairArgs(Schema, { to: "a", kind: "info", body: long }, { truncate: true }) as { body: string }).body;
	assert.equal(cut.length, 30);
	assert.match(cut, /truncated\]$/);
});

test("unions pick the branch the value names, and plain JSON Schema from MCP servers works", () => {
	const Reply = Type.Union([
		Type.Object({ kind: Type.Literal("a"), n: Type.Integer() }, { additionalProperties: false }),
		Type.Object({ kind: Type.Literal("b"), s: Type.String() }, { additionalProperties: false }),
	]);
	assert.deepEqual(repairArgs(Reply, { kind: "B", s: 7 }), { kind: "b", s: "7" });
	const mcp = { type: "object", properties: { fields: { type: "array", items: { type: "string" } }, id: { type: "string" } }, required: ["id"] };
	assert.deepEqual(repairArgs(mcp, { id: 12, fields: "summary,status" }), { id: "12", fields: ["summary,status"] });
});

test("repairToolArgs runs the tool's own repair first, then the schema's", () => {
	const registered: any[] = [];
	const pi = repairToolArgs({ registerTool: (tool: any) => registered.push(tool) }, { team_message: { aliases: { body: ["text"] } } });
	pi.registerTool({ name: "team_message", parameters: Schema, prepareArguments: (raw: any) => ({ ...raw, kind: raw.kind === "reply" ? "info" : raw.kind }) } as never);
	pi.registerTool({ name: "plain" } as never);
	assert.deepEqual(registered[0].prepareArguments({ to: "qa", kind: "reply", text: "ok" }), { to: "qa", kind: "info", body: "ok" });
	assert.equal(registered[1].prepareArguments, undefined, "a tool without parameters is left alone");
});

test("an empty optional field is dropped, not resent; open records repair their values", () => {
	const Jobs = { type: "object", properties: { action: { type: "string", enum: ["status", "result"] }, jobId: { type: "string", maxLength: 128 }, message: { type: "string", minLength: 1 } }, required: ["action"] };
	assert.deepEqual(repairArgs(Jobs, { action: "status", jobId: "", message: "" }), { action: "status", jobId: "" });
	const Tags = { type: "object", properties: { tags: { type: "object", additionalProperties: { type: "string" } } } };
	assert.deepEqual(repairArgs(Tags, { tags: { defects: ["a", "b"], level: 2 } }), { tags: { defects: "a\nb", level: "2" } });
});

test("common enum words, ranged line numbers, object items as text, empty optional lists", () => {
	const Report = Type.Object({
		criteria: Type.Array(Type.Object({ met: Type.Union([Type.Literal("yes"), Type.Literal("no"), Type.Literal("unknown")]) })),
		files: Type.Optional(Type.Array(Type.Object({ path: Type.String(), action: Type.Union([Type.Literal("created"), Type.Literal("modified"), Type.Literal("deleted")]) }), { minItems: 1 })),
		findings: Type.Array(Type.Object({ line: Type.Optional(Type.Integer({ minimum: 1 })) })),
		blockers: Type.Array(Type.String()),
	});
	const repaired = repairArgs(Report, {
		criteria: [{ met: "partial" }, { met: true }], files: [], findings: [{ line: "8-39" }],
		blockers: [{ blocker: "no access", need: "read /tmp" }],
	});
	assert.deepEqual(repaired, { criteria: [{ met: "unknown" }, { met: "yes" }], findings: [{ line: 8 }], blockers: ["no access — read /tmp"] });
	assert.ok(Value.Check(Report, repaired));
});

test("a required list left out becomes empty only when empty is valid", () => {
	const Schema = Type.Object({ blockers: Type.Array(Type.String()), files: Type.Array(Type.String(), { minItems: 1 }) });
	assert.deepEqual(repairArgs(Schema, {}), { blockers: [] }, "files must have items, so it stays missing and validation names it");
});
