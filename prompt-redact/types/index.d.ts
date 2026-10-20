declare module "claude-code" {
  interface PluginState {
    "prompt-redact": {
      /** Per-session salt: a placeholder minted under one salt means nothing under another. */
      salt: string;
      /** Placeholder -> real value. Session-scoped; never written to disk or $.store. */
      vault: Record<string, string>;
      /** Label -> how many values of that label were hidden this session. */
      counts: Record<string, number>;
      /** How many placeholders were restored into Edit/Write/NotebookEdit arguments. */
      restored: number;
      /** Scanning on/off for this session (/redact on|off). */
      enabled: boolean;
      /** Aggressiveness preset. */
      tier: "strict" | "balanced" | "precision";
      /** User allowlist: candidate values matching are never redacted. */
      allow: string[];
      /** User force-redact list: values matching are always redacted. */
      deny: string[];
      /** Rule ids switched off for this session; a disabled rule never fires. */
      disabled: string[];
      /**
       * How many runs of each interception hook reached this code this session,
       * by event name. Runs the engine or an outer plugin skipped are absent:
       * the platform's skip notice is written outside this process, so a count
       * is an observation, never proof of coverage.
       */
      hookFires: Record<string, number>;
    };
  }
}
