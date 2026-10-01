import { Type, type Static, type TSchema } from "typebox";
import { Compile } from "typebox/compile";
import { Value } from "typebox/value";

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
 * flood a transcript, well above what a real reply needs: a tighter cap made
 * models rewrite long answers, a full extra request each time.
 */

/** A closed set of strings, serialized as a plain JSON Schema enum like pi-ai's StringEnum. */
const oneOf = <const T extends readonly string[]>(values: T, description?: string) =>
	Type.Unsafe<T[number]>({ type: "string", enum: [...values], ...(description ? { description } : {}) });
const text = (maxLength: number, description?: string) => Type.String({ minLength: 1, maxLength, ...(description ? { description } : {}) });
const path = Type.String({ minLength: 1, maxLength: 1024, description: "Path relative to the working directory." });
const line = Type.Integer({ minimum: 1 });
const strict = { additionalProperties: false } as const;

const explanation = Type.Optional(text(12000, "The why, when the person asked for it. Everything else goes in the fields above."));

export const REPLY_KINDS = ["change", "answer", "diagnosis", "needs_input", "blocked"] as const;
export type ReplyKind = (typeof REPLY_KINDS)[number];

export const ChangeReplySchema = Type.Object({
	kind: Type.Literal("change"),
	files: Type.Array(Type.Object({
		path,
		action: oneOf(["created", "modified", "deleted"] as const),
		what: text(1000, "What changed in this file, in one line."),
	}, strict), { minItems: 1, maxItems: 50 }),
	checks: Type.Array(Type.Object({
		command: text(1000, "The command or check that ran."),
		passed: Type.Boolean(),
	}, strict), { maxItems: 20 }),
	pending: Type.Array(text(1000), { maxItems: 10, description: "What is left for someone else to do. Empty when nothing is." }),
	explanation,
}, strict);

export const AnswerReplySchema = Type.Object({
	kind: Type.Literal("answer"),
	answer: text(12000, "The direct answer to the question."),
	refs: Type.Array(Type.Object({ path, line: Type.Optional(line) }, strict), { maxItems: 50 }),
	explanation,
}, strict);

export const DiagnosisReplySchema = Type.Object({
	kind: Type.Literal("diagnosis"),
	cause: text(4000, "The root cause, stated as a fact."),
	evidence: Type.Array(Type.Object({
		path,
		line: Type.Optional(line),
		fact: text(1000, "What this location shows."),
	}, strict), { minItems: 1, maxItems: 20 }),
	fix: Type.Object({
		status: oneOf(["applied", "proposed", "none"] as const),
		files: Type.Array(path, { maxItems: 50 }),
	}, strict),
	explanation,
}, strict);

export const NeedsInputReplySchema = Type.Object({
	kind: Type.Literal("needs_input"),
	question: text(4000, "The one decision needed to continue."),
	options: Type.Array(text(1000), { maxItems: 6 }),
	explanation,
}, strict);

export const BlockedReplySchema = Type.Object({
	kind: Type.Literal("blocked"),
	reason: text(4000, "What stops the work, and exactly what is needed."),
	tried: Type.Array(text(1000), { maxItems: 10 }),
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
 * Keywords the model does not need to read: limits and descriptions are checked
 * after repair (replyProblems), and the tool description already says what
 * each field holds. Paid on every request, so the reply tool sends only the
 * shape: types, required fields, closed sets.
 */
const NOT_FOR_THE_MODEL = new Set(["description", "maxLength", "minLength", "maxItems", "minItems", "minimum", "maximum"]);
const shapeOnly = (schema: unknown): unknown => {
	if (Array.isArray(schema)) return schema.map(shapeOnly);
	if (typeof schema !== "object" || schema === null) return schema;
	return Object.fromEntries(Object.entries(schema).filter(([key]) => !NOT_FOR_THE_MODEL.has(key)).map(([key, value]) => [key, shapeOnly(value)]));
};

/**
 * The schema a reply tool declares: every kind this caller accepts, as one
 * union, shape only. The full schemas, limits included, still validate the
 * reply (replyProblems) after repair.
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

/**
 * Models without strict tool sampling send a reply in many near-miss shapes:
 * `"refs": ""` for an empty list, JSON inside a string, the reply wrapped in
 * another object, `"line": "12"`, `"added"` for `created`. Repair walks the
 * schema of the kind and fixes only the shape, never the content: a field the
 * model did not write stays missing, so validation still names it.
 */

/** The JSON Schema subset the reply schemas use. */
type Node = {
	type?: string;
	properties?: Record<string, Node>;
	required?: string[];
	items?: Node;
	enum?: string[];
	maxLength?: number;
};

/** The field that carries each kind: its presence also tells the kind apart. */
const LEAD = {
	change: "files",
	answer: "answer",
	diagnosis: "cause",
	needs_input: "question",
	blocked: "reason",
} as const satisfies Record<ReplyKind, string>;

/** Names models give the lead prose field when they miss it. */
const PROSE_ALIASES = ["text", "content", "message", "response", "summary", "result", "body", "reply"];

const KIND_ALIASES: Record<string, ReplyKind> = {
	changes: "change", changed: "change", edit: "change", edits: "change",
	reply: "answer", response: "answer", info: "answer",
	diagnose: "diagnosis", investigation: "diagnosis",
	question: "needs_input", ask: "needs_input", input: "needs_input", needsinput: "needs_input", clarification: "needs_input",
	block: "blocked", error: "blocked",
};

/** Words models use for a value of a closed set, by the value they mean. */
const SYNONYMS: Record<string, string> = {
	added: "created", add: "created", new: "created", create: "created",
	updated: "modified", update: "modified", modify: "modified", changed: "modified", edited: "modified", edit: "modified",
	removed: "deleted", remove: "deleted", delete: "deleted",
	fixed: "applied", apply: "applied", done: "applied",
	suggested: "proposed", propose: "proposed", pending: "proposed",
};

/** What a model writes when a list has nothing in it. */
const EMPTY_LIST = new Set(["", "none", "n/a", "na", "null", "nil", "-", "[]"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** JSON a model sent inside a string, parsed; anything else unchanged. */
const unstring = (value: unknown): unknown => {
	if (typeof value !== "string" || !/^\s*[[{]/u.test(value)) return value;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
};

/**
 * `{ "item": ["a", "b"] }` or `{ "item": { "item": [...] } }`: a list wrapped
 * in one-key objects, as XML-minded models send it. Only a wrapper around a
 * list or another object is opened; `{ "path": "a" }` is a single item.
 */
const listInside = (value: unknown): unknown => {
	let current = value;
	for (let depth = 0; depth < 3 && isRecord(current); depth += 1) {
		const values = Object.values(current);
		const inner = values.length === 1 ? unstring(values[0]) : undefined;
		if (!Array.isArray(inner) && !isRecord(inner)) break;
		current = inner;
	}
	return Array.isArray(current) ? current : value;
};

const blank = (value: unknown): boolean =>
	value === undefined || value === null
	|| (typeof value === "string" && value.trim() === "")
	|| (isRecord(value) && Object.values(value).every(blank));

/** `src/a.ts:12` or `src/a.ts:12:5` as a reference. */
const reference = (text: string): Record<string, unknown> => {
	const match = /^(.+?):(\d+)(?::\d+)?$/u.exec(text.trim());
	return match ? { path: match[1], line: Number(match[2]) } : { path: text.trim() };
};

/** A bare string where an object belongs fills the object's first required text field. */
const fromString = (schema: Node, text: string): unknown => {
	if (schema.properties?.path) return reference(text);
	const first = (schema.required ?? []).find(key => schema.properties?.[key]?.type === "string");
	return first ? { [first]: text } : text;
};

const repair = (schema: Node, raw: unknown): unknown => {
	const value = unstring(raw);
	switch (schema.type) {
		case "string": {
			if (typeof value === "number" || typeof value === "boolean") return String(value);
			if (Array.isArray(value) && value.every(item => typeof item === "string")) return value.join("\n");
			if (typeof value !== "string") return value;
			const trimmed = value.trim();
			if (!schema.enum) return trimmed;
			const lower = trimmed.toLowerCase();
			const meant = SYNONYMS[lower];
			return schema.enum.includes(lower) ? lower : meant && schema.enum.includes(meant) ? meant : trimmed;
		}
		case "integer": {
			if (typeof value === "number") return Math.trunc(value);
			const digits = typeof value === "string" ? /^\s*(\d+)/u.exec(value) : null;
			return digits ? Number(digits[1]) : value;
		}
		case "boolean": {
			if (typeof value === "number") return value !== 0;
			if (typeof value !== "string") return value;
			const word = value.trim().toLowerCase();
			return ["true", "yes", "pass", "passed", "ok"].includes(word) ? true
				: ["false", "no", "fail", "failed"].includes(word) ? false : value;
		}
		case "array": {
			const inner = listInside(value);
			const list = inner === undefined || inner === null
				|| (typeof inner === "string" && EMPTY_LIST.has(inner.trim().toLowerCase())) ? []
				: Array.isArray(inner) ? inner.flat(Infinity) : [inner];
			return schema.items ? list.map(item => repair(schema.items!, item)).filter(item => !blank(item)) : list;
		}
		case "object": return repairObject(schema, value);
		default: return value;
	}
};

/**
 * Keeps the declared fields only. An optional field that is blank, or that is
 * not text and still off its schema (a line of 0), is dropped instead of
 * failing the reply; text keeps its errors so the model hears about them.
 */
const repairObject = (schema: Node, raw: unknown): unknown => {
	const value = typeof raw === "string" ? fromString(schema, raw) : raw;
	if (!isRecord(value)) return value;
	const required = new Set(schema.required ?? []);
	return Object.fromEntries(Object.entries(schema.properties ?? {}).flatMap(([key, child]) => {
		const repaired = repair(child, value[key]);
		const optional = !required.has(key);
		if (repaired === undefined) return [];
		if (optional && (blank(repaired) || (typeof repaired !== "string" && !Value.Check(child as TSchema, repaired)))) return [];
		return [[key, repaired]];
	}));
};

const firstProse = (value: Record<string, unknown>): unknown =>
	PROSE_ALIASES.map(key => value[key]).find(item => typeof item === "string" && item.trim() !== "");

const kindOf = (value: Record<string, unknown>, kinds: readonly ReplyKind[]): ReplyKind | undefined => {
	const named = typeof value.kind === "string" ? value.kind.trim().toLowerCase().replace(/[\s-]+/gu, "_") : "";
	const candidates = [named, KIND_ALIASES[named] ?? "", KIND_ALIASES[named.replace(/_/gu, "")] ?? ""];
	const byName = candidates.find((kind): kind is ReplyKind => (kinds as readonly string[]).includes(kind));
	if (byName) return byName;
	const byLead = kinds.find(kind => value[LEAD[kind]] !== undefined);
	if (byLead) return byLead;
	return kinds.includes("answer") && firstProse(value) !== undefined ? "answer" : undefined;
};

/** `{ "reply": { "kind": … } }` and the like: the reply is the one object inside. */
const unwrap = (value: unknown, kinds: readonly ReplyKind[], depth = 2): unknown => {
	if (!isRecord(value) || depth === 0 || value.kind !== undefined || kinds.some(kind => value[LEAD[kind]] !== undefined)) return value;
	const inner = Object.values(value).map(unstring).find(isRecord);
	return inner === undefined ? value : unwrap(inner, kinds, depth - 1);
};

/**
 * The reply a model meant, in the shape the schema wants. Input that names no
 * kind this caller accepts comes back as it is, for validation to reject.
 */
export function repairReply(raw: unknown, rules: ReplyRules = {}): unknown {
	const kinds = rules.kinds ?? REPLY_KINDS;
	const value = unwrap(unstring(raw), kinds);
	if (!isRecord(value)) return raw;
	const kind = kindOf(value, kinds);
	if (!kind) return value;
	const lead = LEAD[kind];
	const schema = SCHEMAS[kind] as unknown as Node;
	// `"answer": { "answer": "…", "refs": "" }`: the reply nested in its own lead field.
	const inner = value[lead];
	const flat = isRecord(inner) ? { ...value, ...inner } : value;
	const repaired = { ...(repairObject(schema, lead in PROSE_LEADS ? withLead(flat, lead) : flat) as Record<string, unknown>), kind };
	if (kind === "change" && kinds.includes("answer")) return changeAsAnswer(flat, repaired) ?? repaired;
	return repaired;
}

/**
 * A change whose files cannot be made valid (none listed, or bare paths with
 * no word of what changed in each) but that says what happened in prose is
 * delivered as an answer: the prose first, then its checks and pending items,
 * and the paths as refs. Rejecting it cost a full request for a reply that
 * already said everything. With no prose it stays a change, and validation
 * names what is missing.
 */
const changeAsAnswer = (value: Record<string, unknown>, change: Record<string, unknown>): Record<string, unknown> | undefined => {
	const problems = replyProblems(change);
	if (!problems.length || !problems.every(problem => /files/u.test(problem))) return undefined;
	const prose = [firstProse(value), otherLead(value, "files"), value.explanation].find((item): item is string => typeof item === "string" && item.trim() !== "");
	const checks = Array.isArray(change.checks) ? (change.checks as { command: string; passed: boolean }[]).map(check => `${check.passed ? "✓" : "✗"} ${check.command}`) : [];
	const pending = Array.isArray(change.pending) ? (change.pending as string[]).map(item => `pending: ${item}`) : [];
	const lines = [prose?.trim(), ...checks, ...pending].filter((line): line is string => !!line);
	if (!lines.length) return undefined;
	const refs = repair(AnswerReplySchema.properties.refs as unknown as Node, value.files);
	return { ...(repairObject(AnswerReplySchema as unknown as Node, { answer: lines.join("\n"), refs }) as Record<string, unknown>), kind: "answer" };
};

/** The prose another kind's lead carries: a needs_input that wrote its question as `answer`. */
const otherLead = (value: Record<string, unknown>, lead: string): string | undefined =>
	Object.keys(PROSE_LEADS).filter(key => key !== lead).map(key => value[key]).find((item): item is string => typeof item === "string" && item.trim() !== "");

/** Kinds whose lead is prose, so it may arrive under another name. */
const PROSE_LEADS: Record<string, true> = { answer: true, cause: true, question: true, reason: true };

/**
 * A missing lead takes the prose the model put elsewhere: an alias such as
 * `text`, or, when that is all there is, the `explanation` itself (moved, not
 * copied, so it is not said twice).
 */
const withLead = (value: Record<string, unknown>, lead: string): Record<string, unknown> => {
	if (value[lead] !== undefined && !isRecord(value[lead])) return value;
	const alias = firstProse(value) ?? otherLead(value, lead);
	if (alias !== undefined) return { ...value, [lead]: alias };
	const { explanation, ...rest } = value;
	return typeof explanation === "string" && explanation.trim() ? { ...rest, [lead]: explanation } : { ...value, [lead]: undefined };
};

/** Every piece of prose in a value, in order, skipping the kind tag. */
const proseIn = (value: unknown): string[] =>
	typeof value === "string" ? [value.trim()].filter(Boolean)
	: Array.isArray(value) ? value.flatMap(proseIn)
	: isRecord(value) ? Object.entries(value).filter(([key]) => key !== "kind").flatMap(([, item]) => proseIn(item))
	: [];

/**
 * The last resort when a reply cannot be repaired: whatever prose it carries,
 * delivered as a plain answer so a model that cannot meet the schema still
 * ends its turn instead of retrying forever.
 */
export function salvageReply(raw: unknown): AnswerReply {
	const chars = [...(proseIn(unstring(raw)).join("\n\n") || "The reply arrived without any text.")];
	const answerMax = (AnswerReplySchema.properties.answer as { maxLength?: number }).maxLength ?? 2000;
	const explanationMax = (AnswerReplySchema.properties.explanation as { maxLength?: number }).maxLength ?? 4000;
	const answer = chars.slice(0, answerMax).join("").trim();
	const rest = chars.slice(answerMax, answerMax + explanationMax).join("").trim();
	return rest ? { kind: "answer", answer, refs: [], explanation: rest } : { kind: "answer", answer, refs: [] };
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
