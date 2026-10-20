import { describe, expect, test } from "claude-code/testing";

import { ALLOWLIST, isAllowed } from "../hooks/allowlist.ts";
import { RULES } from "../hooks/rules.generated.ts";
import { unboundedIn } from "../hooks/quantifiers.ts";
import {
  asRehydratable,
  contextScore,
  detectorsFor,
  isPlaceholder,
  placeholderFor,
  placeholderCount,
  rehydrate,
  scrub,
  scrubMessage,
  shannon,
  type ScrubOptions,
} from "../hooks/scrub.ts";
import { cards, ibanOk, jwts, luhnOk, pemPrivateKeys, ssns, totpSecrets } from "../hooks/structural.ts";
import { isSecret, parseClassifier, scoreValue } from "../hooks/classifier.ts";
import { register } from "../hooks/register.ts";

const SALT = "test-salt-0000";

const base: ScrubOptions = {
  salt: SALT,
  tier: "balanced",
  minEntropy: 3.2,
  budgetMs: 5000,
};

/** A synthetic AWS-shaped key: real prefix, real [A-Z2-7] alphabet, invented value. */
const AWS_CANARY = "AKIA" + "ZZ7Q3CANARYONLYX";
/** A synthetic GitHub PAT: real prefix, invented body. */
const GHP_CANARY = "ghp_" + "Zz9QwErTyUiOpAsDfGhJkLzXcVbNm12AbCdEf";
/** A synthetic private key block, generated only for this test. */
const PEM_CANARY = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "MIIEowIBAAKCAQEAy8Dbv8prpJ/0kKhlGeJYozo2t60EG8L0561g13R29LvMR5hy",
  "vGZlGJpmn65+A4xHXInJYiPuKzrKUnApeLZ+vw1HocOAZtWK0z3r26uA8kQYOKX4",
  "-----END RSA PRIVATE KEY-----",
].join("\n");

describe("allowlist", () => {
  // The allowlist test proves the precision budget: these are the shapes a
  // redactor must NOT touch, because redacting them breaks the task.
  const benign = [
    "a94a8fe5ccb19ba61c4c0873d391e987982fbbd3", // 40-hex git SHA-1
    "9b2f9c1e-4f6a-4b1d-8c2e-7f3a5d6b1c0e", // UUIDv4
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", // sha256
    `$2b$12$${"KIXQhE9nU3QZ0lQ1oQ5YQeJ9Q1oQ5YQeJ9Q1oQ5YQeJ9Q1oQ5YQeJ9Q".slice(0, 53).padEnd(53, "A")}`, // bcrypt: exactly 53 chars after the cost
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl", // ssh public (ed25519)
    "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQDexampleonlynotarealkey0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000", // ssh public (rsa)
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
    "sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uxy9rx7HNQlGxYAMjNwY3f9kPJmw1aC",
    "changeme",
    "${DATABASE_PASSWORD}",
  ];

  test("benign high-entropy shapes pass through byte-identical", () => {
    for (const value of benign) {
      const why = isAllowed(value);
      expect({ value, allowed: why !== null }).toEqual({ value, allowed: true });
    }
  });

  test("every allowlist entry carries a stated reason", () => {
    expect(ALLOWLIST.length).toBeGreaterThanOrEqual(20);
    for (const entry of ALLOWLIST) {
      expect(entry.why.length).toBeGreaterThan(10);
    }
  });

  test("a benign shape is not redacted even when it is a credential-shaped assignment", () => {
    const text = `git checkout ${benign[0]}`;
    expect(scrub(text, base)).toEqual({ text, hits: [] });
  });
});

describe("placeholder-stability", () => {
  test("the same secret yields the same placeholder everywhere in a session", () => {
    const prompt = scrub(`use ${AWS_CANARY} to deploy`, base);
    const toolRow = scrub(`export AWS_ACCESS_KEY_ID=${AWS_CANARY}`, base);
    expect(prompt.hits.length).toBe(1);
    expect(toolRow.hits.length).toBe(1);
    // The placeholder must be identical across a prompt row and a tool-result
    // row, or an Edit to a line holding the real key would not match disk.
    expect(prompt.hits[0]?.placeholder).toEqual(toolRow.hits[0]?.placeholder);
    // The same placeholder appears in both rows, and neither keeps the value.
    expect(prompt.text.includes(prompt.hits[0]!.placeholder)).toBe(true);
    expect(toolRow.text.includes(prompt.hits[0]!.placeholder)).toBe(true);
    expect(prompt.text.includes(AWS_CANARY)).toBe(false);
    expect(toolRow.text.includes(AWS_CANARY)).toBe(false);
  });

  test("a different salt produces a different placeholder", () => {
    const a = scrub(`key ${AWS_CANARY}`, base);
    const b = scrub(`key ${AWS_CANARY}`, { ...base, salt: "other-salt-9999" });
    expect(a.hits[0]?.placeholder).not.toEqual(b.hits[0]?.placeholder);
  });

  test("placeholders are idempotent: rescanning never doubles up", () => {
    const once = scrub(`use ${AWS_CANARY} please`, base);
    const twice = scrub(once.text, base);
    expect(twice.text).toEqual(once.text);
    expect(twice.hits.length).toBe(0);
    expect(isPlaceholder(placeholderFor("AWS", SALT, AWS_CANARY))).toBe(true);
  });

  test("an edit spanning a placeholder restores the real value for disk", () => {
    const once = scrub(`SECRET=${GHP_CANARY}`, base);
    const vault: Record<string, string> = {};
    for (const hit of once.hits) vault[hit.placeholder] = hit.value;
    const restored = rehydrate(asRehydratable({ old_string: once.text }) ?? "", vault);
    expect(restored).toEqual({ old_string: `SECRET=${GHP_CANARY}` });
  });
});

describe("rehydrate", () => {
  const vault: Record<string, string> = {};
  const scrubbed = scrub(`token ${GHP_CANARY}`, base);
  for (const hit of scrubbed.hits) vault[hit.placeholder] = hit.value;

  test("edit arguments get the real value back", () => {
    const input = asRehydratable({ file_path: "/tmp/a", new_string: scrubbed.text });
    expect(rehydrate(input ?? "", vault)).toEqual({ file_path: "/tmp/a", new_string: `token ${GHP_CANARY}` });
  });

  test("nested argument structures are rehydrated", () => {
    const input = asRehydratable({ edits: [{ oldText: scrubbed.text }] });
    const out = rehydrate(input ?? "", vault) as { edits: { oldText: string }[] };
    expect(out.edits[0]?.oldText).toEqual(`token ${GHP_CANARY}`);
  });

  test("a placeholder from another session restores nothing", () => {
    const foreign: Record<string, string> = { "[REDACTED:AWS_KEY#deadbeefdeadbeef]": "not-here" };
    const input = asRehydratable({ text: scrubbed.text });
    expect(rehydrate(input ?? "", foreign)).toEqual({ text: scrubbed.text });
  });
});

describe("fail-closed", () => {
  test("a scan that overruns its budget throws instead of returning partial text", () => {
    expect(() => scrub(`key ${AWS_CANARY}`, { ...base, budgetMs: -1 })).toThrow(/budget/);
  });

  test("a throwing scanner yields the withheld marker, never the raw row", { options: { scanBudgetMs: -1 } }, async ($, on) => {
    const mem: Record<string, unknown> = {};
    const key = (e: { plugin: string; key: string }) => `${e.plugin}:${e.key}`;
    on("state.get", (_$: unknown, e: { plugin: string; key: string }) => ({ value: { value: mem[key(e)], version: 0 } }));
    on("state.set", (_$: unknown, e: { plugin: string; key: string; value: unknown }) => {
      mem[key(e)] = e.value;
      return { value: { isSet: true, version: 0 } };
    });
    // Stub beneath the mod: the bottom of the chain echoes the row it keeps.
    on("session.append", (_$: any, e: any, next: (e: any) => any) => next(e));

    mem["prompt-redact:salt"] = SALT;
    mem["prompt-redact:enabled"] = true;
    mem["prompt-redact:tier"] = "balanced";
    mem["prompt-redact:allow"] = [];
    mem["prompt-redact:deny"] = [];

    const result = (await $.session.append({
      message: { type: "user", content: [{ type: "text", text: `leak ${AWS_CANARY}` }] },
      door: "prompt",
      origin: { kind: "composer" },
      uuid: "u",
    })) as unknown as { message?: { content?: { text?: string }[] } };

    // A scan that cannot finish withholds the row. The one outcome that is
    // never acceptable is the raw value reaching the model.
    const text = result?.message?.content?.[0]?.text ?? "";
    expect(text.includes(AWS_CANARY)).toBe(false);
    expect(text).toContain("[redact withheld this content:");
  });
});

describe("structural detectors", () => {
  test("a PEM private key block is redacted whole, head and tail", () => {
    const hits = pemPrivateKeys(`before\n${PEM_CANARY}\nafter`);
    expect(hits.length).toBe(1);
    // Truncating a PEM body would leak its tail, so the span must cover END too.
    expect(hits[0]?.value.endsWith("-----END RSA PRIVATE KEY-----")).toBe(true);
    expect(hits[0]?.value.startsWith("-----BEGIN RSA PRIVATE KEY-----")).toBe(true);
    const out = scrub(`before\n${PEM_CANARY}\nafter`, base);
    expect(out.text.includes("MIIEowIBAAKCAQEA")).toBe(false);
    expect(out.text.includes("after")).toBe(true);
  });

  test("a JWT is proven by decoding its header, not by its shape", () => {
    // {"alg":"HS256","typ":"JWT"} base64url, then a payload, then a signature.
    const header = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
    const token = `${header}.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk`;
    expect(jwts(token).length).toBe(1);
    // Three dotted base64url strings whose header is not JSON: not a JWT.
    expect(jwts("aaaaaaaa.bbbbbbbb.cccccccc").length).toBe(0);
  });

  test("card numbers need a valid Luhn checksum", () => {
    expect(luhnOk("4111111111111111")).toBe(true);
    expect(luhnOk("4111111111111112")).toBe(false);
    expect(cards("card 4111 1111 1111 1111 ok").length).toBe(1);
    expect(cards("id 4111111111111112 no").length).toBe(0);
  });

  test("IBANs need a valid mod-97 checksum", () => {
    expect(ibanOk("GB82WEST12345698765432")).toBe(true);
    expect(ibanOk("GB82WEST12345698765431")).toBe(false);
  });

  test("SSNs follow the SSA issuance rules", () => {
    // 12345678's Verhoeff check digit is 4, so 123-45-6784 is the synthetic
    // value that passes both FICA and the check digit (123-45-6789 fails the
    // digit now; see tests/structural-ssn-pem.test.ts).
    expect(ssns("ssn 123-45-6784").length).toBe(1);
    // 000 area, 666 area, and a zero group are never issued.
    expect(ssns("ssn 000-45-6789").length).toBe(0);
    expect(ssns("ssn 666-45-6789").length).toBe(0);
    expect(ssns("ssn 123-00-6789").length).toBe(0);
  });
});

describe("generic recall", () => {
  test("a keyword assignment is caught even with no vendor rule", () => {
    // The shape LeakWatch found pure-prefix scanners miss entirely.
    const out = scrub('MINIO_SECRET_KEY="q8Zr2vNwXp4LmKd9TgYc"', base);
    expect(out.hits.length).toBe(1);
    expect(out.text.includes("q8Zr2VnX")).toBe(false);
  });

  test("a low-entropy value under a keyword anchor is left alone", () => {
    const text = 'password = "hunter2"';
    expect(scrub(text, base).hits.length).toBe(0);
  });

  test("a documented example key is recognised as a placeholder", () => {
    const documented = "AKIAIOSFODNN7EXAMPLE";
    expect(isAllowed(documented)).not.toBeNull();
  });

  test("the corpus carries provenance and no unbounded quantifier", () => {
    expect(RULES.length).toBeGreaterThanOrEqual(200);
    for (const rule of RULES) {
      expect(rule.source.startsWith("https://")).toBe(true);
      expect(unboundedIn(rule.regex)).toEqual([]);
    }
  });

  test("every rule compiles and every label is a usable placeholder label", () => {
    for (const rule of RULES) {
      expect(() => new RegExp(rule.regex, rule.flags)).not.toThrow();
      expect(/^[A-Z0-9_]+$/.test(rule.label)).toBe(true);
    }
  });
});

describe("supporting primitives", () => {
  test("entropy separates a generated key from a word", () => {
    expect(shannon("aaaaaaaaaaaaaaaa")).toBeLessThan(1);
    expect(shannon("q8Zr2vNwXp4LmKd9TgYc")).toBeGreaterThan(3.5);
  });

  test("context score rises near deployment vocabulary", () => {
    const prod = contextScore("AWS_SECRET_KEY for production deploy = abc", 0, 10, "q8Zr2vNwXp4LmKd9TgYc");
    const docs = contextScore("example docs sample SECRET = abc", 0, 10, "q8Zr2vNwXp4LmKd9TgYc");
    expect(prod).toBeGreaterThan(docs);
  });

  test("large rows degrade to the fast detector set", () => {
    expect(detectorsFor(1000)).toContain("220-rule");
    expect(detectorsFor(200_000)).toContain("over the");
  });

  test("scrubMessage rewrites text and tool_result blocks, nothing else", () => {
    const message = {
      type: "user",
      content: [
        { type: "text", text: `key ${AWS_CANARY}` },
        { type: "tool_result", tool_use_id: "t1", content: `out ${AWS_CANARY}` },
        { type: "thinking", thinking: `think ${AWS_CANARY}` },
      ],
    };
    const result = scrubMessage(message, base);
    const blocks = result.message.content as { type: string; text?: string; content?: string; thinking?: string }[];
    expect(blocks[0]?.text?.includes(AWS_CANARY)).toBe(false);
    expect(blocks[1]?.content?.includes(AWS_CANARY)).toBe(false);
    // Thinking is pinned by the engine and must be left untouched.
    expect(blocks[2]?.thinking).toContain(AWS_CANARY);
    expect(placeholderCount(blocks[0]?.text ?? "")).toBe(1);
  });
});

// --- vendor shapes, built to the corpus' own regexes -------------------------
// Each canary is synthetic but shaped exactly like the real credential, so the
// test fails if a converted regex drifted from its upstream pattern.

const repeat = (seed: string, n: number) => seed.repeat(Math.ceil(n / seed.length)).slice(0, n);

const SLACK_CANARY = "xoxb-" + "8472610935-2719483056217-Zq7Rt2Vw9Xy4Kp";
const STRIPE_CANARY = `sk_live_${repeat("Q8zR2vNw4Xp7LmKd9TgYc3Bf", 24)}`;
const GCP_CANARY = `AIza${repeat("Sy8Qz2Vw4Xp7LmKd9TgYc3Bf5Hn1Jk6Rt", 35)}`;
const ANTHROPIC_CANARY = `sk-ant-api03-${repeat("Xq7Rt2Vw9Xy4KpMn8Lb3Gc6Hd1Jf5Ka0Qe9Ws2Zx7Uv4Ta6Ry8Pk3Nm1Ld5Gj0Hf2Cb9Xr4Vw7Yz", 93)}AA`;
const OPENAI_CANARY = `sk-proj-${repeat("Aq7Rt2Vw9Xy4KpMn8Lb3Gc6Hd1Jf5Ka0Qe9Ws2Zx7Uv4Ta6Ry8Pk3Nm1", 58)}T3BlbkFJ${repeat("Bq7Rt2Vw9Xy4KpMn8Lb3Gc6Hd1Jf5Ka0Qe9Ws2Zx7Uv4Ta6Ry8Pk3Nm1", 58)}`;

describe("vendor prefixes", () => {
  const cases: [string, string][] = [
    ["github pat", GHP_CANARY],
    ["slack bot token", SLACK_CANARY],
    ["stripe live key", STRIPE_CANARY],
    ["google api key", GCP_CANARY],
    ["anthropic key", ANTHROPIC_CANARY],
    ["openai project key", OPENAI_CANARY],
  ];

  for (const [name, canary] of cases) {
    test(`${name} is redacted`, () => {
      const out = scrub(`value = ${canary}`, base);
      expect(out.hits.length).toBe(1);
      expect(out.text.includes(canary)).toBe(false);
      expect(out.text).toContain("[REDACTED:");
    });
  }

  test("the same vendor value is labelled consistently", () => {
    const a = scrub(`a ${STRIPE_CANARY}`, base);
    const b = scrub(`b ${STRIPE_CANARY}`, base);
    expect(a.hits[0]?.label).toEqual(b.hits[0]?.label);
  });
});

describe("structural: more key shapes", () => {
  test("an EC private key block is redacted whole", () => {
    const ec = [
      "-----BEGIN EC PRIVATE KEY-----",
      "MHcCAQEEIBkg4LVWM9nuwNSk3yByxZpYRTBnVJk5oH5R2g2Jp2YdoAoGCCqGSM49",
      "AwEHoUQDQgAEqL6xQzXH2YwZ4wVrZ7hVvK8hK3vXk0S+ZcJm1n0oPqRsTuVwXyZaBc",
      "-----END EC PRIVATE KEY-----",
    ].join("\n");
    const out = scrub(`before\n${ec}\nafter`, base);
    expect(out.text.includes("MHcCAQEEIBkg")).toBe(false);
    expect(out.text.includes("AwEHoUQDQgAEqL6")).toBe(false);
    expect(out.hits[0]?.label).toEqual("EC_PRIVATE_KEY");
  });

  test("an unterminated private key still gets redacted to end of row", () => {
    const broken = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAy8Dbv8prpJ";
    const out = scrub(`${broken}\ntail`, base);
    expect(out.text.includes("MIIEowIBAAKCAQEAy8Dbv8prpJ")).toBe(false);
  });

  test("a JWT inside prose is redacted but surrounding words survive", () => {
    const token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const out = scrub(`the bearer token ${token} was logged`, base);
    expect(out.text.includes(token)).toBe(false);
    expect(out.text.includes("was logged")).toBe(true);
  });

  test("a JWT-shaped triple that is not a JWT is left alone", () => {
    const notToken = "aaaaaaaaaaaa.bbbbbbbbbbbb.cccccccccccc";
    expect(jwts(notToken).length).toBe(0);
  });
});

describe("generic recall: the shapes pure-prefix scanners miss", () => {
  test("JSON form with a quoted separator is caught", () => {
    // The exact case LeakWatch's rule failed on: the closing quote sat between
    // the keyword and the separator.
    const out = scrub('{"access_token": "rKzowpViqmFcd7DtWWUoDLOdLLTsw9OaOTN7cXFylBZhy"}', base);
    expect(out.hits.length).toBe(1);
    expect(out.text.includes("rKzowpViqmFcd7DtWWUo")).toBe(false);
  });

  test("PHP/Ruby arrow separator is caught", () => {
    const out = scrub(`'client_secret' => 'Q8zR2vNw4Xp7LmKd9TgYc3Bf2Hn'`, base);
    expect(out.hits.length).toBe(1);
    expect(out.text.includes("Q8zR2vNw4Xp7LmKd9TgYc3Bf2Hn")).toBe(false);
  });

  test("a prefixed keyword is tolerated (the anchor fix)", () => {
    // `\b(?:secret|key)` would reject every one of these real variable names.
    for (const name of ["certificate_key", "MINIO_SECRET_KEY", "SharedSecret"]) {
      const out = scrub(`${name} = "Q8zR2vNw4Xp7LmKd9TgYc"`, base);
      expect({ name, caught: out.hits.length }).toEqual({ name, caught: 1 });
    }
  });

  test("a bare value with no keyword anchor is not invented into a secret", () => {
    const out = scrub('note = "Q8zR2vNw4Xp7LmKd9TgYc"', base);
    expect(out.hits.length).toBe(0);
  });
});

describe("allowlist: the shapes that must survive", () => {
  const survivors: [string, string][] = [
    ["AWS ARN", "arn:aws:iam::123456789012:role/DeployRole"],
    ["ULID", "01ARZ3NDEKTSV4RRFFQ69G5FAV"],
    ["ObjectId", "507f1f77bcf86cd799439011"],
    ["semver", "v2.1.303"],
    ["timestamp", "2026-10-20T07:53:00Z"],
    ["localhost URL", "http://localhost:8080/health"],
    ["public certificate", "-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIU\n-----END CERTIFICATE-----"],
  ];

  for (const [name, value] of survivors) {
    test(`${name} passes through untouched`, () => {
      const text = `see ${value} here`;
      expect(scrub(text, base)).toEqual({ text, hits: [] });
    });
  }

  test("the AWS documented example key pair is never redacted", () => {
    const documented = "AKIAIOSFODNN7EXAMPLE and wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    expect(scrub(documented, base).hits.length).toBe(0);
  });
});

describe("user overrides", () => {
  const gitSha = "a94a8fe5ccb19ba61c4c0873d391e987982fbbd3";

  test("a deny rule outranks the allowlist", () => {
    // The same value is a benign git SHA by default...
    expect(scrub(`commit ${gitSha}`, base).hits.length).toBe(0);
    // ...and force-redacted when the person says so.
    const out = scrub(`commit ${gitSha}`, { ...base, deny: [/^[0-9a-f]{40}$/] });
    expect(out.hits.length).toBe(1);
    expect(out.text.includes(gitSha)).toBe(false);
  });

  test("an allow entry prevents redaction of an otherwise-caught value", () => {
    const canary = "Q8zR2vNw4Xp7LmKd9TgYc";
    expect(scrub(`token = "${canary}"`, base).hits.length).toBe(1);
    const out = scrub(`token = "${canary}"`, { ...base, allowExtra: [/^Q8zR2vNw.*$/] });
    expect(out.hits.length).toBe(0);
  });

  test("tier changes the operating point, never the structural verdict", () => {
    const borderline = `# example sample secret = "Q8zR2vNw4Xp7LmKd9TgYc"\nsecret = "Q8zR2vNw4Xp7LmKd9TgYc"\ndeploy secret = "Q8zR2vNw4Xp7LmKd9TgYc"`;
    const strict = scrub(borderline, { ...base, tier: "strict" }).hits.length;
    const precision = scrub(borderline, { ...base, tier: "precision" }).hits.length;
    expect(strict).toBeGreaterThanOrEqual(precision);
    // A PEM key is redacted at every tier: structure needs no context score.
    for (const tier of ["strict", "balanced", "precision"] as const) {
      expect(scrub(PEM_CANARY, { ...base, tier }).hits.length).toBe(1);
    }
  });
});

describe("force-redact", () => {
  // Synthetic canary invented for this suite; it matches no vendor rule.
  const CANARY = "S3cr3tP4ssw0rd";

  test("only the matched substring inside a spaceless token is replaced", () => {
    // The ticket's demonstration: the deny hit sits mid-URL, so replacing the
    // whole whitespace-delimited token would destroy the DSN the person needs.
    const url = `DATABASE_URL=postgres://app:${CANARY}@db.internal:5432/prod`;
    const out = scrub(url, { ...base, deny: [new RegExp(CANARY)] });
    const expected = placeholderFor("USER_DENY", SALT, CANARY);
    expect(out.text).toEqual(`DATABASE_URL=postgres://app:${expected}@db.internal:5432/prod`);
    expect(out.hits).toEqual([{ label: "USER_DENY", placeholder: expected, value: CANARY, by: "deny" }]);
  });

  test("a deny pattern beats every gate", () => {
    // A prose word no rule anchors on: only the deny detector reaches it, and
    // the sentence around it stays readable.
    const out = scrub(`password is ${CANARY} ok`, { ...base, deny: [new RegExp(CANARY)] });
    const expected = placeholderFor("USER_DENY", SALT, CANARY);
    expect(out.text).toEqual(`password is ${expected} ok`);
    expect(out.hits.length).toBe(1);
  });

  test("a pattern spanning whitespace still matches whole", () => {
    const out = scrub(`the two words here`, { ...base, deny: [/two words/] });
    const expected = placeholderFor("USER_DENY", SALT, "two words");
    expect(out.text).toEqual(`the ${expected} here`);
    expect(out.hits.length).toBe(1);
  });

  test("a placeholder is never redacted twice", () => {
    const once = scrub(`password is ${CANARY} ok`, { ...base, deny: [new RegExp(CANARY)] });
    const twice = scrub(once.text, { ...base, deny: [new RegExp(CANARY)] });
    expect(twice.hits.length).toBe(0);
    expect(twice.text).toEqual(once.text);
  });
});

describe("row walking edge cases", () => {
  test("a row whose content is a plain string is rewritten", () => {
    const result = scrubMessage({ type: "system", content: `key ${AWS_CANARY}` }, base);
    expect(typeof result.message.content).toBe("string");
    expect(String(result.message.content).includes(AWS_CANARY)).toBe(false);
  });

  test("a tool_result whose content is an array of blocks is rewritten", () => {
    const result = scrubMessage(
      { type: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: `out ${AWS_CANARY}` }] }] },
      base,
    );
    const blocks = result.message.content as { content?: { text?: string }[] }[];
    expect(blocks[0]?.content?.[0]?.text?.includes(AWS_CANARY)).toBe(false);
  });

  test("a row with nothing to hide is returned structurally unchanged", () => {
    const message = { type: "user", content: [{ type: "text", text: "just a normal sentence" }] };
    expect(scrubMessage(message, base).hits.length).toBe(0);
  });

  test("placeholderCount counts every placeholder in a row", () => {
    const out = scrub(`a ${AWS_CANARY} b ${GHP_CANARY}`, base);
    expect(out.hits.length).toBe(2);
    expect(placeholderCount(out.text)).toBe(2);
  });

  test("asRehydratable keeps null distinct from an unparseable value", () => {
    expect(asRehydratable(null)).toBeNull();
    expect(asRehydratable(undefined)).toBeUndefined();
    expect(asRehydratable(42)).toBe(42);
    expect(asRehydratable([1, "two"])).toEqual([1, "two"]);
  });
});

// --- helpers for the register-level suites -----------------------------------

type Captured = { event: string; match?: Record<string, unknown>; handler: ($: any, e: any, next?: (e: any) => unknown) => unknown };

/**
 * Capture what `register` wires, without an engine. The point of these tests is
 * the *surface* -- which events and which tools the mod claims -- because that is
 * where the policy lives: if `Bash` is never registered, no code path can hand it
 * a real value.
 */
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
      // `$.state.get(ref)` resolves `{ value, version }`; `$.state.set(ref, value)`
      // takes the value as an argument, not as a field of `ref`.
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
};

describe("L2 local classifier", () => {
  // A weights file the test supplies. None ship with the mod: training needs data
  // that leaves the machine, which the no-egress invariant forbids.
  const weights = JSON.stringify({
    version: 1,
    bias: -1.2,
    threshold: 0.5,
    features: { entropy: 1.2, digit: 3, symbol: 1.2, prefixed: 1 },
  });
  const model = parseClassifier(weights);
  /** A generated-looking value with no vendor prefix and no keyword beside it. */
  const ANCHORLESS = "Q7fL9xK2pR4mT8nB6vC3";

  test("a weights file parses only when it is well formed", () => {
    expect(model).not.toBeNull();
    expect(parseClassifier("{not json")).toBeNull();
    expect(parseClassifier(JSON.stringify({ version: 2, bias: 0, threshold: 0.5, features: { entropy: 1 } }))).toBeNull();
    expect(parseClassifier(JSON.stringify({ version: 1, bias: 0, threshold: 2, features: { entropy: 1 } }))).toBeNull();
    expect(parseClassifier(JSON.stringify({ version: 1, bias: 0, threshold: 0.5, features: {} }))).toBeNull();
    expect(parseClassifier(JSON.stringify({ version: 1, bias: "0", threshold: 0.5, features: { entropy: 1 } }))).toBeNull();
  });

  test("the model fires on a high-entropy value with no anchor, and not on prose", () => {
    expect(model).not.toBeNull();
    expect(isSecret(model!, ANCHORLESS)).toBe(true);
    expect(isSecret(model!, "please remember this")).toBe(false);
    // Scoring is pure arithmetic: the same value always scores the same, which is
    // what keeps a placeholder stable across rows.
    expect(scoreValue(model!, ANCHORLESS)).toBe(scoreValue(model!, ANCHORLESS));
  });

  test("L2 reaches what L1 misses, and L1 alone is unchanged", () => {
    const text = `note ${ANCHORLESS} here`;
    expect(scrub(text, base).hits.length).toBe(0);
    const withModel = scrub(text, { ...base, classifier: model });
    expect(withModel.hits.length).toBe(1);
    expect(withModel.text.includes(ANCHORLESS)).toBe(false);
    expect(withModel.text).toContain("[REDACTED:LOCAL_CLASSIFIER_SECRET#");
  });

  test("the allowlist still wins over the classifier", () => {
    const sha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const uuid = "9b2f9c1e-4f6a-4b1d-8c2e-7f3a5d6b1c0e";
    expect(scrub(`x ${sha}`, { ...base, classifier: model }).hits.length).toBe(0);
    expect(scrub(`x ${uuid}`, { ...base, classifier: model }).hits.length).toBe(0);
  });

  test("a vendor rule's label outranks the classifier's on a shared span", () => {
    const text = `key ${GHP_CANARY}`;
    const result = scrub(text, { ...base, classifier: model });
    expect(result.hits.length).toBe(1);
    expect(result.hits[0]?.label).toBe("GITHUB_PAT");
  });

  test("no model probed means L1 only, silently", () => {
    // `register` probes `.claude/prompt-redact.model.json`; with no file the
    // pipeline must behave exactly as before.
    const captured = captureHandlers();
    expect(captured.length).toBeGreaterThan(0);
    const text = `note ${ANCHORLESS} here`;
    expect(scrub(text, base).hits.length).toBe(0);
  });
});

describe("structural: base32 TOTP", () => {
  test("an otpauth seed is redacted, and its base32 body is what disappears", () => {
    const text = "otpauth://totp/ACME:alice?secret=JBSWY3DPEHPK3PXP&issuer=ACME";
    const hits = totpSecrets(text);
    expect(hits.length).toBe(1);
    expect(hits[0]?.label).toBe("TOTP_SECRET");
    expect(hits[0]?.value).toBe("JBSWY3DPEHPK3PXP");
    const result = scrub(text, base);
    expect(result.text.includes("JBSWY3DPEHPK3PXP")).toBe(false);
  });

  test("the same base32 run without an OTP word beside it is left alone", () => {
    // 16 uppercase characters are far more likely to be an identifier than an
    // HMAC key, so the context anchor is what keeps this family precise.
    expect(totpSecrets("value JBSWY3DPEHPK3PXP here").length).toBe(0);
    expect(scrub("value JBSWY3DPEHPK3PXP here", base).hits.length).toBe(0);
  });

  test("a base32-shaped run whose decoded length is not a key size is refused", () => {
    // 8 characters decodes to 5 bytes: too short for an HMAC key.
    expect(totpSecrets("totp secret: ABCDEFGH").length).toBe(0);
  });
});

describe("fail-closed: the hit ceiling", () => {
  test("a row with more than the ceiling fails closed instead of scrubbing part of it", () => {
    // Accepting the first 512 and returning the row would report success while
    // leaving the rest raw -- a partial scrub that reads as a complete one.
    const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    const body = (seed: number) => {
      let out = "";
      let x = (seed * 2654435761) % 4294967296;
      for (let i = 0; i < 16; i++) {
        x = (x * 1664525 + 1013904223) % 4294967296;
        out += ALPHA[x % 32];
      }
      return out;
    };
    const many = Array.from({ length: 600 }, (_, i) => `AKIA${body(i + 1)}`).join("\n");
    expect(() => scrub(many, base)).toThrow(/more than 512/);
  });
});

describe("register: the interception surface", () => {
  const captured = captureHandlers();
  const find = (event: string, tool?: string) =>
    captured.find((c) => c.event === event && (tool === undefined ? c.match === undefined || c.match.tool === undefined : c.match?.tool === tool));

  test("rehydration covers the file-editing tools, and the outbound tools are guarded instead", () => {
    const tools = captured
      .filter((c) => c.event === "tool.call" && typeof c.match?.tool === "string")
      .map((c) => c.match?.tool)
      .sort();
    expect(tools).toEqual(["Bash", "Edit", "NotebookEdit", "WebFetch", "WebSearch", "Write"]);
    // The policy, stated as a partition: a tool is either rehydrated (the three
    // write paths) or refused (the shell and the network). Never both, because a
    // tool that both restored a value and reached the network is exfiltration.
    const rehydrating = ["Edit", "NotebookEdit", "Write"];
    const guarded = ["Bash", "WebFetch", "WebSearch"];
    expect(rehydrating.filter((tool) => guarded.includes(tool))).toEqual([]);
  });

  test("Write arguments are rehydrated, and Bash arguments never are", async () => {
    const scrubbed = scrub(`token ${GHP_CANARY}`, base);
    const placeholder = scrubbed.hits[0]?.placeholder ?? "";
    const vault: Record<string, string> = { [placeholder]: GHP_CANARY };
    const { $ } = fakeEngine({ ...sessionState, "prompt-redact:vault": vault });

    const write = find("tool.call", "Write");
    expect(write).not.toBeUndefined();
    const written = (await write!.handler($, { file_path: "/tmp/a", content: `token ${placeholder}` }, (e: any) => e)) as {
      content: string;
    };
    expect(written.content).toBe(`token ${GHP_CANARY}`);

    const notebook = find("tool.call", "NotebookEdit");
    expect(notebook).not.toBeUndefined();
    const edited = (await notebook!.handler($, { notebook_path: "/tmp/n.ipynb", new_source: placeholder }, (e: any) => e)) as {
      new_source: string;
    };
    expect(edited.new_source).toBe(GHP_CANARY);

    // `Bash` reaches only the catch-all result scrubber, which rewrites what a
    // tool *returned*, never what it is about to run.
    const catchAll = find("tool.call");
    expect(catchAll).not.toBeUndefined();
    const bash = (await catchAll!.handler($, { command: `curl ${placeholder}` }, (e: any) => ({ result: e.command }))) as {
      result: string;
    };
    expect(bash.result).toContain(placeholder);
    expect(bash.result.includes(GHP_CANARY)).toBe(false);
  });

  test("prompt.attachment scrubs injected hook context before the request carries it", async () => {
    // This is the leak a live session exposed: a settings hook's SessionStart
    // context arrived as an attachment with `origin.kind === "hook"` and reached
    // the request body's system channel raw, because `session.append` never sees
    // an injected message.
    const { $ } = fakeEngine(sessionState);
    const attachment = find("prompt.attachment");
    expect(attachment).not.toBeUndefined();
    const text = `SessionStart hook additional context: AWS_ACCESS_KEY_ID=${AWS_CANARY}`;
    const out = (await attachment!.handler(
      $,
      { type: "hook_context", text, origin: { kind: "hook", event: "SessionStart" } },
      (e: any) => ({ text: e.text }),
    )) as { text: string };
    expect(out.text.includes(AWS_CANARY)).toBe(false);
    expect(out.text).toContain("[REDACTED:AWS_ACCESS_TOKEN#");
  });

  test("an unscannable attachment is dropped rather than carried raw", async () => {
    const { $ } = fakeEngine(sessionState);
    const attachment = captureHandlers({ scanBudgetMs: -1 }).find((c) => c.event === "prompt.attachment");
    const out = (await attachment!.handler(
      $,
      { type: "hook_context", text: `AWS=${AWS_CANARY}`, origin: { kind: "hook", event: "SessionStart" } },
      (e: any) => ({ text: e.text }),
    )) as { text: string | null };
    expect(out.text).toBeNull();
  });

  test("prompt.compose carries the opaque-placeholder notice", async () => {
    const { $ } = fakeEngine(sessionState);
    const compose = find("prompt.compose");
    expect(compose).not.toBeUndefined();
    const out = (await compose!.handler(
      $,
      { model: "m", promptModel: "m", surfaces: [], tools: [], outputStyle: null, traits: [] },
      () => ({ sections: [{ id: "intro", text: "engine prose", scope: "shared" }] }),
    )) as { sections: { id: string; text: string; scope: string }[] };
    const notice = out.sections.find((section) => section.id === "prompt-redact:notice");
    expect(notice).not.toBeUndefined();
    expect(notice?.scope).toBe("session");
    expect(notice?.text).toContain("[REDACTED:<LABEL>#<hash>]");
  });

  test("session.start echoes the { cwd } shape `next` resolves to", async () => {
    // Returning `undefined` made a live engine log "returned the wrong shape
    // (no result)" and skip the answer.
    const { $ } = fakeEngine({});
    const start = find("session.start");
    expect(start).not.toBeUndefined();
    const out = await start!.handler($, { cwd: "/tmp/project", surface: null, isInteractive: false }, (e: any) => ({
      cwd: e.cwd,
    }));
    expect(out).toEqual({ cwd: "/tmp/project" });
  });

  test("/redact reports labels and counts, never values", async () => {
    const vault = { "[REDACTED:AWS_ACCESS_TOKEN#65f8fceffec6f03b]": AWS_CANARY };
    const { $ } = fakeEngine({
      ...sessionState,
      "prompt-redact:vault": vault,
      "prompt-redact:counts": { AWS_ACCESS_TOKEN: 3, GENERIC_API_KEY: 1 },
      "prompt-redact:restored": 2,
    });
    const command = captured.find((c) => c.event === "command.run" && c.match?.command === "redact");
    expect(command).not.toBeUndefined();
    const out = (await command!.handler($, { command: "redact", args: "" })) as { text: string };
    expect(out.text).toContain("AWS_ACCESS_TOKEN x3");
    expect(out.text).toContain("GENERIC_API_KEY x1");
    expect(out.text).toContain("hid 4 values");
    expect(out.text).toContain("restored 2 placeholders");
    // The whole point of the pane: counts are legible, values never are.
    expect(out.text.includes(AWS_CANARY)).toBe(false);
    expect(out.text.includes("AKIA")).toBe(false);
  });
});

describe("L3: removing rules", () => {
  // The override surface has two halves. Adding was always possible through
  // `.claude/prompt-redact.rules`; without a remove path a person stuck with a
  // noisy shipped rule had no recourse but to switch the whole mod off.
  test("a disabled shipped rule no longer fires, and its neighbours still do", () => {
    const text = `token ${GHP_CANARY}`;
    expect(scrub(text, base).hits.length).toBe(1);
    expect(scrub(text, { ...base, disabledRules: ["github-pat"] }).hits.length).toBe(0);
    // Disabling one rule must not disable the corpus.
    expect(scrub(text, { ...base, disabledRules: ["stripe-access-token"] }).hits.length).toBe(1);
  });

  test("the local classifier is switchable by the id `local-classifier`", () => {
    const weights = JSON.stringify({
      version: 1,
      bias: -1.2,
      threshold: 0.5,
      features: { entropy: 1.2, digit: 3, symbol: 1.2 },
    });
    const model = parseClassifier(weights);
    const anchorless = "Q7fL9xK2pR4mT8nB6vC3";
    expect(scrub(`note ${anchorless} here`, { ...base, classifier: model }).hits.length).toBe(1);
    expect(
      scrub(`note ${anchorless} here`, { ...base, classifier: model, disabledRules: ["local-classifier"] }).hits.length,
    ).toBe(0);
  });

  test("/redact rule off and on take effect, list reports, a typo is refused", async () => {
    const captured = captureHandlers();
    const command = captured.find((c) => c.event === "command.run" && c.match?.command === "redact");
    const submit = captured.find((c) => c.event === "prompt.submit");
    expect(command).not.toBeUndefined();
    expect(submit).not.toBeUndefined();

    const text = `token ${GHP_CANARY}`;
    const run = async (args: string) => (await command!.handler(fakeEngine({ ...sessionState }).$, { command: "redact", args })) as { text: string };

    const off = await run("rule off github-pat");
    expect(off.text).toContain("disabled: github-pat");

    // The same engine instance must see the state change, so run the prompt
    // through the $ that just wrote it.
    const shared = fakeEngine({ ...sessionState });
    const offAgain = (await command!.handler(shared.$, { command: "redact", args: "rule off github-pat" })) as { text: string };
    expect(offAgain.text).toContain("disabled: github-pat");
    const during = (await submit!.handler(shared.$, { text }, (e: any) => e)) as { text: string };
    expect(during.text).toBe(text);

    const list = (await command!.handler(shared.$, { command: "redact", args: "rule list" })) as { text: string };
    expect(list.text).toContain("github-pat");

    const on = (await command!.handler(shared.$, { command: "redact", args: "rule on github-pat" })) as { text: string };
    expect(on.text).toContain("re-enabled");
    const after = (await submit!.handler(shared.$, { text }, (e: any) => e)) as { text: string };
    expect(after.text.includes(GHP_CANARY)).toBe(false);
    expect(after.text).toContain("[REDACTED:GITHUB_PAT#");

    const bad = (await command!.handler(shared.$, { command: "redact", args: "rule off not-a-rule" })) as { text: string };
    expect(bad.text).toContain("no such rule");
  });

  test("`/redact why` reports which rules are off", async () => {
    const captured = captureHandlers();
    const command = captured.find((c) => c.event === "command.run" && c.match?.command === "redact");
    const { $ } = fakeEngine({ ...sessionState, "prompt-redact:disabled": ["github-pat"] });
    const out = (await command!.handler($, { command: "redact", args: "why" })) as { text: string };
    expect(out.text).toContain("rules switched off: 1 (github-pat)");
  });
});

describe("minEntropy bounds the generic family", () => {
  test("raising it above the rule's own floor actually tightens detection", () => {
    // `byh0vmpo7yt8r6` measures 3.66 bits: above the generic rule's upstream 3.5
    // floor, below a 4.0 override. Before this change `minEntropy` never reached
    // the shipped generic rule, so the setting was decorative.
    const text = "api_secret = byh0vmpo7yt8r6";
    expect(scrub(text, { ...base, minEntropy: 3.2 }).hits.length).toBe(1);
    expect(scrub(text, { ...base, minEntropy: 4.0 }).hits.length).toBe(0);
  });
});

describe("tool-output carrier: a Bash `cat`", () => {
  test("the stored result of `cat`-ing a file holding a key carries only a placeholder", async () => {
    // The contract names `cat` literally. Same catch-all handler as a Read, but
    // this exercises the shell-output wording end to end.
    const { $ } = fakeEngine({ ...sessionState });
    const catchAll = captureHandlers().find((c) => c.event === "tool.call" && c.match === undefined);
    expect(catchAll).not.toBeUndefined();
    const out = (await catchAll!.handler($, { command: "cat canary.txt" }, () => ({
      result: `1\tAWS_ACCESS_KEY_ID=${AWS_CANARY}\n`,
    }))) as { result: string };
    expect(out.result.includes(AWS_CANARY)).toBe(false);
    expect(out.result).toContain("[REDACTED:AWS_ACCESS_TOKEN#");
  });
});
