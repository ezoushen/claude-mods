// The rule corpus, as a module.
//
// `rules.generated.ts` is generated data: 220 rules with per-rule provenance,
// written by `tools/gen-rules.py` from gitleaks (MIT) and never edited by hand.
// This file is the API the rest of the mod imports, so the engine has one place
// to read "what rules exist" without depending on the generator's output layout.
//
// Keeping the generated data and the accessor apart matters for review: the gate
// (`tools/check-rules.mjs`) checks the data file directly, so a change to this
// accessor cannot hide a rule that lost its provenance.

import { RULES as GENERATED_RULES, type Rule } from "./rules.generated.ts";

export {
  CORPUS_SHA256,
  GLOBAL_ALLOW_REGEXES,
  GLOBAL_STOPWORDS,
  type Rule,
} from "./rules.generated.ts";

export { ALLOWLIST, isAllowed, type AllowEntry } from "./allowlist.ts";

/**
 * The id a person writes after `/redact rule off` to silence the field-name
 * password detector.
 *
 * The detector is engine-owned rather than gitleaks-derived: its rule is the
 * field name, and it deliberately runs without an entropy floor, which the
 * generated corpus cannot express. Listing it here puts it on the same L3 id
 * surface as every shipped rule.
 */
export const PASSWORD_VALUE_RULE_ID = "password-value";

const PASSWORD_VALUE_DESCRIPTOR: Rule = {
  id: PASSWORD_VALUE_RULE_ID,
  label: "PASSWORD_VALUE",
  // Never compiled into the corpus scan (scrub.ts filters ENGINE_RULE_IDS); the
  // id exists so L3 can validate it. A never-matching source keeps an accidental
  // compile inert rather than redacting the word "password".
  regex: "(?!)",
  flags: "",
  groups: 0,
  secretGroup: null,
  entropy: null,
  keywords: [],
  allow: [],
  kind: "generic",
  source: "https://github.com/ezoushen/claude-mods/blob/main/prompt-redact/hooks/scrub.ts#password-value",
};

/**
 * Every id L3 may switch. The generated corpus first, then engine-owned
 * detectors that are not part of it. `scrub.ts` excludes the latter from the
 * corpus scan and runs each in its own pass.
 */
export const RULES: readonly Rule[] = [...GENERATED_RULES, PASSWORD_VALUE_DESCRIPTOR];

/** Rules grouped by the family that makes them cheap to run. */
export function rulesByKind(): { prefix: Rule[]; vendorKeyword: Rule[]; generic: Rule[] } {
  const prefix: Rule[] = [];
  const vendorKeyword: Rule[] = [];
  const generic: Rule[] = [];
  for (const rule of GENERATED_RULES) {
    if (rule.kind === "prefix") prefix.push(rule);
    else if (rule.kind === "generic") generic.push(rule);
    else vendorKeyword.push(rule);
  }
  return { prefix, vendorKeyword, generic };
}

/** The generated corpus size, for log lines and `/redact why`. */
export function ruleCount(): number {
  return GENERATED_RULES.length;
}
