// L2: an optional local classifier, probed from disk and run in-process.
//
// The rule corpus is precise because every rule carries an anchor: a vendor
// prefix or a keyword. That is also its ceiling. A password written as prose, or
// a proprietary token with no vendor prefix, has no anchor for a regex to grip,
// which is the tier where regex recall collapses (ProwlBench T3).
//
// So this module adds the second way to detect: a linear model over features of
// a candidate value. It is honest about what it is -- a weights file the person
// (or their trainer) supplies, evaluated with ordinary arithmetic. No weights
// ship with the mod, and none can: training needs data that leaves the machine,
// which the no-egress invariant forbids. When the file is absent, unreadable, or
// malformed, `parseClassifier` returns null and the pipeline silently stays at
// L1. That fallback is the normal case, not an error case.
//
// The invariant still holds. Inference is `bias + sum(w[f] * x[f])`, then a
// sigmoid. Nothing is transmitted, spawned or delegated: the value being judged
// never leaves this process, and this file cannot reach the network because it
// imports nothing and the posture gate forbids the call sites that could.

/** A local linear model: one weight per named feature, plus a bias. */
export type ClassifierModel = {
  readonly version: 1;
  /** Log-odds offset: a positive bias makes the model fire more readily. */
  readonly bias: number;
  /** Probability above which a candidate counts as a secret, in (0,1). */
  readonly threshold: number;
  /** Feature name -> weight. Names outside `FEATURE_NAMES` are ignored. */
  readonly features: Readonly<Record<string, number>>;
};

/**
 * The feature vocabulary. A weights file may name any subset; an unknown name is
 * ignored rather than rejected, so a newer trainer's extra features degrade
 * quietly instead of disabling the model.
 */
export const FEATURE_NAMES = [
  "length",
  "entropy",
  "upper",
  "lower",
  "digit",
  "symbol",
  "hexish",
  "base64ish",
  "camel",
  "separator",
  "prefixed",
  "wordlike",
] as const;

export type FeatureName = (typeof FEATURE_NAMES)[number];

/** Sigmoid input clamp: past this the answer is already 0 or 1 to the bit. */
const CLAMP = 60;

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Parse a weights file. Anything malformed yields null -- a broken model must
 * fall back to L1, never half-load and misjudge every candidate.
 *
 * Shape:
 *   { "version": 1, "bias": -3.2, "threshold": 0.5,
 *     "features": { "entropy": 1.4, "digit": 2.1, "symbol": 0.8 } }
 */
export function parseClassifier(raw: string): ClassifierModel | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1) return null;
  if (!finite(record.bias)) return null;
  if (!finite(record.threshold) || record.threshold <= 0 || record.threshold >= 1) return null;
  const rawFeatures = record.features;
  if (typeof rawFeatures !== "object" || rawFeatures === null) return null;
  const features: Record<string, number> = {};
  for (const [name, weight] of Object.entries(rawFeatures as Record<string, unknown>)) {
    if (!finite(weight)) return null;
    features[name] = weight;
  }
  if (Object.keys(features).length === 0) return null;
  return { version: 1, bias: record.bias, threshold: record.threshold, features };
}

/** Shannon entropy in bits per character. Kept local so this file imports nothing. */
function entropyOf(value: string): number {
  if (value.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * The feature vector of one candidate value, in [0,1] per feature so a weight's
 * size means the same thing across features.
 */
export function featuresOf(value: string): Record<FeatureName, number> {
  const length = value.length;
  let upper = 0;
  let lower = 0;
  let digit = 0;
  let symbol = 0;
  for (const ch of value) {
    if (ch >= "A" && ch <= "Z") upper += 1;
    else if (ch >= "a" && ch <= "z") lower += 1;
    else if (ch >= "0" && ch <= "9") digit += 1;
    else symbol += 1;
  }
  const ratio = (n: number) => (length === 0 ? 0 : n / length);
  return {
    // Length is capped at 64: past that the signal is already saturated.
    length: Math.min(length, 64) / 64,
    entropy: Math.min(entropyOf(value), 6) / 6,
    upper: ratio(upper),
    lower: ratio(lower),
    digit: ratio(digit),
    symbol: ratio(symbol),
    hexish: /^[0-9a-fA-F]+$/.test(value) && length >= 16 ? 1 : 0,
    base64ish: /^[A-Za-z0-9+/=_-]+$/.test(value) && length >= 16 ? 1 : 0,
    camel: upper > 0 && lower > 0 ? 1 : 0,
    separator: /[_-]/.test(value) ? 1 : 0,
    // A vendor prefix (`sk_`, `ghp_`, `xoxb-`, `AIza`) sits in the first few
    // characters; its presence is the strongest single predictor there is.
    prefixed: /^[A-Za-z]{2,6}[_-]/.test(value) ? 1 : 0,
    wordlike: /^[A-Za-z]+$/.test(value) ? 1 : 0,
  };
}

/**
 * Probability that a candidate value is a secret, in [0,1].
 *
 * Pure arithmetic over the weights file: no I/O, no clock, no randomness, so the
 * same value always scores the same and a placeholder stays stable.
 */
export function scoreValue(model: ClassifierModel, value: string): number {
  const features = featuresOf(value);
  let logit = model.bias;
  for (const [name, weight] of Object.entries(model.features)) {
    if (!(FEATURE_NAMES as readonly string[]).includes(name)) continue;
    logit += weight * features[name as FeatureName];
  }
  if (logit > CLAMP) return 1;
  if (logit < -CLAMP) return 0;
  return 1 / (1 + Math.exp(-logit));
}

/** Whether the model calls this value a secret, at its own threshold. */
export function isSecret(model: ClassifierModel, value: string): boolean {
  return scoreValue(model, value) >= model.threshold;
}
