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
   `setMode`, and p-ui draws them together below the editor.
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
