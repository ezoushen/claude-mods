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

## Toggle rendering

`/image off` turns thumbnails off — a complete no-op: rows render exactly as
without the mod, no state reads, no sips calls, no scans. `/image on` turns
them back on. `/image list` and `/image clear` manage the stored paths; the
toggle is stored per session and defaults to on.
