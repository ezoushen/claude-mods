declare module "claude-code" {
  interface PluginState {
    "image-preview": {
      state: {
        /** Real image file paths the /image command stored, indexed so a
         * `[Image #N]` token in a prompt resolves to `gallery[N - 1]` and draws a
         * thumbnail. */
        gallery: string[];
        /** The editor-band cache: the last draft scanned and its decoded
         * thumbnails (keyed) for the AbovePrompt band, which never receives the
         * draft text in its own props. */
        band: {
          draft: string;
          images: Array<{
            key: string;
            label: string;
            source: { png: string } | { file: string; format: "png" };
            w: number;
            h: number;
          }>;
        };
      };
    };
  }
}
