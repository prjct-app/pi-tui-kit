import { Type, type Static, type TSchema } from "typebox";
import { Compile } from "typebox/compile";
import { repairArgs } from "./repair.ts";

/**
 * What an agent hands back, as data instead of prose.
 *
 * A reply is one of a few kinds, and each kind says what it must contain: a
 * change lists the files it touched and the checks it ran, a diagnosis names
 * the cause and the evidence for it. The agent fills the fields; code decides
 * how they look.
 *
 * The contract orders a reply, it does not censor it: validation checks
 * that the kind exists and carries its fields. The model decides the necessary evidence and length; validation never clips it.
 */

/** A closed set of strings, serialized as a plain JSON Schema enum like pi-ai's StringEnum. */
const oneOf = <const T extends readonly string[]>(values: T, description?: string) =>
	Type.Unsafe<T[number]>({ type: "string", enum: [...values], ...(description ? { description } : {}) });
const text = (description?: string) => Type.String({ minLength: 1, ...(description ? { description } : {}) });
const path = Type.String({ minLength: 1, maxLength: 1024, description: "Path relative to the working directory." });
const line = Type.Integer({ minimum: 1 });
const strict = { additionalProperties: false } as const;

const explanation = Type.Optional(text("The why, when the person asked for it. Everything else goes in the fields above."));

export const REPLY_KINDS = ["change", "answer", "diagnosis", "needs_input", "blocked"] as const;
export type ReplyKind = (typeof REPLY_KINDS)[number];

export const ChangeReplySchema = Type.Object({
	kind: Type.Literal("change"),
	files: Type.Array(Type.Object({
		path,
		action: oneOf(["created", "modified", "deleted"] as const),
		what: text("What changed in this file, in one line."),
	}, strict), { minItems: 1 }),
	checks: Type.Array(Type.Object({
		command: text("The command or check that ran."),
		passed: Type.Boolean(),
	}, strict), { }),
	pending: Type.Array(text(), { description: "What is left for someone else to do. Empty when nothing is." }),
	explanation,
}, strict);

export const AnswerReplySchema = Type.Object({
	kind: Type.Literal("answer"),
	answer: text("The direct answer to the question."),
	refs: Type.Array(Type.Object({ path, line: Type.Optional(line) }, strict), { }),
	explanation,
}, strict);

export const DiagnosisReplySchema = Type.Object({
	kind: Type.Literal("diagnosis"),
	cause: text("The root cause, stated as a fact."),
	evidence: Type.Array(Type.Object({
		path,
		line: Type.Optional(line),
		fact: text("What this location shows."),
	}, strict), { minItems: 1 }),
	fix: Type.Object({
		status: oneOf(["applied", "proposed", "none"] as const),
		files: Type.Array(path, { }),
	}, strict),
	explanation,
}, strict);

export const NeedsInputReplySchema = Type.Object({
	kind: Type.Literal("needs_input"),
	question: text("The one decision needed to continue."),
	options: Type.Array(text(), { }),
	explanation,
}, strict);

export const BlockedReplySchema = Type.Object({
	kind: Type.Literal("blocked"),
	reason: text("What stops the work, and exactly what is needed."),
	tried: Type.Array(text(), { }),
	explanation,
}, strict);

const SCHEMAS = {
	change: ChangeReplySchema,
	answer: AnswerReplySchema,
	diagnosis: DiagnosisReplySchema,
	needs_input: NeedsInputReplySchema,
	blocked: BlockedReplySchema,
} as const satisfies Record<ReplyKind, TSchema>;

export type ChangeReply = Static<typeof ChangeReplySchema>;
export type AnswerReply = Static<typeof AnswerReplySchema>;
export type DiagnosisReply = Static<typeof DiagnosisReplySchema>;
export type NeedsInputReply = Static<typeof NeedsInputReplySchema>;
export type BlockedReply = Static<typeof BlockedReplySchema>;
export type Reply = ChangeReply | AnswerReply | DiagnosisReply | NeedsInputReply | BlockedReply;

/**
 * Tool schemas expose the same constraints that validation enforces. A model
 * must not discover hidden limits through rejected calls.
 */
const strip = (schema: unknown, drop: ReadonlySet<string>): unknown => {
	if (Array.isArray(schema)) return schema.map(item => strip(item, drop));
	if (typeof schema !== "object" || schema === null) return schema;
	return Object.fromEntries(Object.entries(schema).filter(([key]) => !drop.has(key)).map(([key, value]) => [key, strip(value, drop)]));
};
const shapeOnly = (schema: unknown): unknown => strip(schema, new Set(["description"]));

/**
 * The schema a tool shows the model, including validation constraints.
 * Descriptions stay unless `descriptions: false`.
 */
export function schemaForModel<T extends TSchema>(schema: T, options: { descriptions?: boolean } = {}): T {
	const drop = options.descriptions === false ? new Set(["description"]) : new Set<string>();
	return Type.Unsafe<Static<T>>(strip(JSON.parse(JSON.stringify(schema)), drop) as object) as unknown as T;
}

/**
 * The schema a reply tool declares: every kind this caller accepts, as one
 * union. Descriptions are omitted; validation constraints remain visible.
 */
export function replySchema(kinds: readonly ReplyKind[] = REPLY_KINDS) {
	return Type.Unsafe<Reply>(shapeOnly(JSON.parse(JSON.stringify(Type.Union(kinds.map(kind => SCHEMAS[kind]))))) as object);
}

const validators = new Map<ReplyKind, ReturnType<typeof Compile>>();
const validator = (kind: ReplyKind) => {
	const cached = validators.get(kind);
	if (cached) return cached;
	const compiled = Compile(SCHEMAS[kind]);
	validators.set(kind, compiled);
	return compiled;
};

/** At most this many complaints: one malformed array can otherwise produce one per element. */
const MAX_PROBLEMS = 8;

/** Schema errors in words a model can act on, bounded. */
export function problemsOf(check: { Errors(value: unknown): Iterable<{ instancePath: string; message: string }> }, value: unknown, subject = "the reply"): string[] {
	return [...check.Errors(value)].slice(0, MAX_PROBLEMS).map(problem => `${problem.instancePath || subject}: ${problem.message}`);
}

export type ReplyRules = {
	/** Kinds this caller accepts. Defaults to all of them. */
	kinds?: readonly ReplyKind[];
};

/**
 * What is wrong with a reply, empty when nothing is.
 *
 * Validated per kind rather than against the union, so the complaint names the
 * field that is missing instead of "must match one of the union members".
 */
export function replyProblems(value: unknown, rules: ReplyRules = {}): string[] {
	const kinds = rules.kinds ?? REPLY_KINDS;
	const kind = (value as { kind?: unknown } | null)?.kind;
	if (typeof kind !== "string" || !(kinds as readonly string[]).includes(kind)) {
		return [`kind: must be one of ${kinds.join(", ")}`];
	}
	return problemsOf(validator(kind as ReplyKind), value, `kind=${kind}`);
}

export const isReply = (value: unknown, rules?: ReplyRules): value is Reply => replyProblems(value, rules).length === 0;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Parse only a whole argument wrapper, never a string field inside a reply. */
const unstring = (value: unknown): unknown => {
	if (typeof value !== "string" || !/^\s*[[{]/u.test(value)) return value;
	try { return JSON.parse(value); } catch { return value; }
};

/** Normalize representation; the model corrects missing or conflicting evidence. */
export function repairReply(raw: unknown, rules: ReplyRules = {}): unknown {
	const parsed = unstring(raw);
	const value = isRecord(parsed) && Object.keys(parsed).length === 1 && isRecord(parsed.reply)
		? parsed.reply : parsed;
	if (!isRecord(value)) return value;
	const kinds = rules.kinds ?? REPLY_KINDS;
	const kind = typeof value.kind === "string" ? value.kind.toLowerCase().replace(/-/gu, "_") : "";
	if (!(kinds as readonly string[]).includes(kind)) return value;
	return repairArgs(SCHEMAS[kind as ReplyKind], value.kind === kind ? value : { ...value, kind });
}

/** After repeated schema errors, deliver the exact data without losing fields,
 * numeric results, booleans, references or the tail of a long response. */
export function salvageReply(raw: unknown): AnswerReply {
	const answer = typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
	return { kind: "answer", answer: answer || "The reply arrived without any text.", refs: [] };
}

const at = (ref: { path: string; line?: number }): string => ref.line ? `${ref.path}:${ref.line}` : ref.path;

/**
 * A reply as plain lines. The same data always looks the same, whoever wrote
 * it; callers add color, never wording.
 */
export function replyLines(reply: Reply): string[] {
	const body = ((): string[] => {
		switch (reply.kind) {
			case "change": return [
				`${reply.files.length} file${reply.files.length === 1 ? "" : "s"} changed`,
				...reply.files.map(file => `  ${file.action.padEnd(8)} ${file.path} — ${file.what}`),
				...reply.checks.map(check => `  ${check.passed ? "✓" : "✗"} ${check.command}`),
				...reply.pending.map(item => `  pending: ${item}`),
			];
			case "answer": return [
				reply.answer,
				...(reply.refs.length ? [`  refs: ${reply.refs.map(at).join(", ")}`] : []),
			];
			case "diagnosis": return [
				`cause: ${reply.cause}`,
				...reply.evidence.map(item => `  ${at(item)} — ${item.fact}`),
				`fix: ${reply.fix.status}${reply.fix.files.length ? ` · ${reply.fix.files.join(", ")}` : ""}`,
			];
			case "needs_input": return [
				reply.question,
				...reply.options.map((option, index) => `  ${index + 1}. ${option}`),
			];
			case "blocked": return [
				`blocked: ${reply.reason}`,
				...reply.tried.map(item => `  tried: ${item}`),
			];
		}
	})();
	return reply.explanation ? [...body, "", reply.explanation] : body;
}

/** One-line summary for rows and status lines. */
export function replyHeadline(reply: Reply): string {
	switch (reply.kind) {
		case "change": return `${reply.files.length} file${reply.files.length === 1 ? "" : "s"} · ${reply.checks.filter(check => check.passed).length}/${reply.checks.length} checks`;
		case "answer": return reply.answer.split("\n")[0] ?? "";
		case "diagnosis": return reply.cause.split("\n")[0] ?? "";
		case "needs_input": return reply.question;
		case "blocked": return reply.reason.split("\n")[0] ?? "";
	}
}
