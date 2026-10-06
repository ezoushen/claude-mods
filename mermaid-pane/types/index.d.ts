declare module "claude-code" {
  interface PluginState {
    "mermaid-pane": {
      /** How charts render this session: ascii (art in replies) or image (PNGs). */
      mode: "ascii" | "image";
    };
  }
}
