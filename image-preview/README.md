# image-preview

Render image paths inline in Claude Code, like the desktop GUI app.

- **User prompt rows**: an image path in the sent prompt draws a thumbnail,
  aspect-fill, never taller than 10 rows.
- **Agent reply rows**: an image path the model mentions draws the same
  thumbnail in the reply row.
- `/image <path...>` stores paths; reference them as `[Image #N]`.

## How images render

Every thumbnail is an `Image` element sourcing a real PNG file
(`sips -Z 800` → `/tmp/image-preview/<hash>.png`, aspect preserved), the same way the
`mermaid-pane` mod presents its diagrams:

- **kitty / Ghostty**: the engine paints actual pixels.
- **Other terminals**: the engine draws the `alt` — the picture's file name.

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
