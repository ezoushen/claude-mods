# mermaid-pane

Renders ```` ```mermaid ```` blocks from the conversation **inline** — the chart sits with the response that produced it. No pane, no state: two render modes and a mode-setting command.

## Commands

| Command | What it does |
| --- | --- |
| `/mermaid ascii` | Rewrite each mermaid fence in place as rendered ASCII art |
| `/mermaid image` | Keep the source; draw each chart as a real terminal PNG |
| `/mermaid` | Report the current mode and renderer availability |
| `/mermaid setup` | Install missing optional renderers (background, logged) |

The mode is remembered across sessions (durable store) and redraws open rows immediately (session state).

## Renderers (all optional)

| Renderer | What it improves | Install via `/mermaid setup` |
| --- | --- | --- |
| [`mermaid-ascii`](https://github.com/AlexanderGrooff/mermaid-ascii) | Better ASCII art (real graph layout vs the built-in edge list) | **prebuilt release download** — matched to `uname -s`/`uname -m` at install time, dropped into `~/.local/bin`. No compiler, no Python, nothing built from source (unsupported platforms log how to install manually) |
| [`@mermaid-js/mermaid-cli`](https://github.com/mermaid-js/mermaid-cli) (`mmdc`) | Offline PNG rendering (puppeteer fetches a prebuilt Chromium on first render) | `npm install -g @mermaid-js/mermaid-cli`, pinned to the Node major found (12.x needs ≥ 22.13, 11.x ≥ 18.19); nvm PATH handled |

Without them the mod still works everywhere: **edge-list art** (built in, always fits, never clips) for ascii, and **mermaid.ink + `curl` + `sips`** (macOS built-ins) for images. `/mermaid setup` detects what's missing, starts the installs detached (so the render hook never blocks on npm/pip), logs to `/tmp/mermaid-pane/setup.log`, and a re-run reports progress. New sessions pick renderers up automatically.

## Modes

- **ascii** — tiered mermaid-ascii spacing → built-in edge-list art → the source itself; text wraps, never clips.
- **image** — `mmdc -s 2` (no network) → mermaid.ink JPEG → `sips` → PNG, drawn as a native `Image` sized from the SVG's own viewBox; falls back to ascii art when a PNG can't be produced. Real pixels need a terminal Claude Code can paint images in (**kitty, Ghostty**); other terminals — including iTerm2/WezTerm — draw the alt-text art instead.

## Development

```sh
claude plugin validate ./mermaid-pane
claude plugin test ./mermaid-pane
claude --plugin-dir ./mermaid-pane
```
