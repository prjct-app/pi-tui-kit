import type { TSchema } from "typebox";
import { Value } from "typebox/value";

/** Lossless schema normalization. Pi validates unresolved errors and the model
 * decides how to correct them. Never discard evidence to make a call validate. */

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
	/** @deprecated Ignored. Oversized text is preserved for native validation. */
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
	if (isRecord(value) && Object.keys(value).length === 1) {
		for (const key of TEXT_KEYS) if (typeof value[key] === "string" || typeof value[key] === "number") return String(value[key]);
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

function enumValue(node: Node, value: unknown, options: RepairOptions): unknown {
	const allowed = node.enum ?? (node.const !== undefined ? [node.const] : undefined);
	if (!allowed || allowed.includes(value)) return value;
	const text = asText(value)?.trim();
	if (text === undefined) return value;
	const lower = text.toLowerCase();
	const exact = allowed.find(item => typeof item === "string" && item.toLowerCase() === lower);
	if (exact !== undefined) return exact;
	const explicit = options.synonyms?.[lower];
	return explicit !== undefined && allowed.includes(explicit) ? explicit : value;
}

function fix(node: Node, raw: unknown, options: RepairOptions, depth: number): unknown {
	if (depth > 12) return raw;
	const value = types(node).includes("string") ? raw : unstring(raw);
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

			return text;
		}
		case "number":
		case "integer": {
			// Parse only the entire numeric string. Ranges, units, fractions and
			// out-of-range values must not be rounded or clamped behind the model.
			return typeof value === "string" && /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/iu.test(value.trim())
				&& Number.isFinite(Number(value)) ? Number(value) : value;
		}
		case "boolean": {
			if (value === 0 || value === 1) return value === 1;
			if (typeof value !== "string") return value;
			const word = value.trim().toLowerCase();
			return ["true", "yes", "y", "1", "on"].includes(word) ? true : ["false", "no", "n", "0", "off"].includes(word) ? false : value;
		}
		case "array": {
			const inner = listInside(value);
			const list = inner === undefined ? undefined
				: inner === null ? undefined : Array.isArray(inner) ? inner : [inner];
			if (list === undefined) return value;
			const items = node.items ? list.map(item => fix(node.items!, item, options, depth + 1)) : list;
			return items;
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
		out[key] = repaired;
	}
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

/** Normalize representation without inventing, clipping or deleting information. */
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
