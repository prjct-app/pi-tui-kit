import { Type, type Static, type TSchema } from "typebox";
import { Compile } from "typebox/compile";

/**
 * What an agent hands back, as data instead of prose.
 *
 * A reply is one of a few kinds, and each kind says what it must contain: a
 * change lists the files it touched and the checks it ran, a diagnosis names
 * the cause and the evidence for it. The agent fills the fields; code decides
 * how they look.
 *
 * The contract orders a reply, it does not censor it: validation checks only
 * that the kind exists and carries its fields. What belongs in each field is
 * said in its description. Lengths are bounded only so a runaway reply cannot
 * flood a transcript.
 */

/** A closed set of strings, serialized as a plain JSON Schema enum like pi-ai's StringEnum. */
const oneOf = <const T extends readonly string[]>(values: T, description?: string) =>
	Type.Unsafe<T[number]>({ type: "string", enum: [...values], ...(description ? { description } : {}) });
const text = (maxLength: number, description?: string) => Type.String({ minLength: 1, maxLength, ...(description ? { description } : {}) });
const path = Type.String({ minLength: 1, maxLength: 1024, description: "Path relative to the working directory." });
const line = Type.Integer({ minimum: 1 });
const strict = { additionalProperties: false } as const;

const explanation = Type.Optional(text(4000, "The why, when the person asked for it. Everything else goes in the fields above."));

export const REPLY_KINDS = ["change", "answer", "diagnosis", "needs_input", "blocked"] as const;
export type ReplyKind = (typeof REPLY_KINDS)[number];

export const ChangeReplySchema = Type.Object({
	kind: Type.Literal("change"),
	files: Type.Array(Type.Object({
		path,
		action: oneOf(["created", "modified", "deleted"] as const),
		what: text(300, "What changed in this file, in one line."),
	}, strict), { minItems: 1, maxItems: 50 }),
	checks: Type.Array(Type.Object({
		command: text(500, "The command or check that ran."),
		passed: Type.Boolean(),
	}, strict), { maxItems: 20 }),
	pending: Type.Array(text(300), { maxItems: 10, description: "What is left for someone else to do. Empty when nothing is." }),
	explanation,
}, strict);

export const AnswerReplySchema = Type.Object({
	kind: Type.Literal("answer"),
	answer: text(2000, "The direct answer to the question."),
	refs: Type.Array(Type.Object({ path, line: Type.Optional(line) }, strict), { maxItems: 20 }),
	explanation,
}, strict);

export const DiagnosisReplySchema = Type.Object({
	kind: Type.Literal("diagnosis"),
	cause: text(1000, "The root cause, stated as a fact."),
	evidence: Type.Array(Type.Object({
		path,
		line: Type.Optional(line),
		fact: text(500, "What this location shows."),
	}, strict), { minItems: 1, maxItems: 20 }),
	fix: Type.Object({
		status: oneOf(["applied", "proposed", "none"] as const),
		files: Type.Array(path, { maxItems: 50 }),
	}, strict),
	explanation,
}, strict);

export const NeedsInputReplySchema = Type.Object({
	kind: Type.Literal("needs_input"),
	question: text(500, "The one decision needed to continue."),
	options: Type.Array(text(200), { maxItems: 6 }),
	explanation,
}, strict);

export const BlockedReplySchema = Type.Object({
	kind: Type.Literal("blocked"),
	reason: text(1000, "What stops the work, and exactly what is needed."),
	tried: Type.Array(text(300), { maxItems: 10 }),
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

/** The schema a reply tool declares: every kind this caller accepts, as one union. */
export function replySchema(kinds: readonly ReplyKind[] = REPLY_KINDS) {
	return Type.Union(kinds.map(kind => SCHEMAS[kind]));
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
