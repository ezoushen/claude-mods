---
name: claude-code-mod-dev
description: Build, test, and share a Claude Code mod — a plugin whose behavior lives in a JavaScript/TypeScript hooks module. Use when the user wants to create a mod, customize Claude Code's behavior or UI (guard a command, add a status band, open a pane, register a slash command), fix or test an existing mod, or asks about the mods API ($, on, register, hooks.json).
---

# Developing a Claude Code Mod

A **mod** is a Claude Code plugin whose behavior lives in a hooks module: one `register(on)` entry that hooks engine events as functions `($, e, next)`. Requires Claude Code **2.1.287 or later**. Full API surface (events, `$` nouns, environment rules): see [REFERENCE.md](REFERENCE.md).

## 0. Confirm the environment

Run `claude --version`. If it is older than 2.1.287, stop and tell the user mods are unavailable.

**Done when:** the version is confirmed and printed in your reply.

## 1. Scaffold the plugin folder

A mod folder is a complete plugin. Create:

```text
<mod-name>/
├── .claude-plugin/
│   └── plugin.json        # { "name": "<mod-name>", "version": "0.1.0", "description": "...", "author": { "name": "..." } }
├── hooks/
│   ├── hooks.json         # { "modules": ["./<mod-name>.mjs"] }  (or ./register.ts)
│   └── <mod-name>.mjs     # the hooks module
├── types/
│   └── index.d.ts         # the type contract (only if the module uses $.state)
└── tests/
    └── <mod-name>.test.ts
```

Rules that trip people up:

- `plugin.json` goes in `.claude-plugin/`; component directories (`hooks/`, `tests/`) sit at the plugin root, **not** inside `.claude-plugin/`.
- `hooks/hooks.json` names exactly one module under `modules`.
- The module runs in its own sandbox: **no DOM, no Node** — no `fs`, `process`, or `require`. Every file is an ES module regardless of suffix; files without a `.ts/.tsx/.js/.jsx/.mjs/.cjs/.mts/.cts` suffix are not loaded. Reach the outside world only through `$`.

**Done when:** the four files exist and `plugin.json` parses.

## 2. Write the hooks module

The module exports `register(on)`. Inside, `on(event, matcher?, hook)` adds a hook of shape `($, e, next) => …`, where:

- `$` — the mods API (see REFERENCE.md for every noun)
- `e` — the event's input, plain data
- `next(e)` — passes the event down the hook chain, finally to Claude Code itself

Hooks are middleware. Every hook does one of three moves:

| Move | How | Example |
| --- | --- | --- |
| **Observe** | `const r = await next(e); /* look */ return r` | record every file edit |
| **Rewrite** | `return next({ ...e, command: safer })` | sanitize a command |
| **Answer** | `return { deny: "…" }` without calling `next` | refuse a tool call; serve a command yourself |

```js
export function register(on) {
  on("tool.call", { tool: "Bash" }, async ($, e, next) => {
    if (isRisky(e.command)) return { deny: "Held: " + e.command };
    return next(e);
  });
}
```

Match the design to the request: a UI band hooks `ui.render { component: "AbovePrompt" }`; a guard hooks `tool.call`; a slash command pairs `session.start` (register via `$.command.register`) with `command.run`; panes come from `$.ui.open`. Pick events from the table in REFERENCE.md — hook the narrowest matcher that works (`{ tool: "Bash" }`, `{ component: "AbovePrompt" }`).

**Done when:** every behavior the user asked for maps to a named event and a move, and the module exports `register`.

## 3. Keep state in `$.state`

Module-level variables reset on every hot reload (each save re-runs `register` and re-fires `session.start`). Persist across reloads with `$.state`:

```js
const readings = { plugin: "token-weather", key: "readings" };
const { value: history = [] } = await $.state.get(readings);
await $.state.set(readings, [...history, entry].slice(-12));
```

Every state key must be declared in a **type contract** — `types/index.d.ts` with `declare module "claude-code" { interface PluginState { "<plugin>": { <key>: T } } }` — and the manifest needs `"types": "./types/index.d.ts"`. `claude plugin validate` refuses undeclared keys.

Bonus: a `$.state.get` inside a render hook subscribes that drawing — later `$.state.set` redraws it for free. Never call `$.ui.invalidate` for this.

**Done when:** any value that must survive a reload lives in `$.state`, its key is declared in the contract, and the manifest names the contract.

## 4. Validate, test, and run

```sh
claude plugin validate ./<mod-name>   # manifest + module static analysis
claude plugin test ./<mod-name>       # runs tests/*.test.ts against the real runtime
claude --plugin-dir ./<mod-name>      # loads the mod with hot reload
```

Test shape — hooks registered with `on` in a test stub what Claude Code would answer *beneath* the mod:

```ts
import { describe, expect, test } from "claude-code/testing";

describe("<mod-name>", () => {
  test("guard refuses the risky call", async ($, on) => {
    on("tool.call", () => ({ result: "ran" }));          // stub the world beneath
    const outcome = await $.tool.call({ tool: "Bash", command: "git push --force" });
    expect(outcome).toEqual({ deny: expect.stringContaining("Held") });
  });
});
```

While the session runs: every save hot-reloads in place. When a drawing doesn't appear, run `claude --debug` and look for a line saying a hook returned a tree that does not validate.

**Done when:** `claude plugin validate` passes, tests pass, and the mod is visible in a `claude --plugin-dir` session.

## 5. Share it

A mod is a plugin — it ships in a marketplace, which can be a folder with `.claude-plugin/marketplace.json` listing the plugin. For a repo-based marketplace:

```sh
/plugin marketplace add <org>/<repo>
/plugin install <mod-name>@<repo>
/reload-plugins
```

A session-built mod (Claude wrote it live) lives only in that session; copy the folder out and install it like any plugin to keep it.

**Done when:** the install path for the user's situation is stated (or executed), or the mod folder is handed over as a complete plugin.

## Habits worth keeping

- **Lean on the generated types.** Each load, Claude Code writes the declarations for its build into `.claude-plugin/types/` — the authority for every event, `$` method, and element prop. Point the editor at them.
- **Read component props from `e.props`** (`hasSurvey`, `bodyColumns`, …), not from `e` top-level. Only `e.component`, `e.surface`, `e.requestId`, `e.viewport` sit at the top level.
- **Pass when you have nothing to draw**: return `next(e)` so other mods and the engine keep the surface.
- **Use single-width symbols, not emoji** (☀ ☁ ☂ ↯) — they line up in every terminal font.
- **A hook gets 10 seconds** of its own time per dispatch; time spent waiting inside a `$` call doesn't count.
- **A guard is a safety net, not a permission system** — it reads command text, so aliases and wrappers get past it. Say so in the mod's description.

## The shortcut: describe, don't code

If the user just wants a working mod, describe it instead of hand-writing it: start `claude` and paste a prompt naming the mod, exactly what it shows/does on each event, and when it updates. Claude writes the plugin, hot-reloads it, and iterates on "make Storm start at 70%"-style tweaks. Offer this when the mod is small and self-contained; hand-write when the user wants to review, test, or evolve the code.
