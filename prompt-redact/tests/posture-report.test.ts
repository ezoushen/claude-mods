import { describe, expect, test } from "claude-code/testing";

import { register } from "../hooks/register.ts";

const SALT = "posture-test-salt";
/** Synthetic AWS-shaped key: real prefix, invented body. */
const AWS_CANARY = "AKIA" + "ZZ7Q3POSTUREONLYX";

type Captured = {
  event: string;
  match?: Record<string, unknown>;
  handler: ($: any, e: any, next: (e: any) => unknown) => unknown;
};

/** Capture what `register` wires, without an engine. */
function captureHandlers(options: Record<string, unknown> = {}): Captured[] {
  const captured: Captured[] = [];
  const on = (event: string, a: any, b?: any) => {
    captured.push({ event, match: b ? a : undefined, handler: (b ?? a) as Captured["handler"] });
    // The engine's `on` returns a registration carrying `.catch`; the mod now sets
    // error handlers, so the stub has to honour that surface.
    return { catch: (_handler: unknown) => undefined };
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
        return { isSet: true, version: 0 };
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
  "prompt-redact:hookFires": {},
};

function find(captured: Captured[], event: string, tool?: string): Captured {
  const found = captured.find(
    (c) => c.event === event && (tool === undefined ? c.match === undefined || c.match.tool === undefined : c.match?.tool === tool),
  );
  if (!found) throw new Error(`no handler captured for ${event}`);
  return found;
}

const nextEcho = (e: any) => e;

/**
 * Deliver one interception event to the mod. A hook whose run the outer policy
 * plugin keeps from reaching the mod is simulated the only way an in-process
 * harness can: the handler is not invoked — exactly as the platform never
 * invokes it in the live account, with no signal left behind for the mod.
 */
async function fire(captured: Captured[], $: any, hook: string): Promise<void> {
  switch (hook) {
    case "prompt.submit": {
      await find(captured, "prompt.submit").handler($, { text: "a normal sentence" }, nextEcho);
      return;
    }
    case "session.append": {
      await find(captured, "session.append").handler(
        $,
        { message: { type: "user", content: [{ type: "text", text: "a normal reply" }] }, door: "prompt", origin: { kind: "composer" }, uuid: "u" },
        nextEcho,
      );
      return;
    }
    case "prompt.attachment": {
      await find(captured, "prompt.attachment").handler(
        $,
        { type: "hook_context", text: "injected context", origin: { kind: "hook", event: "SessionStart" } },
        (e: any) => ({ text: e.text }),
      );
      return;
    }
    case "prompt.compose": {
      await find(captured, "prompt.compose").handler(
        $,
        { model: "m", promptModel: "m", surfaces: [], tools: [], outputStyle: null, traits: [] },
        () => ({ sections: [] }),
      );
      return;
    }
    case "prompt.section": {
      await find(captured, "prompt.section").handler($, { name: "env_info_simple", text: "info" }, (e: any) => ({ text: e.text }));
      return;
    }
    case "tool.call": {
      await find(captured, "tool.call").handler($, { command: "echo ok" }, () => ({ result: "ok" }));
      return;
    }
    default:
      throw new Error(`unknown hook ${hook}`);
  }
}

async function why(captured: Captured[], $: any): Promise<string> {
  const out = (await find(captured, "command.run").handler($, { command: "redact", args: "why" })) as { text: string };
  return out.text;
}

describe("posture report", () => {
  test("a hook the outer plugin skipped reports skipped-side, never armed", async () => {
    // The organization-account shape, per the operator capture: `cc-plugin-sec-default`
    // seats outermost and keeps `session.append` from reaching this mod, while the
    // platform reports the skip outside this process. Every other interception
    // hook fires once.
    const captured = captureHandlers();
    const { $ } = fakeEngine({ ...sessionState });
    for (const hook of ["prompt.submit", "tool.call", "prompt.attachment", "prompt.compose", "prompt.section"]) {
      await fire(captured, $, hook);
    }

    const text = await why(captured, $);
    expect(text).toContain("interception hooks: 5 fired this session, 1 not observed");
    expect(text).toContain(
      "fired this session: prompt.submit x1, tool.call x1, prompt.attachment x1, prompt.compose x1, prompt.section x1",
    );
    expect(text).toContain("not observed: session.append");
    // A hook it did not run for must name why it might be absent — including the
    // policy skip — and never claim the carrier was covered.
    expect(text).toContain("an outer policy plugin can keep an event from reaching this mod, or no such event has occurred yet");
    expect(text).not.toContain("armed");
    expect(text).toContain("observed firing is not coverage");
  });

  test("a hook the platform reports as skipped is reported observed-only, never armed", async () => {
    // The live session-b contradiction, as the mod can see it: the platform
    // reported skips of `session.append` in the same session whose transcript it
    // stored, and two rows of it did reach this mod. Both facts are true at
    // once; in-process only the two runs are observable. The report must state
    // what it observed and never present it as coverage.
    const captured = captureHandlers();
    const { $ } = fakeEngine({ ...sessionState });
    await fire(captured, $, "session.append");
    await fire(captured, $, "session.append");

    const text = await why(captured, $);
    expect(text).toContain("fired this session: session.append x2");
    expect(text).toContain("interception hooks: 1 fired this session, 5 not observed");
    expect(text).not.toContain("armed");
    expect(text).toContain("observed firing is not coverage");
  });

  test("the warning stands even when every hook fired", async () => {
    const captured = captureHandlers();
    const { $ } = fakeEngine({ ...sessionState });
    for (const hook of ["prompt.submit", "session.append", "prompt.attachment", "prompt.compose", "prompt.section", "tool.call"]) {
      await fire(captured, $, hook);
    }

    const text = await why(captured, $);
    expect(text).toContain("interception hooks: 6 fired this session, 0 not observed");
    expect(text).toContain(
      "fired this session: prompt.submit x1, tool.call x1, session.append x1, prompt.attachment x1, prompt.compose x1, prompt.section x1",
    );
    expect(text).not.toContain("not observed: ");
    // Session b had a hook the platform skipped in the same session it fired, so
    // a full-looking observation proves nothing on its own.
    expect(text).not.toContain("armed");
    expect(text).toContain("observed firing is not coverage");
  });

  test("the report never prints a value", async () => {
    const captured = captureHandlers();
    const { $ } = fakeEngine({ ...sessionState });
    // Put a real value in the vault by redacting a prompt that carries one.
    const submitted = (await find(captured, "prompt.submit").handler(
      $,
      { text: `AWS_ACCESS_KEY_ID=${AWS_CANARY}` },
      nextEcho,
    )) as { text: string };
    expect(submitted.text.includes(AWS_CANARY)).toBe(false);
    expect(submitted.text).toContain("[REDACTED:");
    await fire(captured, $, "session.append");

    const text = await why(captured, $);
    // Labels, counts and hook names only. Not the value, not its prefix, and not
    // even the placeholder (whose hash is derived from the value).
    expect(text).not.toContain(AWS_CANARY);
    expect(text).not.toContain("AKIA");
    expect(text).not.toContain("[REDACTED:");
    expect(text).toContain("labels hidden this session: 1");
  });
});

describe("removable detector ids", () => {
  test("the three ids delivered by other tickets are accepted by /redact rule", async () => {
    // Tickets 01 and 03 delivered these detector families; the engine honours
    // their ids through `disabledRules`, but the command's known-id set was
    // never widened to include them.
    const captured = captureHandlers();
    const { $ } = fakeEngine({ ...sessionState });
    const run = async (args: string) =>
      (await find(captured, "command.run").handler($, { command: "redact", args })) as { text: string };

    const ids = ["url-userinfo", "basic-auth", "password-value"];
    for (const id of ids) {
      const off = await run(`rule off ${id}`);
      expect(off.text).toContain(`disabled: ${id}`);
      expect(off.text).not.toContain("no such rule");
    }

    const list = await run("rule list");
    for (const id of ids) expect(list.text).toContain(id);

    for (const id of ids) {
      const on = await run(`rule on ${id}`);
      expect(on.text).toContain("re-enabled");
      expect(on.text).not.toContain("no such rule");
    }

    // Widening the set must not turn the typo guard into a no-op.
    const typo = await run("rule off not-a-rule");
    expect(typo.text).toContain("no such rule");
  });
});
