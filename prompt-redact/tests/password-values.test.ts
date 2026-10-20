import { describe, expect, test } from "claude-code/testing";

import { register } from "../hooks/register.ts";
import { scrub, type ScrubOptions } from "../hooks/scrub.ts";

const SALT = "password-values-salt";
/** A synthetic GitHub PAT: real prefix, invented body. */
const GHP_CANARY = "ghp_" + "Zz9QwErTyUiOpAsDfGhJkLzXcVbNm12AbCdEf";

const balanced: ScrubOptions = {
  salt: SALT,
  tier: "balanced",
  minEntropy: 3.2,
  budgetMs: 5000,
};

describe("password values", () => {
  test("a human-chosen password is redacted below the entropy floor", () => {
    const out = scrub("DB_PASSWORD=S3cr3tP4ssw0rd", balanced);
    expect(out.hits.length).toBe(1);
    expect(out.text.includes("S3cr3tP4ssw0rd")).toBe(false);
    expect(out.text).toContain("[REDACTED:PASSWORD_VALUE#");
  });

  test("the placeholder lexicon and non-values are left alone", () => {
    // Every input is a shape a person would paste into a config; each one must
    // come out byte-identical or the detector costs more than it catches.
    const nonValues = [
      "password=changeme",
      "password=${ENV}",
      "password=<your-key>",
      "password=null",
      "password=required",
      "passwd=xxx",
      'password: ""',
    ];
    for (const input of nonValues) {
      const out = scrub(input, balanced);
      expect({ input, text: out.text, hits: out.hits.length }).toEqual({ input, text: input, hits: 0 });
    }
  });

  test("a path-shaped value under a password field is left alone", () => {
    // `PWD=` appears in every shell environment dump; the value is a working
    // directory, not a credential. Paths carry no password to revoke.
    const paths = ["PWD=/Users/ezou", "pwd=/home/ezou/workspace", "password=~/secrets"];
    for (const input of paths) {
      const out = scrub(input, balanced);
      expect({ input, text: out.text, hits: out.hits.length }).toEqual({ input, text: input, hits: 0 });
    }
  });

  test("a genuine password is still redacted beside a path-shaped value", () => {
    const out = scrub("PWD=/Users/ezou\npassword=S3cr3tP4ssw0rd", balanced);
    expect(out.text).toContain("PWD=/Users/ezou");
    expect(out.text.includes("S3cr3tP4ssw0rd")).toBe(false);
    expect(out.text).toContain("[REDACTED:PASSWORD_VALUE#");
  });

  test("the detector is off at tier strict", () => {
    // `strict` is the shipped precision baseline. A detector that trades
    // entropy for recall must not change what someone who chose strict sees.
    const text = "DB_PASSWORD=S3cr3tP4ssw0rd";
    expect(scrub(text, { ...balanced, tier: "strict" })).toEqual({ text, hits: [] });
    expect(scrub(text, { ...balanced, tier: "precision" })).toEqual({ text, hits: [] });
  });
});

// --- the /redact surface -----------------------------------------------------

type Captured = { event: string; match?: Record<string, unknown>; handler: ($: any, e: any, next: (e: any) => unknown) => unknown };

function captureHandlers(): Captured[] {
  const captured: Captured[] = [];
  const on = (event: string, a: any, b?: any) => {
    captured.push({ event, match: b ? a : undefined, handler: (b ?? a) as Captured["handler"] });
  };
  register(on, {});
  return captured;
}

function fakeEngine(initial: Record<string, unknown>) {
  const store: Record<string, unknown> = { ...initial };
  const $ = {
    state: {
      get: async (e: { plugin: string; key: string }) => ({ value: store[`${e.plugin}:${e.key}`], version: 0 }),
      set: async (e: { plugin: string; key: string }, value: unknown) => {
        store[`${e.plugin}:${e.key}`] = value;
        return { isSet: true, version: 0 };
      },
    },
    fs: {
      exists: async () => false,
      read: async () => "",
    },
    ui: { log: () => undefined },
    command: { register: async () => ({ registered: true }) },
  };
  return { $, store };
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

describe("new detectors are removable", () => {
  test("password-value can be switched off", async () => {
    const captured = captureHandlers();
    const command = captured.find((c) => c.event === "command.run" && c.match?.command === "redact");
    const submit = captured.find((c) => c.event === "prompt.submit");
    expect(command).not.toBeUndefined();
    expect(submit).not.toBeUndefined();

    const { $ } = fakeEngine({ ...sessionState });
    const password = "DB_PASSWORD=S3cr3tP4ssw0rd";
    const run = async (text: string) => (await submit!.handler($, { text }, (e: any) => e)) as { text: string };

    expect((await run(password)).text).toContain("[REDACTED:PASSWORD_VALUE#");

    const off = (await command!.handler($, { command: "redact", args: "rule off password-value" })) as { text: string };
    expect(off.text).toContain("disabled: password-value");
    expect((await run(password)).text).toBe(password);

    // Removing one detector must not blind the corpus: a vendor token in the
    // same prompt is still replaced.
    const mixed = `${password}\ntoken ${GHP_CANARY}`;
    const still = await run(mixed);
    expect(still.text).toContain(password);
    expect(still.text.includes(GHP_CANARY)).toBe(false);
    expect(still.text).toContain("[REDACTED:GITHUB_PAT#");
  });
});
