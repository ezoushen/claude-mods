# Rendering Mermaid diagrams in a TUI — and what a Claude Code mod can do

Researched 2026-10-05 for the `mermaid-pane` mod. Local evidence: generated mod API types at
`mermaid-pane/.claude-plugin/types/claude-code/index.d.ts` (written by Claude Code 2.1.289 on first mod load —
the authoritative surface).

## How TUIs render mermaid today (ecosystem)

Three tiers, from richest to most portable:

### 1. Inline images via terminal graphics protocols
Render mermaid → PNG (usually `mmdc`, mermaid-cli: Node + headless Chromium), then emit the picture through a
terminal image protocol: **Kitty Graphics** (`APC ESC_G`; kitty, Ghostty, WezTerm), **iTerm2 Inline Images**
(`OSC 1337`; iTerm2, WezTerm, Ghostty, mintty), or **DEC Sixel**. Tools built this way: [mermaidcat]
(https://github.com/zhengbuqian/mermaidcat), [mermkit](https://mermaidkit.github.io/mermkit/),
[golang-mermaid](https://pkg.go.dev/github.com/smford/golang-mermaid). Best quality; needs a graphics-capable
terminal and a local `mmdc`.

### 2. ASCII / Unicode art
Native ASCII backends reimplement Mermaid parsers — none track official Mermaid 1:1. Options surveyed:

- [termaid](https://github.com/fasouto/termaid) (Python; 18 diagram types; `pip install termaid`; `--width`
  auto-fit) — **current mermaid-pane ascii backend**
- [AlexanderGrooff/mermaid-ascii](https://github.com/AlexanderGrooff/mermaid-ascii) (Go; flowchart, sequence,
  ER; prebuilt release binary; earlier mermaid-pane backend)
- [pgavlin/mermaid-ascii](https://github.com/pgavlin/mermaid-ascii) (fork claiming 22 types; no releases as of
  2026-10)
- [termiflow](https://github.com/dnvt/termiflow), [mermaidtui](https://github.com/tariqshams/mermaidtui),
  [beautiful-mermaid](https://github.com/lukilabs/beautiful-mermaid), [merslim](https://www.npmjs.com/package/merslim)

Works in any terminal, any multiplexer, scrollback-safe. For true full Mermaid coverage, use official
`mmdc`/mermaid.ink (image mode) rather than a native ASCII reimplementation.

### 3. Service renderers / browser handoff
[mermaid.ink](https://mermaid.ink) — verified 2026-10-05: `GET /svg/<base64url of {code, mermaid:{theme}}>` →
`image/svg+xml`; `GET /img/<same>` → 200 raster (**JPEG**, 207×70 for a two-node graph — not PNG). Kroki is an
alternative. Opening the SVG URL in a browser (`open` on macOS) is the zero-dependency fallback.

## Can a Claude Code mod do it? Yes — three surfaces, per the generated types

The terminal surface's element table (`Elements[...]`, index.d.ts ~line 3700) includes **`Raster`** and
**`Image`** beside `Box`/`Text`/`Button`/`Link`/`Code`/`Markdown`:

- **`Image`** (index.d.ts:5127): `source` is `{ png: base64 }`, `{ file, format: 'png' }` (file read and decoded
  **by the terminal itself** — "no pixel crosses `$`"), `{ rgba|rgb, width, height }`, or `{ shm, ... }`; plus
  `columns` (1–255), `rows` (1–255), required `alt`. Where images can't draw, `alt` shows dim. So a mod CAN
  present a real diagram inline — on graphics-capable terminals.
  - Constraint: `format: 'png'` only. mermaid.ink's raster endpoint serves JPEG → needs a `sips` (macOS) or
    `mmdc` conversion to PNG before drawing.
- **`Raster`** (index.d.ts:8746): pure cell grid — base64 `columns*rows` u32 triplets `[codePoint, fg, bg]`,
  code points may be box-drawing/braille. Works in ANY terminal (no protocol), ideal for Unicode diagram art.
- **`Text`/`Box`**: ASCII-art lines — the always-works tier.

Render-hook rules that shape the design (index.d.ts:3869–3876): `ui.render` is per (props, viewport) and must
stay pure — `state.set` while drawing is refused by the host; writes belong in handlers/other events, and a
state write the drawing read triggers the redraw itself.

## Verdict for the `mermaid-pane` mod

Layered, degrade-gracefully:

| Tier | Mechanism | Works in |
| --- | --- | --- |
| 1 | `mmdc` → PNG → `Image { file }` | graphics terminals, offline, if Node present |
| 2 | mermaid.ink JPEG → `sips` → PNG → `Image { file }` | graphics terminals, online |
| 3 | in-pane Unicode art (built-in flowchart renderer) + `Open ↗` button (mermaid.ink SVG) | **any terminal, incl. herdr** |

**Key E2E constraint:** the verification pane runs under `TERM_PROGRAM=herdr` (text-scraping multiplexer,
`TERM=xterm-256color`) — inline-image escape sequences will not be verifiable (or may not render at all)
through `herdr agent read`. The E2E-visible path is Tier 3 text rendering; Tiers 1–2 are enhancements for
real graphics terminals. Tier 3 uses termaid when installed, else a built-in minimal flowchart→Unicode
renderer (nodes + `──▶` edges).

### Sources

- https://github.com/fasouto/termaid (18 diagram types; `--width` / `--gap` CLI)
- https://github.com/AlexanderGrooff/mermaid-ascii (earlier backend; flowchart/sequence/ER)
- https://github.com/zhengbuqian/mermaidcat (mmdc→PNG→IIP/chafa pipeline)
- https://mermaidkit.github.io/mermkit/ (engine registry: mmdc, ascii, inline images)
- https://pkg.go.dev/github.com/smford/golang-mermaid (protocol matrix: kitty/iTerm2/sixel)
- https://github.com/dnvt/termiflow , https://github.com/tariqshams/mermaidtui (ASCII renderers)
- https://mermaid.ink (`/svg/`, `/img/` endpoints; content types verified by request)
- `mermaid-pane/.claude-plugin/types/claude-code/index.d.ts` (Image:5127, Raster:8746, ElementConstructor:3682,
  ui.render contract:3869)
