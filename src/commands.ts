import type { AutocompleteItem } from "@earendil-works/pi-tui";

/** Every prjct command says who it belongs to, in the command list and in completions. */
export const BRAND = "p";

/** "p · subagents: on | off | panel" */
export const brand = (text: string): string => `${BRAND} · ${text}`;

/** One completion: a word, what it does, and optionally the words that can follow it. */
export type CommandOption = {
	value: string;
	description: string;
	options?: readonly CommandOption[] | (() => readonly CommandOption[]);
};

const list = (options: CommandOption["options"]): readonly CommandOption[] =>
	typeof options === "function" ? options() : options ?? [];

/**
 * Argument completions for a command, from a tree of options. Every level is
 * offered, so typing `/mcp ` lists the actions and `/mcp connect ` lists the
 * servers. Each item carries its description with the prjct mark.
 */
export function completer(options: readonly CommandOption[] | (() => readonly CommandOption[])) {
	return (prefix: string): AutocompleteItem[] | null => {
		const words = prefix.split(/\s+/);
		const partial = words.pop() ?? "";
		let level = typeof options === "function" ? options() : options;
		const path: string[] = [];
		for (const word of words.filter(Boolean)) {
			const found = level.find(option => option.value === word);
			if (!found) return null;
			path.push(word);
			level = list(found.options);
		}
		const items = level
			.filter(option => option.value.toLowerCase().startsWith(partial.toLowerCase()))
			.map(option => ({ value: [...path, option.value].join(" "), label: option.value, description: brand(option.description) }));
		return items.length ? items : null;
	};
}

/** On/off modes all complete the same way. */
export const ON_OFF = (what: string): CommandOption[] => [
	{ value: "on", description: `turn ${what} on` },
	{ value: "off", description: `turn ${what} off` },
];
