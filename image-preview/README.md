# image-preview

Inline image previews for Claude Code, like the desktop GUI app.

- **Chat rows** (user and agent messages): every image path or `[Image #N]`
  token draws a thumbnail, aspect-fit, never taller than 10 rows.
- **Prompt editor**: the current draft's image references draw a square strip
  above the input box (1:1 aspect-fill, max 4 rows), updated as you type.
- `/image <path...>` stores paths; reference them as `[Image #N]`.
- **Pasted images**: Claude Code inserts an `[Image #N]` token for a paste but
  keeps the bytes to itself (the mod API never exposes them). On macOS the mod
  grabs the picture still on the clipboard (`osascript` → `/tmp/image-preview/
  pasted-N.png`) and previews that — so paste → preview works for the picture
  you just pasted. The first grab may raise a one-time macOS Automation
  permission prompt for the terminal app.

## How images render

Every thumbnail is an `Image` element sourcing a real PNG file
(`sips -z 800 800` → `/tmp/image-preview/<hash>.png`), the same way the
`mermaid-pane` mod presents its diagrams:

- **kitty / Ghostty**: the engine paints actual pixels.
- **Other terminals**: the engine degrades the element to its `alt`, which
  carries the ASCII bitmap of the same picture (sips → BMP → luminance ramp),
  so a preview is still visible.

## Terminal gate (important inside multiplexers)

Claude Code paints `Image` elements only when the kitty-graphics capability
is settled. It probes the terminal at startup: the **XTVERSION reply name must
be in its `["kitty", "ghostty"]` whitelist**, and the terminal must answer a
live graphics query.

Inside **herdr** (or any multiplexer that changes the terminal identity —
Ghostty reports `libghostty` through it), that whitelist check fails and
thumbnails degrade to alt text. Force the capability on instead:

```sh
CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1 claude --plugin-dir ./image-preview
```

Only do this in a terminal that actually supports the kitty graphics protocol
(it answers the graphics query — Ghostty and kitty do).
