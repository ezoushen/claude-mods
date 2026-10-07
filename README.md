# claude-mods

Claude Code mods by [ezoushen](https://github.com/ezoushen) — plugins whose behavior lives in hooks modules. Maintained in one monorepo; each mod is listed in the marketplace and installed separately.

| Mod | Requires | Install |
| --- | --- | --- |
| [mermaid-pane](mermaid-pane/) | Claude Code ≥ 2.1.287; renderers optional (`/mermaid setup` installs beautiful-mermaid via bun or npm, termaid via pip and mermaid-cli via npm); image pixels draw in kitty/Ghostty (elsewhere it degrades to ASCII art) | `/plugin marketplace add ezoushen/claude-mods` then `/plugin install mermaid-pane@claude-mods` |
| [image-preview](image-preview/) | Claude Code ≥ 2.1.287; works on any terminal (draws the filename as alt-text on non-graphic ones) | `/plugin marketplace add ezoushen/claude-mods` then `/plugin install image-preview@claude-mods` |

## Mods

### image-preview

Renders image paths inline, like the desktop GUI — a thumbnail in the prompt row you sent and in the reply that mentions the path:

- **prompt rows** — an image path in the sent prompt draws an aspect-fill thumbnail (never taller than 10 rows)
- **reply rows** — a path the model mentions draws the same thumbnail in the reply row
- `/image <path...>` stores paths, referenced as `[Image #N]`; `/image off` is a complete no-op, `/image list` / `/image clear` manage the gallery

Thumbnails are real PNG files (`sips -Z 800`) stored under `/tmp/image-preview/`; graphics terminals (kitty/Ghostty) paint actual pixels, other terminals draw the file name as alt text.

### mermaid-pane

Renders ```` ```mermaid ```` blocks from the conversation inline, with the chart sitting next to the response that produced it:

- **ascii mode** — each reply's mermaid fence is rewritten in place into rendered ASCII art (always local)
- **image mode** — replies keep their source; each chart draws as a real diagram PNG via local `mmdc`, degrading to art on failure or text-only terminals
- **external rendering** — OFF by default; `/mermaid external on` opts into mermaid.ink when local PNG fails (sends full diagram source; persists). Image mode alone is not consent
- `/mermaid ascii|image` picks the mode · `/mermaid external on|off` gates remote · bare `/mermaid` reports mode, external setting, and renderer status
- `/mermaid setup` installs the optional renderers in the background (see the mod's README)

## Install

```sh
/plugin marketplace add ezoushen/claude-mods
/plugin install mermaid-pane@claude-mods
```

Installing the marketplace registers only the mods listed in `.claude-plugin/marketplace.json`. To develop locally instead:

```sh
git clone https://github.com/ezoushen/claude-mods.git
cd claude-mods
claude --plugin-dir ./mermaid-pane
```

## Skills

- [`.agents/skills/claude-code-mod-dev`](.agents/skills/claude-code-mod-dev/) — the skill used to author, test, and publish mods like this one (picked up automatically by Claude Code / Pi from `.agents/skills`).

## Notes

- [research/](research/) — findings kept while building the mods (e.g. how mermaid rendering works in TUIs).
- Renderers are optional: without them, mermaid-pane still renders (built-in edge art; local PNG needs mermaid-cli; mermaid.ink is opt-in via `/mermaid external on`).

## License

MIT — see [LICENSE](LICENSE).
