// The scrub engine: pure functions, no `$`, no I/O. register.ts owns state; this
// file owns the decision "is this span a secret, and what does it become".
//
// Shape of a decision, in order:
//
//   1. structural detectors (PEM, JWT, IBAN, Luhn, SSA) -- self-proving, so they
//      are accepted without an entropy gate and always win span conflicts.
//   2. the generated rule corpus, prefiltered by keyword, bounded quantifiers.
//      The captured value is chosen as the *highest-entropy group* rather than a
//      fixed group number: gitleaks' own rules disagree (in `atlassian-api-token`
//      group 1 is the vendor name, group 2 is the secret).
//   3. the allowlist, which is what lets the generic detector run at a low
//      threshold: benign high-entropy shapes are named explicitly and left alone,
//      so the aggression goes where the secrets are.
//   4. a context score for the generic family only -- the family whose precision
//      depends on surrounding words.
//
// Placeholders are deterministic: fnv1a(salt + value) twice, 16 hex. Same secret
// -> same placeholder in the prompt row, the tool-result row, an edit, and a
// compaction summary, so an edit to a line that holds a real key still matches.
// A placeholder minted in another session's salt means nothing here.

import {
  GLOBAL_ALLOW_REGEXES,
  GLOBAL_STOPWORDS,
  PASSWORD_VALUE_RULE_ID,
  RULES,
  type Rule,
} from "./rules.ts";
import { isAllowed } from "./allowlist.ts";
import { isSecret, type ClassifierModel } from "./classifier.ts";
import { structuralHits, type Hit } from "./structural.ts";

export type Tier = "strict" | "balanced" | "precision";

export type ScrubOptions = {
  /** Per-session salt. A placeholder from another session is meaningless. */
  readonly salt: string;
  readonly tier: Tier;
  /** Entropy floor for the generic family, after a user override. */
  readonly minEntropy: number;
  /** User-supplied rules merged ahead of the corpus. */
  readonly extraRules?: readonly Rule[];
  /** User allowlist patterns, matched against the whole candidate value. */
  readonly allowExtra?: readonly RegExp[];
  /** User force-redact patterns: a match here bypasses every gate. */
  readonly deny?: readonly RegExp[];
  /**
   * Rule ids switched off. The "remove" half of the override surface: a person
   * who finds a rule noisy must be able to turn it off without forking the
   * corpus. `local-classifier` disables the optional L2 stage.
   */
  readonly disabledRules?: readonly string[];
  /** Wall-clock ceiling for one row; exceeding it fails closed. */
  readonly budgetMs?: number;
  /**
   * L2: an optional local model, probed from disk by the caller (register.ts).
   *
   * Absent or null means the pipeline is L1 only, which is the default and the
   * normal case. A model here is a weights file evaluated in-process; it never
   * implies a network, a subprocess or a remote model.
   */
  readonly classifier?: ClassifierModel | null;
};

export type ScrubHit = {
  readonly label: string;
  readonly placeholder: string;
  readonly value: string;
  readonly by: string;
};

export type ScrubResult = {
  readonly text: string;
  readonly hits: readonly ScrubHit[];
};

/** Tier thresholds for the generic family's context score, in [0,1]. */
const TIER_THRESHOLD: Record<Tier, number> = {
  // A redactor's false positive costs a degraded-looking hash, not a lost task,
  // so the operating point sits far below a scanner's.
  strict: 0.15,
  balanced: 0.35,
  precision: 0.6,
};

/** Rows above this are scanned with the structural and generic families only. */
const FULL_SCAN_LIMIT = 60_000;

/**
 * Hard ceiling on placeholders minted from one row.
 *
 * Exceeding it fails closed. Accepting the first 512 candidates and returning
 * the text as though it were scrubbed would leave the rest of the row raw while
 * reporting success -- a partial scrub that reads as a complete one, which is
 * the worst outcome available to a redactor. A withheld row is visible and
 * recoverable; a half-scrubbed row is neither.
 */
const MAX_HITS = 512;

/**
 * A run long enough to hold a credential, for the L2 sweep. The class is the
 * union of what base64, base64url, hex, dashed and dotted tokens use, so one
 * pass reaches every shape a model could judge without a vendor anchor.
 */
const TOKEN_RE = /[A-Za-z0-9_+/=.-]{12,4096}/g;

const GLOBAL_ALLOW = GLOBAL_ALLOW_REGEXES.map((s) => {
  try {
    return new RegExp(s, "i");
  } catch {
    return null;
  }
}).filter((r): r is RegExp => r !== null);

/**
 * A field-name assignment carrying a password a person may have chosen.
 *
 * The field name is the anchor: `password`, `passwd`, `pwd`, `pass` or `secret`,
 * optionally behind `DB_`/`db.`-style qualifiers, with the separator abutting the
 * name (`KEY=value`, `key: value`). The value is 6-20 characters and is not
 * judged by entropy: `S3cr3tP4ssw0rd` measures 3.38 bits and is exactly the
 * ordinary password the generic rule misses.
 *
 * Whitespace before the separator is deliberately not matched: `password =
 * "hunter2"` is a prose-shaped mention, not a `KEY=value` assignment. The
 * allowlist gates every candidate, so `changeme`, templates and `required`
 * survive byte-identical.
 */
const PASSWORD_VALUE_RE =
  /(?:^|[^A-Za-z0-9])(?:[A-Za-z0-9]{1,30}[_.-]){0,6}(?:password|passwd|pwd|pass|secret)(?::=|=>|:|=)[ \t]{0,4}(["']?)([^\s"'`<>;,]{6,20})\1(?=$|[\s"'`<>,;)\]}])/gdi;

/** Entropy-free detectors whose rule id L3 can switch off; not in the corpus. */
const ENGINE_RULE_IDS = new Set<string>([PASSWORD_VALUE_RULE_ID]);

/**
 * True when a candidate is a filesystem path, not a password.
 *
 * `pwd` and `PWD` belong to the field-name keyword set, and a shell environment
 * dump carries a working directory beside every real secret. A path has nothing
 * to revoke and is needed verbatim to run the task. A value containing a colon
 * is not a bare path (it carries a scheme, drive or port), so the slash clause
 * stays narrow.
 */
function isPathValue(value: string): boolean {
  if (value.startsWith("/") || value.startsWith("~") || value.startsWith("./") || value.startsWith("../")) {
    return true;
  }
  return value.includes("/") && !value.includes(":");
}

// --- primitives -------------------------------------------------------------

/** Shannon entropy in bits per character, over the value's own distribution. */
export function shannon(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const count of counts.values()) {
    const p = count / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function fnv1a(input: string, basis: number): string {
  let h = basis >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** 64 bits from two independent FNV-1a passes: collisions are not a concern. */
function valueHash(salt: string, value: string): string {
  return fnv1a(salt + value, 0x811c9dc5) + fnv1a(value + salt, 0x7a3d1f29);
}

const PLACEHOLDER_RE = /^\[REDACTED:[A-Z0-9_]+#[0-9a-f]{16}\]$/;

/** True for a value that is already one of our placeholders (idempotence). */
export function isPlaceholder(s: string): boolean {
  return PLACEHOLDER_RE.test(s.trim());
}

export function placeholderFor(label: string, salt: string, value: string): string {
  return `[REDACTED:${label}#${valueHash(salt, value)}]`;
}

const PROSE_PLACEHOLDER_RE = /\[REDACTED:[A-Z0-9_]+#[0-9a-f]{16}\]/g;

// --- context scoring -------------------------------------------------------

const BOOST = ["prod", "production", "live", "deploy", "secret", "token", "credential", "password", "private", "auth", "bearer", "apikey", "api_key"];
const DAMP = ["example", "sample", "dummy", "fake", "fixture", "mock", "test", "docs", "readme", "placeholder", "lorem"];

/**
 * Confidence that a generic-family candidate is a real credential, in [0,1].
 *
 * Deliberately conservative in what it *suppresses*: a damping word lowers the
 * score but the explicit allowlist is what actually lets a value through, so a
 * test fixture still gets redacted unless it is one of the named benign shapes.
 */
export function contextScore(text: string, start: number, end: number, value: string): number {
  let score = 0.45;
  const window = text.slice(Math.max(0, start - 80), Math.min(text.length, end + 40)).toLowerCase();
  for (const word of BOOST) if (window.includes(word)) score += 0.12;
  for (const word of DAMP) if (window.includes(word)) score -= 0.1;
  // A value that mixes character classes is much more likely to be generated.
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(value)).length;
  score += (classes - 1) * 0.08;
  if (value.length >= 32) score += 0.1;
  if (value.length >= 64) score += 0.05;
  return Math.max(0, Math.min(1, score));
}

// --- rule matching ---------------------------------------------------------

type Compiled = { rule: Rule; re: RegExp | null };

/**
 * Compile once per load. A pattern that fails to compile is dropped rather than
 * thrown: one bad user rule must not disable the whole redactor.
 */
function compile(rules: readonly Rule[]): Compiled[] {
  return rules.map((rule) => {
    try {
      // `d` gives match indices, so only the chosen group's span is redacted.
      return { rule, re: new RegExp(rule.regex, `${rule.flags}g${rule.flags.includes("d") ? "" : "d"}`) };
    } catch {
      return { rule, re: null };
    }
  });
}

/**
 * The corpus scan. Engine-owned detectors are excluded: they run in their own
 * passes, where a tier gate and an exact value span replace the generic
 * family's entropy and context-score gates.
 */
const COMPILED = compile(RULES.filter((rule) => !ENGINE_RULE_IDS.has(rule.id)));

/** keyword -> compiled rules, so a row only runs rules whose anchor it mentions. */
const BY_KEYWORD = new Map<string, Compiled[]>();
for (const c of COMPILED) {
  for (const k of c.rule.keywords) {
    const list = BY_KEYWORD.get(k);
    if (list) list.push(c);
    else BY_KEYWORD.set(k, [c]);
  }
}

const KEYWORDS = [...BY_KEYWORD.keys()];

function rulesForRow(size: number, extra: readonly Rule[]): Compiled[] {
  if (extra.length) {
    return [...compile(extra), ...(size <= FULL_SCAN_LIMIT ? COMPILED : COMPILED.filter((c) => c.rule.kind !== "vendor-keyword"))];
  }
  return size <= FULL_SCAN_LIMIT ? COMPILED : COMPILED.filter((c) => c.rule.kind !== "vendor-keyword");
}

/** Which detectors a row of this size will actually run (`/redact why`). */
export function detectorsFor(size: number): string {
  const full = size <= FULL_SCAN_LIMIT;
  return full
    ? "structural + 220-rule corpus + generic"
    : `structural + generic (row is ${size} chars, over the ${FULL_SCAN_LIMIT} full-scan limit)`;
}

/**
 * Pick the span to redact from one match.
 *
 * gitleaks rules disagree about which capture group holds the value, so rather
 * than trusting a group number we take the highest-entropy non-empty group and
 * break ties on length. `secretGroup` wins when upstream states it explicitly.
 */
function chosenSpan(m: RegExpExecArray, rule: Rule): { start: number; end: number } | null {
  const indices = m.indices;
  if (!indices) return null;
  const declared = rule.secretGroup;
  if (declared !== null && declared > 0 && indices[declared]) {
    const span = indices[declared];
    return span ? { start: span[0], end: span[1] } : null;
  }
  let best: { start: number; end: number } | null = null;
  let bestScore = -1;
  let bestLength = -1;
  for (let i = 1; i < indices.length; i++) {
    const span = indices[i];
    if (!span || span[1] <= span[0]) continue;
    const value = m[0].slice(span[0] - (m.index ?? 0), span[1] - (m.index ?? 0));
    const score = shannon(value);
    const length = span[1] - span[0];
    if (score > bestScore || (score === bestScore && length > bestLength)) {
      best = { start: span[0], end: span[1] };
      bestScore = score;
      bestLength = length;
    }
  }
  if (best) return best;
  const whole = indices[0];
  return whole ? { start: whole[0], end: whole[1] } : null;
}

type Candidate = Hit & { by: string };

/**
 * Scan one string. Returns the rewritten text and every hit, but mints no state:
 * the caller decides what to persist.
 *
 * Fails closed by throwing, never by returning partially-scrubbed text: a row
 * that overruns the budget must not reach the model at all.
 */
export function scrub(text: string, opts: ScrubOptions): ScrubResult {
  if (!text) return { text, hits: [] };
  const started = Date.now();
  const budget = opts.budgetMs ?? 1500;
  const threshold = TIER_THRESHOLD[opts.tier];
  const candidates: Candidate[] = [];
  const disabled = opts.disabledRules && opts.disabledRules.length > 0 ? new Set(opts.disabledRules) : null;

  // 1. structural: self-proving, so they bypass every gate -- except the L3
  // remove surface. The URL and Basic-auth detectors carry rule ids, so a
  // disabled id stops them the same way it stops a rule in step 2 ("a disabled
  // rule is not consulted, whichever family it belongs to"); the checksum
  // families have no id a command can name, so they stay unconditional.
  for (const hit of structuralHits(text)) {
    if (opts.disabledRules?.includes(hit.by)) continue;
    candidates.push(hit);
  }

  // 1b. force-redact patterns are detectors in their own right. A person who
  // says "always redact this" must get that even when no rule matches the value
  // -- otherwise the override is silently unreachable for exactly the values
  // they cared about. `/redact deny <re>` documents value semantics, so the
  // pattern is tested against each token as well as against the whole text
  // (the latter lets a pattern span whitespace when someone wants that).
  const DENY_TOKEN = /[^\s"'`<>()[\]{},;]+/g;
  for (const pattern of opts.deny ?? []) {
    const push = (start: number, end: number, value: string) => {
      candidates.push({ label: "USER_DENY", start, end, value, by: "deny" });
    };
    pattern.lastIndex = 0;
    let scanner: RegExp;
    try {
      scanner = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    } catch {
      continue;
    }
    scanner.lastIndex = 0;
    for (;;) {
      const m = scanner.exec(text);
      if (!m) break;
      if (m[0].length === 0) {
        scanner.lastIndex += 1;
        continue;
      }
      push(m.index, m.index + m[0].length, m[0]);
    }
    DENY_TOKEN.lastIndex = 0;
    for (;;) {
      const token = DENY_TOKEN.exec(text);
      if (!token) break;
      scanner.lastIndex = 0;
      // Only what the pattern matched inside the token disappears, so the token
      // pass preserves the surrounding URL or sentence. The whole-text pass is
      // what lets a pattern span whitespace; this pass adds value-anchored
      // semantics (`^`/`$` bind to the token, not to the row).
      for (;;) {
        const m = scanner.exec(token[0]);
        if (!m) break;
        if (m[0].length === 0) {
          scanner.lastIndex += 1;
          continue;
        }
        push(token.index + m.index, token.index + m.index + m[0].length, m[0]);
      }
    }
  }

  // 1c. password values, keyed on the field name.
  //
  // The generic family cannot reach an ordinary password: its 3.5-bit floor is
  // what separates generated keys from words, and a person's password sits below
  // it. This pass trades that gate for the allowlist alone, and runs only at the
  // default tier: `strict` keeps its shipped precision baseline.
  if (opts.tier === "balanced" && !disabled?.has(PASSWORD_VALUE_RULE_ID)) {
    PASSWORD_VALUE_RE.lastIndex = 0;
    for (;;) {
      const m = PASSWORD_VALUE_RE.exec(text);
      if (!m) break;
      if (Date.now() - started > budget) throw new Error("prompt-redact: scan budget exceeded");
      const span = m.indices?.[2];
      if (!span) continue;
      const value = text.slice(span[0], span[1]);
      if (!value || isPlaceholder(value)) continue;
      if (isPathValue(value)) continue;
      if ((opts.deny ?? []).some((re) => re.test(value))) {
        candidates.push({ label: "PASSWORD_VALUE", start: span[0], end: span[1], value, by: PASSWORD_VALUE_RULE_ID });
        continue;
      }
      if (isAllowed(value, opts.allowExtra ?? [])) continue;
      if (GLOBAL_ALLOW.some((re) => re.test(value))) continue;
      if (GLOBAL_STOPWORDS.some((w) => value.toLowerCase() === w)) continue;
      candidates.push({ label: "PASSWORD_VALUE", start: span[0], end: span[1], value, by: PASSWORD_VALUE_RULE_ID });
    }
  }

  // 2. rules, keyword-prefiltered.
  const lower = text.toLowerCase();
  const wanted = new Set<Compiled>();
  for (const keyword of KEYWORDS) {
    if (lower.includes(keyword)) {
      for (const c of BY_KEYWORD.get(keyword) ?? []) wanted.add(c);
    }
  }
  for (const c of rulesForRow(text.length, opts.extraRules ?? [])) {
    if (c.rule === undefined || c.re === null) continue;
    // A disabled rule is not consulted, whichever family it belongs to.
    if (disabled?.has(c.rule.id)) continue;
    if (c.rule.keywords.length > 0 && !wanted.has(c)) continue;
    // A rule with no keywords runs unconditionally; those are cheap and rare.
    if (Date.now() - started > budget) throw new Error("prompt-redact: scan budget exceeded");
    c.re.lastIndex = 0;
    for (;;) {
      const m = c.re.exec(text);
      if (!m) break;
      if (m[0].length === 0) {
        c.re.lastIndex += 1;
        continue;
      }
      const span = chosenSpan(m, c.rule);
      if (!span) continue;
      const value = text.slice(span.start, span.end);
      if (!value || isPlaceholder(value)) continue;
      // A force-redact rule is the person's explicit override and outranks every
      // other gate: allowlist, stopwords, entropy and context score.
      if ((opts.deny ?? []).some((re) => re.test(value))) {
        candidates.push({ label: c.rule.label, start: span.start, end: span.end, value, by: c.rule.id });
        continue;
      }
      if (isAllowed(value, opts.allowExtra ?? [])) continue;
      if (GLOBAL_ALLOW.some((re) => re.test(value))) continue;
      if (GLOBAL_STOPWORDS.some((w) => value.toLowerCase() === w)) continue;
      // `minEntropy` is the floor for the generic family, and it has to be able
      // to *raise* the rule's own floor as well as lower it. A rule that carries
      // `entropy: 3.5` upstream does not stop being 3.5 because a person asked
      // for 2.0; and asking for 4.0 must actually tighten it, or the setting is
      // decorative. Specific rules keep their upstream value only.
      const floor =
        c.rule.kind === "generic"
          ? Math.max(c.rule.entropy ?? 0, opts.minEntropy)
          : (c.rule.entropy ?? 0);
      if (floor > 0 && shannon(value) < floor) continue;
      if (c.rule.kind === "generic" && contextScore(text, span.start, span.end, value) < threshold) continue;
      candidates.push({ label: c.rule.label, start: span.start, end: span.end, value, by: c.rule.id });
    }
  }

  // 2b. L2: the optional local classifier.
  //
  // This is the only detector that runs without an anchor. A rule corpus cannot
  // reach a secret that carries no vendor prefix and no keyword beside it -- the
  // prose/multilingual tier -- so when a weights file was probed and loaded the
  // row is swept for high-entropy runs and each one is scored. Absent the model
  // this block is skipped entirely and nothing about L1 changes.
  if (opts.classifier && !disabled?.has("local-classifier")) {
    const model = opts.classifier;
    TOKEN_RE.lastIndex = 0;
    for (;;) {
      const token = TOKEN_RE.exec(text);
      if (!token) break;
      if (Date.now() - started > budget) throw new Error("prompt-redact: scan budget exceeded");
      const value = token[0];
      if (isPlaceholder(value)) continue;
      if (isAllowed(value, opts.allowExtra ?? [])) continue;
      if (GLOBAL_ALLOW.some((re) => re.test(value))) continue;
      if (shannon(value) < opts.minEntropy) continue;
      if (!isSecret(model, value)) continue;
      candidates.push({
        label: "LOCAL_CLASSIFIER_SECRET",
        start: token.index,
        end: token.index + value.length,
        value,
        by: "classifier",
      });
    }
  }

  // 3. resolve overlaps: structural first, then widest/highest-entropy.
  // Rank decides which of two overlapping candidates keeps its span. Self-proving
  // evidence outranks a pattern, a pattern outranks a statistical guess: a vendor
  // rule names the credential, so its label is worth more than the classifier's.
  const rank = (by: string): number => {
    if (by === "deny" || by === "pem" || by === "jwt" || by === "luhn" || by === "iban" || by === "fica" || by === "base32") return 2;
    if (by === "classifier") return 0;
    return 1;
  };
  const ordered = candidates
    .map((c, i) => ({ c, i }))
    .sort((a, b) => {
      const sa = rank(a.c.by);
      const sb = rank(b.c.by);
      if (sa !== sb) return sb - sa;
      if (a.c.end - a.c.start !== b.c.end - b.c.start) return b.c.end - b.c.start - (a.c.end - a.c.start);
      return shannon(b.c.value) - shannon(a.c.value);
    });

  const accepted: Candidate[] = [];
  let overflowed = false;
  for (const { c } of ordered) {
    if (accepted.some((a) => c.start < a.end && a.start < c.end)) continue;
    if (accepted.length >= MAX_HITS) {
      // Count only candidates that would genuinely have been accepted, so a row
      // full of overlapping matches is not mistaken for an over-cap row.
      overflowed = true;
      break;
    }
    accepted.push(c);
  }
  if (overflowed) {
    throw new Error(`prompt-redact: more than ${MAX_HITS} candidate secrets in one row`);
  }

  // 4. apply right-to-left so earlier spans keep their offsets.
  accepted.sort((a, b) => a.start - b.start);
  const hits: ScrubHit[] = [];
  let out = text;
  for (let i = accepted.length - 1; i >= 0; i--) {
    const hit = accepted[i];
    if (!hit) continue;
    const placeholder = placeholderFor(hit.label, opts.salt, hit.value);
    out = out.slice(0, hit.start) + placeholder + out.slice(hit.end);
    hits.push({ label: hit.label, placeholder, value: hit.value, by: hit.by });
  }
  hits.reverse();
  if (Date.now() - started > budget) throw new Error("prompt-redact: scan budget exceeded");
  return { text: out, hits };
}

// --- block walking ---------------------------------------------------------

type Block = { type?: string; [field: string]: unknown };
type Message = { type?: string; content?: unknown; [field: string]: unknown };

const TEXT_TYPES = new Set(["text"]);

/**
 * Rewrite every rewritable part of a stored row.
 *
 * On `session.append` the engine pins `type`, `name`, `role` and `isMeta`, and
 * puts back thinking blocks, `tool_use` blocks and every `tool_result.tool_use_id`.
 * What a hook may change is exactly: text blocks, a `tool_result`'s `content`,
 * and `is_error`. This function touches nothing else.
 */
export function scrubMessage(message: Message, opts: ScrubOptions): { message: Message; hits: ScrubHit[] } {
  const hits: ScrubHit[] = [];
  const content = message.content;
  if (typeof content === "string") {
    const result = scrub(content, opts);
    hits.push(...result.hits);
    return { message: { ...message, content: result.text }, hits };
  }
  if (!Array.isArray(content)) return { message, hits };

  const next = content.map((raw) => {
    const block = raw as Block;
    if (!block || typeof block !== "object") return raw;
    if (TEXT_TYPES.has(String(block.type)) && typeof block.text === "string") {
      const result = scrub(block.text, opts);
      hits.push(...result.hits);
      return result.hits.length ? { ...block, text: result.text } : block;
    }
    if (block.type === "tool_result") {
      const inner = block.content;
      if (typeof inner === "string") {
        const result = scrub(inner, opts);
        hits.push(...result.hits);
        return result.hits.length ? { ...block, content: result.text } : block;
      }
      if (Array.isArray(inner)) {
        const blocks = inner.map((nested) => {
          const b = nested as Block;
          if (b && typeof b === "object" && typeof b.text === "string") {
            const result = scrub(b.text, opts);
            hits.push(...result.hits);
            return result.hits.length ? { ...b, text: result.text } : b;
          }
          return nested;
        });
        return hits.length ? { ...block, content: blocks } : block;
      }
    }
    return block;
  });
  return { message: { ...message, content: next }, hits };
}

// --- rehydration -----------------------------------------------------------

/**
 * The domain rehydration operates on: JSON-shaped tool input. Declaring it here
 * rather than threading `unknown` through keeps the walk typed at every level.
 */
export type Rehydratable =
  | string
  | number
  | boolean
  | null
  | readonly Rehydratable[]
  | { readonly [key: string]: Rehydratable };

/**
 * Parse an engine-supplied tool input into the rehydration domain.
 *
 * `undefined` means "not rehydratable shape" and the caller keeps the original
 * value; `null` is the genuine JSON null. Anything a tool can carry that is not
 * string/array/object (a timeout number, a boolean flag) round-trips untouched.
 */
export function asRehydratable(value: unknown): Rehydratable | undefined {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      return value;
    case "object":
      break;
    default:
      return undefined;
  }
  if (Array.isArray(value)) {
    const items: Rehydratable[] = [];
    for (const item of value) {
      const parsed = asRehydratable(item);
      items.push(parsed === undefined ? String(item) : parsed);
    }
    return items;
  }
  const record: Record<string, Rehydratable> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const parsed = asRehydratable(item);
    if (parsed !== undefined) record[key] = parsed;
  }
  return record;
}

function rehydrateNode(node: Rehydratable, vault: Readonly<Record<string, string>>): Rehydratable {
  if (typeof node === "string") {
    let out = node;
    for (const [placeholder, value] of Object.entries(vault)) {
      if (out.includes(placeholder)) out = out.split(placeholder).join(value);
    }
    return out;
  }
  if (Array.isArray(node)) return node.map((child) => rehydrateNode(child, vault));
  if (node !== null && typeof node === "object") {
    const out: Record<string, Rehydratable> = {};
    for (const [key, child] of Object.entries(node)) out[key] = rehydrateNode(child, vault);
    return out;
  }
  return node;
}

/**
 * Put real values back. Callers must only ever pass `Edit`, `Write` and
 * `NotebookEdit` arguments: rehydrating anywhere the model can reach the network
 * turns a placeholder into an exfiltration primitive.
 */
export function rehydrate(input: Rehydratable, vault: Readonly<Record<string, string>>): Rehydratable {
  if (Object.keys(vault).length === 0) return input;
  return rehydrateNode(input, vault);
}

/** Count placeholders inside a structured value (pre-rehydration), for `/redact`. */
export function placeholdersIn(node: Rehydratable): number {
  if (typeof node === "string") return placeholderCount(node);
  // Explicit loops rather than reduce: the accumulator type of `reduce` over a
  // union of readonly array and record resolves to the element type, not number.
  if (Array.isArray(node)) {
    let total = 0;
    for (const child of node as readonly Rehydratable[]) total += placeholdersIn(child);
    return total;
  }
  if (node !== null && typeof node === "object") {
    let total = 0;
    for (const child of Object.values(node) as Rehydratable[]) total += placeholdersIn(child);
    return total;
  }
  return 0;
}

/** Count placeholders still present in a string, for `/redact` reporting. */
export function placeholderCount(text: string): number {
  PROSE_PLACEHOLDER_RE.lastIndex = 0;
  return (text.match(PROSE_PLACEHOLDER_RE) ?? []).length;
}
