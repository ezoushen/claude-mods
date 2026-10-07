# mermaid-pane

Renders ```` ```mermaid ```` blocks from the conversation **inline** — the chart sits with the response that produced it. No pane, no state: two render modes, an optional remote fallback, and a mode-setting command.

## Commands

| Command | What it does |
| --- | --- |
| `/mermaid ascii` | Rewrite each mermaid fence in place as rendered ASCII art |
| `/mermaid image` | Keep the source; draw each chart as a real terminal PNG (local mermaid-cli first) |
| `/mermaid external on` | **Opt in** to mermaid.ink when local PNG fails (sends full diagram source; persists) |
| `/mermaid external off` | Revoke remote rendering (default; persists). Image mode stays local-only |
| `/mermaid` | Report the current mode, external setting, and renderer availability |
| `/mermaid setup` | Install missing optional renderers (background, logged) |

Mode and the external opt-in are remembered across sessions (durable store). Image mode alone is **not** consent for remote rendering.

## Privacy: external rendering

**Default: OFF** for fresh installs and upgrades. A previously saved image mode does not enable mermaid.ink.

When external is ON and local mermaid-cli is missing, fails, times out, or produces unusable PNG metadata, the mod may request a PNG (and a small SVG sizing probe) from [mermaid.ink](https://mermaid.ink). Those requests encode the **full normalized diagram source** in the URL. Revoke anytime with `/mermaid external off` — permission is re-checked immediately before every network send (including pre-warm and retries).

ASCII mode never leaves the machine. Diagnostics never include diagram source, encoded URLs, or raw commands that embed them.

## Renderers (all optional)

| Renderer | What it improves | Install via `/mermaid setup` |
| --- | --- | --- |
| [`termaid`](https://github.com/fasouto/termaid) | Better ASCII art across many Mermaid diagram types (flowchart, sequence, class, ER, state, gantt, mindmap, …) vs the built-in edge list | `pip install --user termaid` (Python ≥ 3.9); console script linked into `~/.local/bin` |
| [`@mermaid-js/mermaid-cli`](https://github.com/mermaid-js/mermaid-cli) (`mmdc`) | Offline PNG rendering (puppeteer fetches a prebuilt Chromium on first render) | `npm install -g @mermaid-js/mermaid-cli`, pinned to the Node major found (12.x needs ≥ 22.13, 11.x ≥ 18.19); nvm PATH handled |

Without them the mod still works everywhere: **edge-list art** (built in, always fits, never clips) for ascii, and — only if you `/mermaid external on` — **mermaid.ink + `curl` + `sips`** for images. `/mermaid setup` detects what's missing, starts the installs detached (so the render hook never blocks on pip/npm), logs to `/tmp/mermaid-pane/setup.log`, and a re-run reports progress. New sessions pick renderers up automatically.

## Modes

- **ascii** — termaid (`--width`, which compacts gaps itself) → built-in edge-list art when termaid's art is still wider than the reply → the source itself; text wraps, never clips. Always local.
- **image** — local `mmdc -s 2` (bounded duration, no network) → optional mermaid.ink (opt-in) → `sips` → PNG, drawn as a native `Image` sized from the SVG's own viewBox when remote sizing is allowed; otherwise a fixed native width. Falls back to ascii art with a short actionable note when a PNG can't be produced; a failed chart is retried after a minute, and overlapping redraws share one render. Real pixels need a terminal Claude Code can paint images in (**kitty, Ghostty**); other terminals — including iTerm2/WezTerm — draw the alt-text art instead.

## Development

```sh
claude plugin validate ./mermaid-pane
claude plugin test ./mermaid-pane
claude --plugin-dir ./mermaid-pane
```
