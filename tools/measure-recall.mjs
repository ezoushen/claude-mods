#!/usr/bin/env node
// Measured per-tier recall for the redaction ladder.
//
//   node tools/measure-recall.mjs [--json]
//
// The research record used to list "design targets". A target is not evidence:
// it says what the author hoped for. This tool measures what the detector
// actually does on a labelled, synthetic fixture set, so the coverage matrix can
// carry real numbers and the gaps can be stated as gaps.
//
// Every value here is invented for the test. No fixture is, or derives from, a
// real credential.
//
// Tiers, following the vocabulary in the research record:
//   T1  vendor-prefixed credentials       (AKIA..., ghp_..., xoxb-., sk_live_...)
//   T2  generic keyword-anchored secrets  (`password = ...` with a keyword)
//   T3  prose / multilingual passwords    (no anchor at all: the known gap)
//   T4  self-proving structural shapes    (PEM, JWT, IBAN, card, SSN, TOTP)
//   T5  shapeless proprietary values      (high entropy, no prefix, no keyword)
//   T6  benign high-entropy shapes        (precision control: must NOT redact)
//
// L1 is the rule corpus plus structural detectors. L2 adds the optional local
// classifier. T6 is measured as a false-positive rate, not recall.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { scrub } = await import(join(ROOT, "prompt-redact/hooks/scrub.ts"));
const { parseClassifier } = await import(join(ROOT, "prompt-redact/hooks/classifier.ts"));

const base = { salt: "measure-salt", tier: "balanced", minEntropy: 3.2, budgetMs: 5000 };

/** The synthetic L2 weights used for the L1+L2 column. None ship with the mod. */
const model = parseClassifier(
  readFileSync(join(ROOT, "prompt-redact/tests/fixtures/classifier.example.json"), "utf8"),
);

// --- fixtures ---------------------------------------------------------------

const cases = [];

function add(tier, expected, text) {
  cases.push({ tier, expected, text });
}

// T1: a vendor prefix is its own anchor.
add("T1", true, `aws_key = ${"AKIA" + "ZZ7Q3CANARYONLYX"}`);
add("T1", true, `token ${"ghp_" + "Zz9QwErTyUiOpAsDfGhJkLzXcVbNm12AbCdEf"}`);
add("T1", true, `slack ${"xoxb-" + "2048193720-2048193721-AbCdEfGhIjKlMnOpQrStUvWx"}`);
add("T1", true, `stripe ${"sk_" + "live_" + "Q8zR2vNw4Xp7LmKd9TgYc3Bf2Hn"}`);
add("T1", true, "google AIzaSyDZz9QwErTyUiOpAsDfGhJkLzXcVbNm12A");
// Real npm tokens are lowercase base62, 36 characters after the prefix.
add("T1", true, "npm npm_z8q2lm9pw4rt7yv3nb6cd1hf4jk8lm2np6qr");

// T2: a keyword beside the value is the anchor.
add("T2", true, "DATABASE_PASSWORD = Q7fL9xK2pR4mT8nB6vC3");
add("T2", true, 'api_secret: "Zx8Kq2Lm9Pw4Rt7Yv3Nb6Cd1"');
add("T2", true, "export ACCESS_TOKEN=Hf4Jk8Lm2Np6Qr9St3Vw7Xy1");
add("T2", true, "client_credential => Gt5Hy9Ju3Kv7Lw2Mz6Nb8Cd4");
add("T2", true, "auth_key := Rm2Tn6Uy8Vp4Ws9Xz3Ab5Cd7");

// T3: prose and multilingual. No prefix, no keyword, nothing structural -- this
// is the tier where regex recall collapses, and the reason L2 exists.
add("T3", true, "the phrase is Waldkaffee27 and it opens the gate");
add("T3", true, "mein Passwort lautet Sommerberg-2019");
add("T3", true, "use MoonlightRequiem as the passphrase");
add("T3", true, "remember: kaffeemaschine!Berlin");
add("T3", true, "la clave es NieveProfunda42");

// T4: self-proving shapes.
add("T4", true, [
  "-----BEGIN RSA PRIVATE KEY-----",
  "MIIEowIBAAKCAQEAy8Dbv8prpJ/0kKhlGeJYozo2t60EG8L0561g13R29LvMR5hy",
  "-----END RSA PRIVATE KEY-----",
].join("\n"));
add("T4", true, "session eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.Zx8Kq2Lm9Pw4Rt7Yv3Nb6Cd1Hf4Jk8Lm2Np6Qr9St3V");
add("T4", true, "account GB82WEST12345698765432");
add("T4", true, "card 4111 1111 1111 1111");
add("T4", true, "ssn 123-45-6789");
add("T4", true, "totp secret JBSWY3DPEHPK3PXP");

// T5: shapeless proprietary values. High entropy, no prefix, no keyword.
add("T5", true, "the value is Q7fL9xK2pR4mT8nB6vC3 here");
add("T5", true, "value Zx8Kq2Lm9Pw4Rt7Yv3Nb6Cd1 was used");
add("T5", true, "it was Hf4Jk8Lm2Np6Qr9St3Vw7Xy1 before");

// T6: precision control. Redacting any of these breaks real work.
add("T6", false, "commit a94a8fe5ccb19ba61c4c0873d391e987982fbbd3");
add("T6", false, "request 9b2f9c1e-4f6a-4b1d-8c2e-7f3a5d6b1c0e");
add("T6", false, "digest e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
add("T6", false, "$2b$12$KIXQhE9nU3QZ0lQ1oQ5YQeJ9Q1oQ5YQeJ9Q1oQ5YQeJ9Q1o");
add("T6", false, "key ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl");
add("T6", false, "img data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==");
add("T6", false, "sri sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uxy9rx7HNQlGxYAMjNwY3f9kPJmw1aC");
add("T6", false, "password placeholder changeme");
add("T6", false, "env ${DATABASE_PASSWORD}");
add("T6", false, "arn arn:aws:iam::123456789012:role/example");

// --- measurement ------------------------------------------------------------

function measure(options, label) {
  const byTier = new Map();
  for (const c of cases) {
    const result = scrub(c.text, options);
    const redacted = result.hits.length > 0;
    const entry = byTier.get(c.tier) ?? { total: 0, hit: 0, fp: 0 };
    entry.total += 1;
    if (c.expected) {
      if (redacted) entry.hit += 1;
    } else if (redacted) {
      entry.fp += 1;
    }
    byTier.set(c.tier, entry);
  }
  const rows = [];
  for (const tier of ["T1", "T2", "T3", "T4", "T5", "T6"]) {
    const entry = byTier.get(tier);
    if (!entry) continue;
    const positives = cases.filter((c) => c.tier === tier && c.expected).length;
    const negatives = cases.filter((c) => c.tier === tier && !c.expected).length;
    rows.push({
      tier,
      label,
      cases: entry.total,
      recall: positives > 0 ? entry.hit / positives : null,
      falsePositiveRate: negatives > 0 ? entry.fp / negatives : null,
      hit: entry.hit,
      positives,
      fp: entry.fp,
      negatives,
    });
  }
  return rows;
}

const l1 = measure(base, "L1");
const l2 = model ? measure({ ...base, classifier: model }, "L1+L2") : [];

const pct = (n) => (n === null ? "n/a" : `${(n * 100).toFixed(0)}%`);

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ fixtures: cases.length, l1, l2 }, null, 2));
} else {
  console.log(`fixtures: ${cases.length} synthetic cases (no real credential)\n`);
  console.log("tier  meaning                          L1 recall   +L2 recall   L1 FP");
  const meaning = {
    T1: "vendor-prefixed credential",
    T2: "generic keyword-anchored",
    T3: "prose / multilingual password",
    T4: "self-proving structural shape",
    T5: "shapeless proprietary value",
    T6: "benign high-entropy (control)",
  };
  for (const [i, row] of l1.entries()) {
    const withL2 = l2[i];
    console.log(
      `${row.tier}    ${meaning[row.tier].padEnd(32)} ${pct(row.recall).padEnd(11)} ${
        withL2 ? pct(withL2.recall) : "n/a"
      }          ${pct(row.falsePositiveRate)}`,
    );
  }
  console.log(
    "\nL1 = structural detectors + the generated rule corpus + allowlist + context score." +
      "\nL2 = the same, plus the optional local classifier (a weights file read from disk).",
  );
}
