#!/usr/bin/env node
// Integrity gate for the redaction corpus. Run from the repo root:
//
//   node tools/check-rules.mjs
//
// It answers one question honestly: can every rule be trusted to exist, point at
// a public source, compile in JavaScript, and terminate? A rule that silently
// disappeared, lost its provenance, or kept an unbounded repetition would be a
// false negative in a redactor -- the one failure mode that cannot be taken back.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const notes = [];

function fail(message) {
  failures.push(message);
}

function ok(message) {
  notes.push(message);
}

// --- corpus -----------------------------------------------------------------

const { RULES, CORPUS_SHA256, GLOBAL_ALLOW_REGEXES, GLOBAL_STOPWORDS } = await import(
  join(ROOT, "prompt-redact/hooks/rules.generated.ts")
);

if (RULES.length < 200) fail(`rule corpus shrank to ${RULES.length}, expected >= 200`);
else ok(`rule corpus: ${RULES.length} rules (gitleaks.toml sha256 ${CORPUS_SHA256.slice(0, 12)})`);

const seenIds = new Set();
const unbounded = [];
const uncompilable = [];

// --- quantifier scanner -----------------------------------------------------
// Shared with the test suite (hooks/quantifiers.ts), so the gate and the tests
// cannot drift apart on what "bounded" means.
const { unboundedIn } = await import(join(ROOT, "prompt-redact/hooks/quantifiers.ts"));

for (const rule of RULES) {
  // Provenance: a rule with no source cannot be reviewed or updated.
  if (typeof rule.source !== "string" || !rule.source.startsWith("https://")) {
    fail(`rule ${rule.id}: missing or non-https provenance`);
  }
  if (!rule.source.includes("#")) {
    fail(`rule ${rule.id}: provenance does not anchor to the rule id`);
  }
  // Identity.
  if (!rule.id || seenIds.has(rule.id)) fail(`rule ${rule.id}: missing or duplicate id`);
  seenIds.add(rule.id);
  if (!/^[A-Z0-9_]+$/.test(rule.label)) fail(`rule ${rule.id}: label ${rule.label} is not placeholder-safe`);
  // Anchor: a rule needs either a keyword prefilter or a literal prefix, or it
  // would run against every row -- the cost that made the generic rule slow.
  const anchored = rule.keywords.length > 0 || rule.kind === "prefix" || rule.kind === "generic";
  if (!anchored) fail(`rule ${rule.id}: no keyword, prefix anchor or generic classification`);
  // Bounded repetition: any unbounded quantifier over a row with no newline
  // budget is how a redactor turns into a denial-of-service primitive.
  const bare = unboundedIn(rule.regex);
  if (bare.length > 0) unbounded.push(`${rule.id} (${bare.slice(0, 3).join(" ")})`);
  // Compilation.
  try {
    new RegExp(rule.regex, rule.flags);
  } catch (error) {
    uncompilable.push(`${rule.id}: ${error.message}`);
  }
}

// A gate that cannot fail is decoration. Prove the scanner catches the shapes it
// exists for, and does not flag literals, before trusting its verdict.
const scannerCases = [
  ["xoxb-[0-9]{10,13}[a-zA-Z0-9-]*", true, "bare star at the tail"],
  ["xapp-\\d-[A-Z0-9]+", true, "bare plus"],
  ["a{10,}", true, "open-ended brace"],
  ["[a-zA-Z0-9-]*", true, "bare star on a class"],
  ["\\*escaped", false, "escaped asterisk is a literal"],
  ["[*+]", false, "quantifiers inside a class are literals"],
  ["[]*]", false, "a leading ] is a literal class member"],
  ["a.{0,4096}b", false, "already capped"],
];
for (const [pattern, expected, why] of scannerCases) {
  const got = unboundedIn(pattern).length > 0;
  if (got !== expected) {
    fail(`quantifier scanner self-check failed for ${why}: ${pattern} -> ${got ? "flagged" : "clean"}`);
  }
}
ok(`quantifier scanner self-check: ${scannerCases.length} cases`);

if (unbounded.length) fail(`unbounded quantifiers in ${unbounded.length} rule(s): ${unbounded.slice(0, 5).join(", ")}`);
else ok("every rule has bounded repetition");

if (uncompilable.length) fail(`rules that do not compile: ${uncompilable.slice(0, 5).join("; ")}`);
else ok("every rule compiles as a JavaScript RegExp");

ok(`global allowlist: ${GLOBAL_ALLOW_REGEXES.length} regexes, ${GLOBAL_STOPWORDS.length} stopwords`);

// --- allowlist --------------------------------------------------------------

const { ALLOWLIST } = await import(join(ROOT, "prompt-redact/hooks/allowlist.ts"));

if (ALLOWLIST.length < 20) fail(`allowlist has ${ALLOWLIST.length} entries, expected >= 20`);
else ok(`allowlist: ${ALLOWLIST.length} benign shapes named`);
for (const entry of ALLOWLIST) {
  if (!entry.why || entry.why.length < 10) fail("allowlist entry without a stated reason");
}

// --- RULES.md parity --------------------------------------------------------

const rulesMd = readFileSync(join(ROOT, "prompt-redact/RULES.md"), "utf8");
const mdRows = rulesMd.split("\n").filter((line) => line.startsWith("| `"));
if (mdRows.length !== RULES.length) {
  fail(`RULES.md has ${mdRows.length} provenance rows for ${RULES.length} rules`);
} else {
  ok(`RULES.md: one provenance row per rule (${mdRows.length})`);
}
for (const rule of RULES) {
  if (!rulesMd.includes(`\`${rule.id}\``)) fail(`rule ${rule.id} has no RULES.md row`);
}

// The head prose is generated too. Stating a fact there that the corpus contradicts
// ("only one generic rule") is how a hand edit reverted by `python3 tools/gen-rules.py`
// goes unnoticed, so cross-check the facts it asserts against the corpus itself.
const genericRules = RULES.filter((rule) => rule.kind === "generic");
const statedGeneric = rulesMd.match(/`generic` reads \*\*(\d+)\*\*/);
if (!statedGeneric) {
  fail("RULES.md does not state how many rules are in the generic family");
} else if (Number(statedGeneric[1]) !== genericRules.length) {
  fail(`RULES.md says ${statedGeneric[1]} generic rules; the corpus has ${genericRules.length}`);
} else {
  ok(`RULES.md: stated generic count matches the corpus (${genericRules.length})`);
}
for (const rule of genericRules) {
  // Once in the explanation, once in the provenance table: a rule that is only
  // tabulated is a rule whose family is unexplained.
  const mentions = rulesMd.split(`\`${rule.id}\``).length - 1;
  if (mentions < 2) {
    fail(`generic rule ${rule.id} is tabulated but not explained in the RULES.md head`);
  }
}
ok(`RULES.md: every generic rule is explained, not just tabulated (${genericRules.length})`);

// --- coverage matrix --------------------------------------------------------

const researchPath = join(ROOT, "research/prompt-redaction.md");
let research = "";
try {
  research = readFileSync(researchPath, "utf8");
} catch {
  fail("research/prompt-redaction.md is missing");
}
if (research && !/tier\s*[×x]\s*carrier/i.test(research)) {
  fail("research/prompt-redaction.md is missing the tier x carrier coverage matrix");
}
if (research && research.length < 800) {
  fail("research/prompt-redaction.md is too thin to be a coverage record");
}
if (research) ok(`coverage record: research/prompt-redaction.md (${research.length} chars)`);

// --- structural replacement parity -----------------------------------------

const structural = readFileSync(join(ROOT, "prompt-redact/hooks/structural.ts"), "utf8");
if (!structural.includes("pemPrivateKeys")) fail("structural.ts no longer covers PEM private keys");
if (seenIds.has("private-key")) {
  fail("`private-key` is both a regex rule and structurally scanned; it must be only one");
}
ok("private-key is handled structurally (a capped regex would leak the key's tail)");

// --- report -----------------------------------------------------------------

for (const note of notes) console.log(`ok   ${note}`);
if (failures.length) {
  console.error("");
  for (const message of failures) console.error(`FAIL ${message}`);
  console.error(`\n${failures.length} integrity failure(s).`);
  process.exit(1);
}
console.log(`\ncorpus integrity verified: ${RULES.length} rules, ${ALLOWLIST.length} allowlist entries.`);
