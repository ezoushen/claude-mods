declare module "claude-code" {
  interface PluginState {
    "image-preview": {
      state: {
        /** Real image file paths the /image command stored, indexed so a
         * `[Image #N]` token in a prompt or an agent reply resolves to
         * `gallery[N - 1]` and draws a thumbnail. */
        gallery: string[];
      };
    };
  }
}
