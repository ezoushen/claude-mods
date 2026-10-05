# Claude Code Mods — API Reference

Source of truth: the type declarations Claude Code writes into your mod's `.claude-plugin/types/` folder on each load. The tables below summarize the surface as shipped (verified against `mods/types/claude-code.d.ts` in `anthropics/claude-code`).

## `$` — the nouns

Every noun is an async namespace; calls go through `$` because the sandbox has no DOM and no Node.

| Noun | What it gives the mod |
| --- | --- |
| `$.plugin` | This plugin's own identity (`name`, `root`) |
| `$.ui` | `resolve(e)` (element constructors for the surface being drawn), `open` (open a pane), `toast`, `status`, `log`, `blit`, `invalidate` |
| `$.model` | `complete(request)`, `classify(text, labels, options)`, `fork(request)` |
| `$.audio` | `play(clip, …)`, `speak(text, { voice })` |
| `$.mcp` | `call(server, tool, args)` |
| `$.session` | `usage()` (context tokens / window / percent — same figures as the status line), `cwd()`, `root()`, `model()`, `turns()` |
| `$.turn` | turn-level queries |
| `$.prompt` | prompt inspection and suggestion |
| `$.tool` | `check` — run the permission chain for a hypothetical call, executing nothing |
| `$.command` | `register({ name, description })`, `run` |
| `$.config`, `$.settings`, `$.env` | configuration, settings, environment |
| `$.agent` | `list()`, `spawn(...)` — a plugin spawn always runs in the background |
| `$.fs` | `read` (and friends) — the only way to touch files |
| `$.store` | durable key/value storage (across sessions) |
| `$.state` | named values held by the host for the session — **survives hot reload**; keys must be declared in the plugin's type contract |
| `$.clock` | `sleep`, `after`, `every` — time inside `$` calls doesn't count against a hook's 10s limit |
| `$.http` | network access |
| `$.process` | `run(argv)` — argv array, never shell-interpolated |
| `$.telemetry` | (when present) `log`, `mark` |

## Events worth hooking

Engine events (hook with `on(name, matcher?, ($, e, next) => …)`):

| Event | Fires when | Typical move |
| --- | --- | --- |
| `tool.call` | engine is about to run a tool; matcher `{ tool: "Bash" }` narrows `e` so `e.command` is a string | deny / rewrite / observe; `next(e)` runs permission prompt + tool |
| `tool.check` | permission decision, after `tool.call` hooks and before the mode settles an ask | return `{ decision: "allow" \| … }`; executes nothing |
| `ui.render` | a component is about to be drawn; matcher `{ component: "AbovePrompt" }` or `"Pane"` | return an element tree; an invalid tree draws the engine's own |
| `ui.resolve` | plugins load, once per surface/component/plugin | restyle or restructure the element table |
| `session.start` | session start (and again on every hot reload) | register commands, take initial readings; always `await next(e)` first |
| `turn.start` / `turn.complete` | each model turn; `e.agentId` present means a subagent loop | bracket work into per-turn groups; main-loop only via `if (!e.agentId)` |
| `prompt.submit` | the prompt as submitted | rewrite or annotate the prompt |
| `command.run` | a registered slash command is invoked | answer with `{ text }` |
| `engine.create` | the engine is being built | add a new `$` noun (own the noun's types in `types/index.d.ts`) |

Op events mirror every `$` call (`session.cwd`, `session.usage`, `process.run`, `ui.open`, `state.get`, …) — a test hooks them to stub the world beneath the mod, and an unanswered stubbed call throws naming its event.

## Hook chain semantics

- Hooks form middleware: your hook runs, `next(e)` hands the event to the next plugin, and at the bottom Claude Code does what it would have done anyway.
- A hook that returns while its `next` is still pending **aborts** what runs beneath.
- `next.origin` names the plugin whose hook frame caused the dispatch; `e.agentId` names the loop (absent on the main loop). These are different axes.
- Matcher pins are enforced: a rewrite of a pinned field is refused.

## Testing kit (`claude-code/testing`)

- Imports: `describe, expect, test, tier, mock` from `claude-code/testing`.
- `tier('user' | 'builtin' | …)` sets the tier the mod loads in.
- `on(event, hook)` in a test registers beneath the mod — stub what the engine would answer: `on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }))`.
- `mock.env(on, vars)`, `mock.store(on, entries)`, `mock.clock(on)` (with `clock.advance(ms)` / `clock.settle()` for timed waits) answer the world from memory.
- Drive the mod through `$` itself: `await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })`, `await $.tool.call({...})`, `await $.command.run({ command: 'diff', args: '', origin: { kind: 'composer' } })`, `$.ui.press({ plugin, key })` to click a rendered `Button`.
- Mount and assert on UI: `const ui = await $.ui.mount({ plugin, surface, component, props }); expect(await ui.find({ type: 'Text', text: /…/ })).toBeDefined();`

## Type contracts

- **State contract**: `types/index.d.ts` declaring `interface PluginState { "<plugin>": { <key>: T } }`, referenced as `"types": "./types/index.d.ts"` in `plugin.json`. Required for every `$.state` key; `claude plugin validate` enforces it.
- **Noun contract** (mods that add a `$` noun in `engine.create`): a declaration file with no imports, exporting the noun's types named for the noun, and `declare module "claude-code" { interface EngineInterface { <noun>: T } }`. The only declaration of the noun — other mods import from it, never copy it.

## Element drawing

- `const { Box, Text } = $.ui.resolve(e)` returns the constructors for the surface being drawn (each surface supports a slightly different set). JSX works too, with `h` as the factory.
- Components seen in render hooks: `AbovePrompt` (the band above the prompt), `Pane` (docked beside the transcript; falls back inline above the prompt when narrow), `Button` (`{ label, hotkey, onPress }` — clickable, keyboard-navigable, or hotkey).
- A pane opened with `$.ui.open({ id, title, focus: true })` answers `isPlaced: false` when the terminal is too narrow — degrade to the `AbovePrompt` band.
- Trees must validate against the surface's element table; a non-validating tree silently draws the engine's own (visible in `claude --debug` output).
