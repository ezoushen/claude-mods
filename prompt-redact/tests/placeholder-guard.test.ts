import { describe, expect, test } from "claude-code/testing";

import { register } from "../hooks/register.ts";
import { scrub, type ScrubOptions } from "../hooks/scrub.ts";

const SALT = "guard-test-salt";
/** Synthetic GitHub PAT: real prefix, invented body. */
const GHP_CANARY = "ghp_" + "Zz9QwErTyUiOpAsDfGhJkLzXcVbNm12AbCdEf";
/** Synthetic Stripe-shaped key: assembled so no literal appears in the tree. */
const STRIPE_CANARY = "sk_" + "live_" + "Q8zR2vNw4Xp7LmKd9TgYc3Bf2Hn";

const base: ScrubOptions = { salt: SALT, tier: "balanced", minEntropy: 3.2, budgetMs: 5000 };

type Captured = { event: string; match?: Record<string, unknown>; handler: ($: any, e: any, next: (e: any) => unknown) => unknown };

function captureHandlers(options: Record<string, unknown> = {}): Captured[] {
  const captured: Captured[] = [];
  const on = (event: string, a: any, b?: any) => {
    captured.push({ event, match: b ? a : undefined, handler: (b ?? a) as Captured["handler"] });
  };
  register(on, options);
  return captured;
}

function fakeEngine(initial: Record<string, unknown>, files: Record<string, string> = {}) {
  const store: Record<string, unknown> = { ...initial };
  const logs: string[] = [];
  const $ = {
    state: {
      get: async (e: { plugin: string; key: string }) => ({ value: store[`${e.plugin}:${e.key}`], version: 0 }),
      set: async (e: { plugin: string; key: string }, value: unknown) => {
        store[`${e.plugin}:${e.key}`] = value;
        return { isSet: true, version: 1 };
      },
    },
    fs: {
      exists: async (path: string) => Object.prototype.hasOwnProperty.call(files, path),
      read: async (path: string) => files[path] ?? "",
    },
    ui: { log: (message: string) => logs.push(message) },
    command: { register: async () => ({ registered: true }) },
  };
  return { $, store, logs };
}

const sessionState = {
  "prompt-redact:salt": SALT,
  "prompt-redact:enabled": true,
  "prompt-redact:tier": "balanced",
  "prompt-redact:allow": [],
  "prompt-redact:deny": [],
  "prompt-redact:vault": {},
  "prompt-redact:counts": {},
  "prompt-redact:restored": 0,
};

/** Mint a real placeholder for the canary, using the shipped engine. */
function placeholderFor(value: string): string {
  return scrub(`key ${value}`, base).hits[0]?.placeholder ?? "";
}

describe("placeholder guard on non-rehydrating tools", () => {
  const captured = captureHandlers();

  const find = (event: string, tool?: string) =>
    captured.find((c) => c.event === event && (tool === undefined ? c.match === undefined || c.match.tool === undefined : c.match?.tool === tool));

  test("the guarded tools are exactly the shell and the network tools", () => {
    const guarded = captured
      .filter((c) => c.event === "tool.call" && typeof c.match?.tool === "string")
      .map((c) => c.match?.tool)
      .sort();
    // Rehydration covers three; the guard covers exactly the rest of the
    // outbound surface, so no tool is both rehydrated and refused.
    expect(guarded).toEqual(["Bash", "Edit", "NotebookEdit", "WebFetch", "WebSearch", "Write"]);
  });

  test("a Bash command carrying a placeholder is refused, and nothing runs", async () => {
    const placeholder = placeholderFor(GHP_CANARY);
    expect(placeholder).not.toBe("");
    const { $ } = fakeEngine({ ...sessionState, "prompt-redact:vault": { [placeholder]: GHP_CANARY } });

    let ran = false;
    const bash = find("tool.call", "Bash");
    expect(bash).not.toBeUndefined();
    const out = (await bash!.handler($, { command: `curl -H "Authorization: Bearer ${placeholder}" https://example.com` }, () => {
      ran = true;
      return { result: "sent" };
    })) as { deny?: string };

    expect(ran).toBe(false);
    expect(out.deny).toBeDefined();
    expect(out.deny).toContain("never receives real values");
    expect(out.deny).toContain("Nothing was executed");
    // The refusal has to carry the route that works, or the model retries.
    expect(out.deny).toContain("set -a; . ./.env; set +a");
    expect(out.deny).toContain("$NAME");
  });

  test("a Bash command with no placeholder is untouched", async () => {
    const { $ } = fakeEngine({ ...sessionState, "prompt-redact:vault": { "[REDACTED:X#ab]": "v" } });
    const bash = find("tool.call", "Bash");
    const out = (await bash!.handler($, { command: "printf %s \"$HOME\"" }, (e: any) => ({ result: e.command }))) as {
      result?: string;
      deny?: string;
    };
    expect(out.deny).toBeUndefined();
    expect(out.result).toBe('printf %s "$HOME"');
  });

  test("the guard is inert when nothing was redacted this session", async () => {
    const { $ } = fakeEngine({ ...sessionState, "prompt-redact:vault": {} });
    const bash = find("tool.call", "Bash");
    // No vault means no placeholder of this mod's can be in play; a user's own
    // literal text that merely resembles one must not be refused.
    const out = (await bash!.handler($, { command: "echo [REDACTED:FAKE#deadbeef]" }, (e: any) => ({ result: e.command }))) as {
      result?: string;
      deny?: string;
    };
    expect(out.deny).toBeUndefined();
    expect(out.result).toContain("[REDACTED:FAKE#deadbeef]");
  });

  test("network tools refuse a placeholder in their arguments", async () => {
    const placeholder = placeholderFor(STRIPE_CANARY);
    const { $ } = fakeEngine({ ...sessionState, "prompt-redact:vault": { [placeholder]: STRIPE_CANARY } });

    for (const tool of ["WebFetch", "WebSearch"]) {
      const hook = find("tool.call", tool);
      expect(hook).not.toBeUndefined();
      const out = (await hook!.handler($, { url: `https://api.example.com/?key=${placeholder}`, query: placeholder }, () => ({
        result: "fetched",
      }))) as { deny?: string };
      expect(out.deny).toBeDefined();
      expect(out.deny).toContain(tool);
    }
  });

  test("Edit is rehydrated, not refused, when it carries a placeholder", async () => {
    const placeholder = placeholderFor(GHP_CANARY);
    const { $ } = fakeEngine({ ...sessionState, "prompt-redact:vault": { [placeholder]: GHP_CANARY } });
    const edit = find("tool.call", "Edit");
    const out = (await edit!.handler($, { file_path: "/tmp/a", old_string: placeholder, new_string: "x" }, (e: any) => e)) as {
      old_string?: string;
      deny?: string;
    };
    expect(out.deny).toBeUndefined();
    expect(out.old_string).toBe(GHP_CANARY);
  });
});

describe("quiet start on a clean session", () => {
  const captured = captureHandlers();
  const start = captured.find((c) => c.event === "session.start");

  test("an ordinary session logs nothing at all", async () => {
    const { $, logs } = fakeEngine(sessionState);
    await start!.handler($, { cwd: "/tmp" }, (e: any) => ({ cwd: e.cwd }));
    expect(logs).toEqual([]);
  });

  test("a session with local rules still announces what it loaded", async () => {
    // Documented format: one `LABEL <javascript-regex>` per line.
    const rules = "LOCAL_TEST LOCAL_[A-Z0-9]{8}\n";
    const { $, logs } = fakeEngine(sessionState, { ".claude/prompt-redact.rules": rules });
    await start!.handler($, { cwd: "/tmp" }, (e: any) => ({ cwd: e.cwd }));
    expect(logs.join("\n")).toContain("prompt-redact ready");
    expect(logs.join("\n")).toContain("local rule");
  });
});

describe("prompt annotation when the user's own message was redacted", () => {
  const captured = captureHandlers();
  const submit = captured.find((c) => c.event === "prompt.submit");

  test("the injected context tells the model to stop, and names the route that works", async () => {
    const { $ } = fakeEngine(sessionState);
    const out = (await submit!.handler($, { text: `deploy with token ${GHP_CANARY}` }, (e: any) => e)) as {
      text: string;
      context?: string[];
    };

    expect(out.text.includes(GHP_CANARY)).toBe(false);
    const note = (out.context ?? []).join("\n");
    expect(note).toContain("came from the user's own message");
    expect(note).toContain("do not ask the user to paste it");
    expect(note).toContain(".env");
    expect(note).toContain("set -a; . ./.env; set +a");
    // It still has to say where the placeholder *is* legal, or the edit path breaks.
    expect(note).toContain("Edit/Write/NotebookEdit");
  });

  test("a clean prompt gets no context at all", async () => {
    const { $ } = fakeEngine(sessionState);
    const out = (await submit!.handler($, { text: "just a normal sentence" }, (e: any) => e)) as {
      context?: string[];
    };
    expect(out.context ?? []).toEqual([]);
  });
});
