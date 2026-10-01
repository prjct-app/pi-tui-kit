# pi-tui-kit

The one TUI every prjct Pi extension uses: minimal, consistent, and actionable.

Local only, never published to npm. Each extension depends on it as a sibling
checkout (`"@prjct.app/pi-tui-kit": "file:../pi-tui-kit"`) and bundles it into
its build; `~/Apps/pi/install-local.sh` builds the kit and installs everything.

## Rules

1. **Docked, not modal.** A panel takes the editor's place below the transcript.
   `esc` gives the editor back. Nothing floats over the conversation.
2. **List, then detail.** Every screen is a list of things with the selected
   one's facts and history beside it (below 90 columns: list → detail).
3. **Every screen is actionable.** Actions are one key, shown in the footer, and
   only when they apply. Destructive ones ask for the key again.
4. **Traceable.** The detail pane ends with sections for history, logs and ids,
   newest first.
5. **One line for modes.** Plan, fast, agents: each extension publishes with
   `setMode`, and the kit draws them together right above the editor. Live
   figures that are not modes (what the session cost) go on the same line with
   `setFact`, dim and right-aligned, so no extension adds a line of its own.
6. **Theme colors only.** `accent`, `success`, `warning`, `error`, `muted`,
   `dim`. No boxes, cards, backgrounds or progress art. Every state symbol is
   paired with a word.

| Symbol | Meaning |
| --- | --- |
| `●` | running, connected, live |
| `○` | idle, queued, disconnected |
| `✓` | finished well |
| `✕` | failed |
| `!` | needs the person |
| `◆` | a mode that is on |

## Keys (the same everywhere)

| Key | Action |
| --- | --- |
| `↑↓` `j` `k` | move |
| `enter` `→` | open the detail |
| `tab` | switch list / detail |
| `pgup` `pgdn` | scroll the detail |
| `/` | search |
| `?` | all keys, including the screen's actions |
| `esc` | back · clear search · close |
| `q` | close |

## Panel

```ts
import { openPanel, SYMBOL, ago } from "@prjct.app/pi-tui-kit";

await openPanel(ctx, {
  title: "MCP",
  summary: () => `${servers.length} servers`,
  items: () => servers.map(server => ({
    id: server.name,
    label: server.name,
    symbol: server.connected ? SYMBOL.active : SYMBOL.idle,
    tone: server.connected ? "success" : "muted",
    meta: server.connected ? `${server.tools} tools` : "not connected",
  })),
  detail: item => ({
    title: item.label,
    fields: [{ label: "url", value: urlOf(item.id) }],
    sections: [{ title: "Log", lines: logOf(item.id) }],
  }),
  actions: [
    { key: "c", label: "Connect", when: item => !!item, run: async (item, panel) => {
      await connect(item!.id);
      panel.notice(`${item!.label} connected`, "success");
    } },
    { key: "x", label: "Logout", confirm: true, run: item => logout(item!.id) },
  ],
  empty: "No servers. Add one to ~/.pi/agent/mcp.json.",
  subscribe: changed => onChange(changed),
});
```

An action that acts on the whole panel rather than the selected item (purge finished, stop all) sets `bulk: true`, so its confirm prompt does not name the selected item.

`panelText(spec)` renders the same data as plain text for print and RPC modes.

## Secret prompt

Use the shared docked prompt for API keys and tokens. It never renders the secret and validates inline; do not create modal overlays or browser setup flows.

```ts
import { openSecretPrompt } from "@prjct.app/pi-tui-kit";

const key = await openSecretPrompt(ctx, {
  title: "Global evaluator key",
  message: "Stored once for every project.",
  label: "key",
  validate: async value => await validateKey(value),
});
```

## Modes

```ts
import { setMode } from "@prjct.app/pi-tui-kit";

setMode(ctx, "plan", "plan 2/5"); // on
setMode(ctx, "plan", undefined);  // off
```

## Facts

A short live figure on the mode line's right, dim. It is not turned on or off by the person, so it carries no `◆`.

```ts
import { setFact } from "@prjct.app/pi-tui-kit";

setFact(ctx, "usage", "$0.05 session · $277.74 project");
setFact(ctx, "usage", undefined); // gone
```

## Argument repair

Models send near misses: `{ "label": "Sí" }` where a string belongs, `"3"` for 3, a single value where a list belongs, `Question` for `question`, a limit above its maximum, a field under another name, the whole call as a JSON string. Each one fails validation, and the model usually resends the same call.

One line in an extension's factory puts a schema-driven repair in front of Pi's validation for every tool it registers. It runs after the tool's own `prepareArguments`:

```ts
import { repairToolArgs } from "@prjct.app/pi-tui-kit";

repairToolArgs(pi, {
  team_message: { aliases: { body: ["message", "text"] }, synonyms: { answer: "info" }, truncate: true },
});
```

- **Shape only, never meaning.** A required field the model did not write stays missing, so validation still names it. Valid input comes back untouched.
- **`truncate`** cuts text over `maxLength` with a marker instead of refusing it. Turn it on only for reports and messages, never for content written to files.
- **Plain JSON Schema works too,** as MCP servers send it.
