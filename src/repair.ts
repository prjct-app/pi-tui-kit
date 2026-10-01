import type { TSchema } from "typebox";
import { Value } from "typebox/value";

/**
 * Arguments in the shape a tool's schema wants, from the near misses models
 * send: `{ "label": "Sí" }` where a string belongs, `"3"` for 3, a single
 * value where a list belongs, `"Open"` for `open`, a limit above its maximum,
 * extra fields, the whole thing as a JSON string. A model that gets a
 * validation error for one of these usually resends the same call, so each
 * near miss is a failed request, often several.
 *
 * Only the shape is fixed, never the meaning: a required field the model did
 * not write stays missing, so validation still names it. Valid input is
 * returned untouched.
 */

/** The JSON Schema subset TypeBox and MCP servers produce. */
type Node = {
	type?: string | string[];
	properties?: Record<string, Node>;
	required?: string[];
	additionalProperties?: boolean | Node;
	items?: Node;
	enum?: unknown[];
	const?: unknown;
	anyOf?: Node[];
	oneOf?: Node[];
	minimum?: number;
	maximum?: number;
	exclusiveMinimum?: number;
	exclusiveMaximum?: number;
	maxLength?: number;
	maxItems?: number;
};

export type RepairOptions = {
	/** Field → other names models use for it: `{ body: ["message", "text"] }`. */
	readonly aliases?: Readonly<Record<string, readonly string[]>>;
	/** Words models use for an enum value, by the value they mean: `{ answer: "info" }`. */
	readonly synonyms?: Readonly<Record<string, string>>;
	/** Cut strings over maxLength (with a marker) instead of letting validation refuse them. For reports and messages, never for content written to files. */
	readonly truncate?: boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** JSON a model sent inside a string, parsed; anything else unchanged. */
const unstring = (value: unknown): unknown => {
	if (typeof value !== "string" || !/^\s*[[{]/u.test(value)) return value;
	try { return JSON.parse(value); } catch { return value; }
};

const types = (node: Node): string[] => (Array.isArray(node.type) ? node.type : node.type ? [node.type] : []);

/** What models put where a single string belongs. */
const TEXT_KEYS = ["label", "text", "value", "name", "title", "option", "item", "content", "message"];
const asText = (value: unknown): string | undefined => {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (isRecord(value)) {
		for (const key of TEXT_KEYS) if (typeof value[key] === "string" || typeof value[key] === "number") return String(value[key]);
		const parts = Object.values(value).filter((item): item is string | number => typeof item === "string" || typeof item === "number");
		if (parts.length) return parts.join(" — ");
	}
	return undefined;
};

/** `{ "item": [...] }` and `{ "items": { "item": [...] } }`: a list wrapped in one-key objects. */
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

const EMPTY = new Set(["", "none", "n/a", "na", "null", "nil", "-", "[]"]);

/** Words models use for common enum values everywhere, by the value they mean; a tool's own synonyms win. */
const SYNONYMS: Readonly<Record<string, string>> = {
	added: "created", add: "created", new: "created", create: "created",
	updated: "modified", update: "modified", modify: "modified", changed: "modified", edited: "modified", edit: "modified",
	removed: "deleted", remove: "deleted", delete: "deleted",
	true: "yes", false: "no", met: "yes", "not met": "no", partial: "unknown", partially: "unknown", unclear: "unknown",
};
const MARK = "… [truncated]";

function enumValue(node: Node, value: unknown, options: RepairOptions): unknown {
	const allowed = node.enum ?? (node.const !== undefined ? [node.const] : undefined);
	if (!allowed || allowed.includes(value)) return value;
	const text = asText(value)?.trim();
	if (text === undefined) return value;
	const lower = text.toLowerCase();
	const exact = allowed.find(item => typeof item === "string" && item.toLowerCase() === lower);
	if (exact !== undefined) return exact;
	for (const meant of [options.synonyms?.[lower], SYNONYMS[lower]]) if (meant !== undefined && allowed.includes(meant)) return meant;
	const loose = allowed.find(item => typeof item === "string" && item.toLowerCase().replace(/[\s_-]/gu, "") === lower.replace(/[\s_-]/gu, ""));
	return loose ?? value;
}

function fix(node: Node, raw: unknown, options: RepairOptions, depth: number): unknown {
	if (depth > 12) return raw;
	const value = unstring(raw);
	const branches = node.anyOf ?? node.oneOf;
	if (branches) return union(branches, value, options, depth);
	if (node.enum || node.const !== undefined) return enumValue(node, value, options);
	const kinds = types(node);
	if (kinds.includes("null") && value === null) return value;
	const kind = kinds.find(name => name !== "null");
	switch (kind) {
		case "string": {
			const text = asText(value) ?? (Array.isArray(value) && value.every(item => typeof item === "string") ? value.join("\n") : undefined);
			if (text === undefined) return value;
			if (options.truncate && node.maxLength !== undefined && text.length > node.maxLength) {
				return text.slice(0, Math.max(0, node.maxLength - MARK.length)) + MARK;
			}
			return text;
		}
		case "number":
		case "integer": {
			const leading = typeof value === "string" ? /^\s*(-?\d+(?:\.\d+)?)/u.exec(value) : null;
			const number = typeof value === "number" ? value
				: typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value)
					: kind === "integer" && leading ? Number(leading[1]) : undefined;
			if (number === undefined) return value;
			const whole = kind === "integer" ? Math.round(number) : number;
			const low = node.minimum ?? (node.exclusiveMinimum !== undefined ? node.exclusiveMinimum + (kind === "integer" ? 1 : Number.EPSILON) : undefined);
			const high = node.maximum ?? (node.exclusiveMaximum !== undefined ? node.exclusiveMaximum - (kind === "integer" ? 1 : Number.EPSILON) : undefined);
			return Math.min(high ?? Infinity, Math.max(low ?? -Infinity, whole));
		}
		case "boolean": {
			if (typeof value === "number") return value !== 0;
			if (typeof value !== "string") return value;
			const word = value.trim().toLowerCase();
			return ["true", "yes", "y", "1", "on"].includes(word) ? true : ["false", "no", "n", "0", "off"].includes(word) ? false : value;
		}
		case "array": {
			const inner = listInside(value);
			const list = inner === undefined ? undefined
				: inner === null || (typeof inner === "string" && EMPTY.has(inner.trim().toLowerCase())) ? []
					: Array.isArray(inner) ? inner : [inner];
			if (list === undefined) return value;
			const items = node.items ? list.map(item => fix(node.items!, item, options, depth + 1)) : list;
			return node.maxItems !== undefined ? items.slice(0, node.maxItems) : items;
		}
		case "object": return object(node, value, options, depth);
		default: return value;
	}
}

function object(node: Node, value: unknown, options: RepairOptions, depth: number): unknown {
	if (!isRecord(value)) {
		// A bare string where an object with one required text field belongs.
		const first = (node.required ?? []).find(key => types(node.properties?.[key] ?? {}).includes("string"));
		const text = typeof value === "string" ? value : undefined;
		return first && text !== undefined && (node.required ?? []).length === 1 ? { [first]: text } : value;
	}
	const properties = node.properties ?? {};
	const out: Record<string, unknown> = {};
	const taken = new Set<string>();
	for (const [key, child] of Object.entries(properties)) {
		const alias = value[key] === undefined ? options.aliases?.[key]?.find(name => value[name] !== undefined && properties[name] === undefined) : undefined;
		if (alias) taken.add(alias);
		const source = alias ? value[alias] : value[key];
		if (source === undefined) continue;
		const repaired = fix(child, source, options, depth + 1);
		const optional = !(node.required ?? []).includes(key);
		// An optional field that is empty or still off its schema is dropped instead of failing the call.
		const empty = repaired === null || repaired === "" || (Array.isArray(repaired) && repaired.length === 0);
		if (optional && empty && !Value.Check(child as TSchema, repaired)) continue;
		out[key] = repaired;
	}
	// A required list the model left out is an empty list, not a failed call: nothing is invented.
	for (const key of node.required ?? []) {
		if (out[key] === undefined && value[key] === undefined && types(properties[key] ?? {}).includes("array") && Value.Check(properties[key] as TSchema, [])) out[key] = [];
	}
	if (node.additionalProperties === false) return out;
	// Fields the schema does not declare: kept, and repaired when it says what they must be.
	const extra = isRecord(node.additionalProperties) ? node.additionalProperties : undefined;
	for (const [key, item] of Object.entries(value)) {
		if (key in properties || taken.has(key)) continue;
		out[key] = extra ? fix(extra, item, options, depth + 1) : item;
	}
	return out;
}

/** A union: the branch the value names (a `kind`-like literal), else the first the repaired value satisfies. */
function union(branches: readonly Node[], value: unknown, options: RepairOptions, depth: number): unknown {
	for (const branch of branches) if (Value.Check(branch as TSchema, value)) return value;
	if (isRecord(value)) {
		for (const branch of branches) {
			const tags = Object.entries(branch.properties ?? {}).filter(([, child]) => child.const !== undefined);
			if (tags.length && tags.every(([key, child]) => enumValue(child, value[key], options) === child.const)) return fix(branch, value, options, depth + 1);
		}
	}
	for (const branch of branches) {
		const repaired = fix(branch, value, options, depth + 1);
		if (Value.Check(branch as TSchema, repaired)) return repaired;
	}
	return value;
}

/** The arguments a tool meant, in its schema's shape. Valid input comes back as it is. */
export function repairArgs(schema: TSchema | object, raw: unknown, options: RepairOptions = {}): unknown {
	try {
		if (Value.Check(schema as TSchema, raw)) return raw;
	} catch { /* a schema TypeBox cannot check (some MCP servers): repair anyway */ }
	return fix(schema as Node, raw, options, 0);
}

type ToolLike = { name: string; parameters?: unknown; prepareArguments?: (raw: unknown) => unknown };
type Registrar = { registerTool: (tool: never) => unknown };

/**
 * Every tool this extension registers gets the repair in front of Pi's
 * validation, after the tool's own prepareArguments. One line in an extension's
 * factory: `repairToolArgs(pi)`; per-tool options by tool name.
 */
export function repairToolArgs<T extends Registrar>(pi: T, perTool: Readonly<Record<string, RepairOptions>> = {}): T {
	const register = pi.registerTool.bind(pi) as (tool: ToolLike) => unknown;
	const wrapped = (tool: ToolLike) => {
		if (!tool?.parameters) return register(tool);
		const own = tool.prepareArguments;
		const options = perTool[tool.name] ?? {};
		return register({
			...tool,
			// The tool's own repair knows its domain (reply kinds, aliases) and runs first.
			prepareArguments: (raw: unknown) => repairArgs(tool.parameters as object, own ? own(raw) : raw, options),
		});
	};
	try {
		(pi as unknown as { registerTool: (tool: ToolLike) => unknown }).registerTool = wrapped;
	} catch { /* a frozen API keeps Pi's own validation only */ }
	return pi;
}
