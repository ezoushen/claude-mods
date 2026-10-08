declare module "claude-code" {
  interface PluginState {
    "image-preview": {
      state: {
        /** Whether thumbnails draw this session; /image-preview on|off sets
         * it, and absent means on. */
        render?: boolean;
      };
    };
  }
}
