declare module "claude-code" {
  interface PluginState {
    "mermaid-pane": {
      /** Every mermaid block seen this session, deduped by source code. */
      diagrams: { id: string; title: string; code: string }[];
      /** How charts render: ascii (art in replies + pane) or image (PNGs in pane). */
      mode: "ascii" | "image";
      /** Resolved mermaid-ascii binary path, or null once probed and absent. */
      asciiTool: string | null;
    };
  }
}
