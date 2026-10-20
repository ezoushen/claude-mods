// The allowlist is the reason the generic detector can run at a low threshold.
//
// A redactor's false positive is cheap: Claude reads `[REDACTED:...]` where a
// meaningless hash used to be. But there is one false positive it cannot afford
// -- redacting a value the *task needs*. A git SHA, an object id, a lockfile
// integrity string, a resource ARN: take those away and the model can no longer
// do the thing you asked. So the rule is:
//
//   be maximally aggressive on secrets, and name every benign high-entropy
//   shape you must leave alone.
//
// Without this list the generic rule has to be tuned so conservatively that it
// misses real credentials. With it, the threshold drops and recall rises.
//
// Each entry matches a *whole candidate value* (anchored), never a substring, so
// an allowlist hit can never carve a hole in the middle of a real secret.

export type AllowEntry = {
  /** Why this shape is benign; quoted in `RULES.md` and `/redact why`. */
  readonly why: string;
  readonly pattern: RegExp;
};

const A = (why: string, source: string, flags = ""): AllowEntry => ({
  why,
  pattern: new RegExp(`^(?:${source})$`, flags),
});

export const ALLOWLIST: readonly AllowEntry[] = [
  // --- content hashes: the classic high-entropy non-secret -------------------
  A("git commit SHA-1 (content address, not a credential)", "[0-9a-f]{40}", "i"),
  A("git blob/tree SHA-1 with prefix", "(?:blob|tree|commit)\\s[0-9a-f]{40}", "i"),
  A("SHA-256 digest (content address, not a credential)", "[0-9a-f]{64}", "i"),
  A("`sha256:` image digest", "sha256:[0-9a-f]{64}", "i"),
  A("MD5 / 32-hex checksum", "[0-9a-f]{32}", "i"),

  // --- identifiers: needed to reference objects in code ---------------------
  A("UUID / database id / k8s resource UID", "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", "i"),
  A("MongoDB ObjectId", "[0-9a-f]{24}", "i"),
  A("ULID -- a time-sortable identifier, not a credential", "[0-9A-HJKMNP-TV-Z]{26}", "i"),
  A("AWS ARN -- a resource identifier; nothing to revoke", "arn:aws[a-z-]*:[a-z0-9-]+:[a-z0-9-]*:[0-9]{0,12}:[-\\w./:*]+", "i"),
  A("AWS account id (12 digits)", "[0-9]{12}"),
  A("IPv4 address -- a host, not a credential", "(?:\\d{1,3}\\.){3}\\d{1,3}"),
  A("email address (PII is out of scope; names are not rule-detectable)", "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}"),
  A("semantic version", "v?\\d+\\.\\d+\\.\\d+(?:[-+][0-9A-Za-z.-]+)?"),
  A("ISO-8601 timestamp", "\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})?"),
  A("hex colour value from a stylesheet", "#[0-9a-f]{3,8}", "i"),
  A("localhost URL", "https?://(?:localhost|127\\.0\\.0\\.1)(?::\\d+)?(?:/\\S*)?", "i"),

  // --- integrity / provenance metadata --------------------------------------
  A("subresource integrity (SRI)", "sha(?:256|384|512)-[A-Za-z0-9+/]{27,}={0,2}"),
  A("npm / lockfile integrity -- must carry the sha<N>- prefix; a bare base64 run is a credential, not a digest", "sha(?:1|256|384|512)-[A-Za-z0-9+/]{27,}={0,2}"),
  A("base64 data URI (inline asset)", "data:[a-z-]+/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+", "i"),
  A("bcrypt hash -- already hashed, not a usable credential", "\\$2[abxy]\\$\\d{2}\\$[./A-Za-z0-9]{53}"),
  A("SSH *public* key (public half; nothing to revoke)", "(?:ssh-(?:rsa|ed25519|dss)|ecdsa-sha2-\\S+)\\s+AAAA[A-Za-z0-9+/]{20,}={0,3}(?:\\s+\\S+)?"),
  A("PUBLIC certificate block", "-----BEGIN CERTIFICATE-----[\\s\\S]*?-----END CERTIFICATE-----"),

  // --- the placeholder lexicon: documentation and fixtures -------------------
  // These are the words that mark a value as an example. They are the single
  // most valuable allowlist family, and the reason not to mask the value before
  // judging it: masking would delete the word "EXAMPLE", which is the evidence.
  A("documentation placeholder", "(?:changeme|change_me|change-me|replace[-_ ]?me|your[-_ ]?key|your[-_ ]?token|your[-_ ]?secret|placeholder|redacted|dummy|fake|sample|example|test[-_ ]?value)", "i"),
  A("schema keyword that fills a password field, not a password", "required", "i"),
  A("template variable", "\\$\\{[^}]{0,200}\\}|\\{\\{[^}]{0,200}\\}\\}|<[A-Za-z_][A-Za-z0-9_ .:-]{0,60}>|\\$\\w+|%[A-Z_]+%"),
  A("explicit redaction marker", "[xX]{3,}|\\*{3,}|\\.{3,}|<redacted>|\\[REDACTED[^\\]]*\\]"),

  // --- the vendor sample credentials that are *known* public ----------------
  A("AWS documented example key pair (public sample, never usable)", "AKIAIOSFODNN7EXAMPLE|wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", ""),
];

/** True when `value` is a benign shape that must reach the model unchanged. */
export function isAllowed(value: string, extra: readonly RegExp[] = []): string | null {
  const v = value.trim();
  if (!v) return "empty";
  for (const entry of ALLOWLIST) {
    if (entry.pattern.test(v)) return entry.why;
  }
  for (const re of extra) {
    if (re.test(v)) return "user allowlist";
  }
  return null;
}
