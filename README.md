# claude-mods

Claude Code mods by [ezoushen](https://github.com/ezoushen) — plugins whose behavior lives in hooks modules. Maintained in one monorepo; each mod is listed in the marketplace and installed separately.

| Mod | Requires | Install |
| --- | --- | --- |
| [mermaid-pane](mermaid-pane/) | Claude Code ≥ 2.1.287; `mmdc` (mermaid-cli) optional for offline rendering; image mode needs a graphics terminal (kitty/iTerm2/WezTerm/Ghostty) | `/plugin marketplace add ezoushen/claude-mods` then `/plugin install mermaid-pane@claude-mods` |

## Mods

### mermaid-pane

Presents ```` ```mermaid ```` blocks from the conversation:

- **ascii mode** — each reply's mermaid fence is rewritten in place into rendered ASCII art (the chart sits with the response it belongs to)
- **image mode** — replies keep their source; the `/mermaid` pane draws real diagram PNGs as native terminal images (local `mmdc` render, mermaid.ink fallback)
- `/mermaid` opens the session gallery pane · `/mermaid image|ascii` picks the mode · `/mermaid close` closes
- `[ Open ↗ ]` in the pane opens the full-fidelity SVG in the browser
- Charts are retained across the session; rendering is aspect-fit with margins and never clips content

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
- `mmdc` is optional: without it, mermaid-pane falls back to mermaid.ink (network) and ASCII art.

## License

MIT — see [LICENSE](LICENSE).
