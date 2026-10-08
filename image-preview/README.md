# image-preview

Render image paths inline in Claude Code, like the desktop GUI app.

- **User prompt rows**: an image path in the sent prompt draws a thumbnail,
  aspect-fill, never taller than 10 rows.
- **Agent reply rows**: an image path the model mentions draws the same
  thumbnail in the reply row.
- **Pasted images**: an `[Image #N]` you pasted draws that picture, read back
  from the transcript.

A path may be absolute, relative, or `~/`; it may sit in backticks, bold or a
markdown link, be followed by punctuation, be quoted (`"~/My Pics/a b.png"`)
or carry escaped spaces (`Screen\ Shot.png`, as a dropped file arrives).

## How images render

Every thumbnail is an `Image` element sourcing a real PNG file
(`sips -Z 800`, aspect preserved), the same way the `mermaid-pane` mod presents
its diagrams. Files decode to `/tmp/image-preview/<hash>.png`; pastes, the
person's own content, decode to `~/.cache/image-preview/` (mode 700):

- **kitty / Ghostty**: the engine paints actual pixels.
- **Other terminals**: the engine draws the `alt` — the picture's file name.

## Toggle rendering

`/image-preview off` turns thumbnails off — a complete no-op: rows render
exactly as without the mod, no sips calls, no scans. `/image-preview on` turns
them back on. The toggle is stored per session and defaults to on.
