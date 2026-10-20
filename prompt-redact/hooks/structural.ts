// Structural detectors: shapes that carry their own proof.
//
// A regex says "this looks like a key". A checksum says "this *is* one". Luhn,
// IBAN mod-97, a JWT whose header decodes to JSON with an `alg`, a PEM block with
// a matching END line -- these carry a self-check, so they run at effectively
// 100% precision and need no entropy gate, no keyword anchor and no context.
// The URL and Basic-auth detectors below prove themselves the same way: a URL
// userinfo *is* the credential slot the RFC defines, and a Basic-auth value
// decodes to `user:pass` or it is not a Basic-auth credential.
//
// They are also the one family that must NOT be a regex. `private-key` upstream
// ends in `{64,}`: capping it would redact a key's head and leave its tail in the
// transcript. So the PEM scanner walks the block linearly and redacts the whole
// span. Same for a JWT: decode the header rather than pattern-match base64url.
//
// Everything here is linear in the row length -- no backtracking, no `.*`.

import { isAllowed } from "./allowlist.ts";

export type Hit = {
  /** Placeholder label: [REDACTED:<label>#<hash>]. */
  readonly label: string;
  readonly start: number;
  readonly end: number;
  readonly value: string;
  /** Which detector produced it, for `/redact why`. */
  readonly by: string;
};

const PEM_BEGIN = /-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY-----/g;
const PEM_END_ANY = /-----END ([A-Z0-9 ]*)PRIVATE KEY-----/g;

/**
 * PEM private-key blocks: BEGIN..END, entirely redacted.
 *
 * Linear scan, no regex over the body. An unterminated block redacts from BEGIN
 * to end-of-row (fail closed: a truncated key still must not survive).
 */
export function pemPrivateKeys(text: string): Hit[] {
  const hits: Hit[] = [];
  let cursor = 0;
  for (;;) {
    PEM_BEGIN.lastIndex = cursor;
    const begin = PEM_BEGIN.exec(text);
    if (!begin) break;
    const label = begin[1] ?? "";
    const from = begin.index;
    PEM_END_ANY.lastIndex = begin.index + begin[0].length;
    let end = text.length; // beyond the last body character (unterminated case)
    let endMarkerAt = -1; // where the matching END marker text starts
    for (;;) {
      const candidate = PEM_END_ANY.exec(text);
      if (!candidate) break;
      if ((candidate[1] ?? "") === label) {
        endMarkerAt = candidate.index;
        end = endMarkerAt + candidate[0].length;
        break;
      }
    }
    // Fail closed on an unterminated block: the row itself may have been cut
    // mid-paste, so a truncated key still must not survive (BEGIN..EOL).
    const body = text.slice(begin.index + begin[0].length, endMarkerAt < 0 ? end : endMarkerAt);
    if (endMarkerAt >= 0 && !derHeaderMatchesPayload(body)) {
      cursor = end;
      continue;
    }
    hits.push({
      label: label.trim() ? `${label.trim().replace(/\s+/g, "_")}_PRIVATE_KEY` : "PRIVATE_KEY",
      start: from,
      end,
      value: text.slice(from, end),
      by: "pem",
    });
    cursor = end;
  }
  return hits;
}

/**
 * The DER length header against the payload it precedes (X.690 / RFC 7468).
 *
 * A PEM key body is base64 DER whose outer element is a SEQUENCE (0x30) and
 * whose length octets must be well formed and must not be contradicted by
 * the payload. Two directions, not one:
 *
 * - The payload running PAST the declared structure end (content declares
 *   fewer bytes than follow the header) is a contradiction: the block is
 *   not the DER it claims to be, so it is not treated as a key.
 * - The payload falling SHORT of the declared structure end is a truncated
 *   paste of a real key. The row may have been cut mid-paste, so this side
 *   fails closed and the block stays redacted (DECISIONS #3: truncation
 *   must not survive).
 *
 * The length octets themselves must be a canonical DER encoding: 0x80
 * (indefinite) and long forms over four octets are rejected, and a long
 * form under 0x80 bytes is non-minimal, so rejected.
 */
function derHeaderMatchesPayload(body: string): boolean {
  const bytes = pemBodyBytes(body);
  if (!bytes || bytes.length < 4) return false;
  if (bytes[0] !== 0x30) return false;
  const first = bytes[1];
  let headerOctets: number;
  let claimed: number;
  if (first < 0x80) {
    headerOctets = 2;
    claimed = first;
  } else if (first === 0x80 || first > 0x84 || bytes.length < 2 + (first - 0x80)) {
    return false; // indefinite, non-representable, or truncated header
  } else {
    headerOctets = 2 + (first - 0x80);
    claimed = 0;
    for (const octet of bytes.slice(2, headerOctets)) claimed = (claimed << 8) | octet;
    if (claimed < 0x80) return false; // non-minimal long form
  }
  const available = bytes.length - headerOctets;
  if (claimed === 0) return false; // a SEQUENCE with no content is no key
  return claimed >= available;
}

/**
 * Decode a PEM body to bytes, whitespace ignored. A `=`-padded tail is
 * trimmed -- only whole bytes count, and the leftover shift bits of the
 * final sextet are discarded. Returns null for a body carrying anything
 * outside the base64 alphabet.
 */
function pemBodyBytes(body: string): number[] | null {
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of body.replace(/\s+/g, "").replace(/=+$/, "")) {
    const value = B64_ALPHABET.indexOf(ch);
    if (value < 0) return null;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
      buffer &= (1 << bits) - 1;
    }
  }
  return out;
}

const B64URL = /[A-Za-z0-9_-]{8,}/g;

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Decode base64url without `atob`: the mod sandbox is not guaranteed to expose
 * web globals, and a silently missing decoder would mean silent JWT blindness --
 * a false negative in a redactor, the one kind it cannot afford.
 */
function decodeSegment(seg: string): string | null {
  const clean = seg.replace(/-/g, "+").replace(/_/g, "/");
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    const value = B64_ALPHABET.indexOf(ch);
    if (value < 0) return null;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((buffer >> bits) & 0xff);
    }
  }
  return out;
}

/**
 * JSON Web Tokens, proven structurally: the first segment must base64url-decode
 * to a JSON object with an `alg` field. That check is what separates a real JWT
 * from any three dotted base64url strings, and it costs no entropy tuning.
 */
export function jwts(text: string): Hit[] {
  const hits: Hit[] = [];
  const seen = new Set<number>();
  B64URL.lastIndex = 0;
  for (;;) {
    const first = B64URL.exec(text);
    if (!first) break;
    const start = first.index;
    if (seen.has(start)) continue;
    // The token runs to the end of its dotted run.
    const rest = /^[A-Za-z0-9_-]*\.([A-Za-z0-9_-]{8,})\.([A-Za-z0-9_-]*)/.exec(text.slice(start + first[0].length));
    if (!rest) continue;
    const payload = rest[1] ?? "";
    const headerText = decodeSegment(first[0]);
    if (!headerText) continue;
    let header: unknown;
    try {
      header = JSON.parse(headerText);
    } catch {
      continue;
    }
    if (typeof header !== "object" || header === null) continue;
    const alg = (header as Record<string, unknown>).alg;
    if (typeof alg !== "string" || !alg) continue;
    const end = start + first[0].length + 1 + payload.length + 1 + (rest[2] ?? "").length;
    seen.add(start);
    hits.push({ label: "JWT", start, end, value: text.slice(start, end), by: "jwt" });
  }
  return hits;
}

/** Luhn checksum: the mod-10 test every payment card number satisfies. */
export function luhnOk(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    const code = digits.charCodeAt(i) - 48;
    if (code < 0 || code > 9) return false;
    let d = code;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

const CARDISH = /(?<![0-9])(?:\d[ -]?){12,18}\d(?![0-9])/g;

/** Payment card numbers: 13-19 digits whose Luhn checksum verifies. */
export function cards(text: string): Hit[] {
  const hits: Hit[] = [];
  for (const m of text.matchAll(CARDISH)) {
    const raw = m[0];
    const digits = raw.replace(/[^0-9]/g, "");
    if (digits.length < 13 || digits.length > 19) continue;
    if (!luhnOk(digits)) continue;
    const start = m.index ?? 0;
    hits.push({ label: "CARD_NUMBER", start, end: start + raw.length, value: raw, by: "luhn" });
  }
  return hits;
}

/** IBAN mod-97, the checksum defined by ISO 13616. */
export function ibanOk(candidate: string): boolean {
  const iban = candidate.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{10,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    const chunk = code >= 48 && code <= 57 ? String(code - 48) : String(code - 55);
    for (const digit of chunk) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

const IBANISH = /(?<![A-Za-z0-9])[A-Z]{2}[0-9]{2}[A-Z0-9 ]{10,30}(?![A-Za-z0-9])/g;

/** IBANs whose mod-97 checksum verifies. */
export function ibans(text: string): Hit[] {
  const hits: Hit[] = [];
  for (const m of text.matchAll(IBANISH)) {
    if (!ibanOk(m[0])) continue;
    const start = m.index ?? 0;
    hits.push({ label: "IBAN", start, end: start + m[0].length, value: m[0], by: "iban" });
  }
  return hits;
}

/**
 * US Social Security numbers, under the SSA's own issuance rules (FICA):
 * area 001-899 except 666, group 01-99, serial 0001-9999. A number that also
 * carries a Verhoeff check digit is accepted as well, but the digit is not a
 * precondition.
 *
 * The issuance exclusions are the discriminator, and they are what keeps this
 * from matching every 9-digit run. Verhoeff is *not* part of the real SSN
 * scheme: it was proposed for it and never adopted, so a genuinely issued
 * number carries no check digit. Requiring one as a conjunct dropped roughly
 * nine of every ten real SSNs from the redactor, which is the wrong direction
 * for a redactor's guarantee. Hence the union: issuance rules OR a valid
 * check digit.
 */
export function ssns(text: string): Hit[] {
  const hits: Hit[] = [];
  for (const m of text.matchAll(/(?<![0-9])(\d{3})-(\d{2})-(\d{4})(?![0-9])/g)) {
    const area = Number(m[1]);
    const group = Number(m[2]);
    const serial = Number(m[3]);
    const issuanceOk = area !== 0 && area !== 666 && area <= 899 && group !== 0 && serial !== 0;
    if (!issuanceOk && !verhoeffOk(m[1] + m[2] + m[3])) continue;
    const start = m.index ?? 0;
    hits.push({ label: "SSN", start, end: start + m[0].length, value: m[0], by: "fica" });
  }
  return hits;
}

// --- Verhoeff check digit ----------------------------------------------------

/**
 * The Verhoeff check digit (Verhoeff 1969): the decimal checksum over the
 * dihedral group D5 that detects every single-digit error and every adjacent
 * transposition. Tables are the ones Verhoeff published; worked examples
 * (check digit 3 for 236, validating 2363; check digit 7 for 942; 12345 -> 1
 * with 123451 valid and its twins 122451/128451 invalid) settle the reading
 * of the tables in tests.
 */
const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];

const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

const VERHOEFF_INV = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];

/** D5 checksum of a digit string, digits taken right-to-left. */
function verhoeffSum(digits: string, positionShift: number): number {
  let c = 0;
  for (let i = digits.length - 1; i >= 0; i--) {
    c = VERHOEFF_D[c][VERHOEFF_P[((digits.length - 1 - i) + positionShift) % 8][Number(digits[i])]];
  }
  return c;
}

/**
 * The check digit to append to `body` so the concatenation validates.
 */
export function verhoeffCheckDigit(body: string): number {
  return VERHOEFF_INV[verhoeffSum(body, 1)];
}

/**
 * True when `digits` carries a correct Verhoeff check digit as its last
 * digit -- equivalently, `digits` is `prefix + verhoeffCheckDigit(prefix)`.
 */
export function verhoeffOk(digits: string): boolean {
  return verhoeffSum(digits, 0) === 0;
}


const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
// A base32 run is uppercase only: `0`, `1`, `8`, `9` are not in the alphabet, and
// lowercase means base64 or an identifier. RFC 4648 pads to a multiple of eight.
const BASE32_RUN = /(?<![A-Za-z0-9])[A-Z2-7]{16,64}={0,6}(?![A-Za-z0-9])/g;
// TOTP secrets have no vendor prefix, so the anchor has to be the surrounding
// words. This is the one structural family that needs context, and the reason it
// is checked last: without one of these words nearby, 16 uppercase characters are
// far more likely to be an identifier than an HMAC key.
const TOTP_CONTEXT =
  /(?:totp|otp|2fa|mfa|two[-_ ]?factor|authenticator|one[-_ ]?time|gauth|otpauth|backup[-_ ]?code|otp_secret|seed)/i;

/**
 * Bytes encoded by a base32 body, or null when the body is not base32.
 *
 * The byte count is what distinguishes a real HMAC key from a coincidence: RFC
 * 6238 secrets are 10, 20, 32 or 64 bytes in practice, so a 16-character run
 * (10 bytes) verifies and a 34-character word does not land on a key length.
 */
function base32Bytes(body: string): number | null {
  let buffer = 0;
  let bits = 0;
  let bytes = 0;
  for (const ch of body) {
    const value = BASE32_ALPHABET.indexOf(ch);
    if (value < 0) return null;
    buffer = (buffer << 5) | value;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      bytes += 1;
      buffer &= (1 << bits) - 1;
    }
  }
  return bytes;
}

/**
 * base32 TOTP secrets, proven structurally: a base32 body whose decoded length is
 * a plausible HMAC key size, next to a word that says it is a one-time-password
 * seed. Neither half alone is enough, which is what keeps the precision high.
 */
export function totpSecrets(text: string): Hit[] {
  const hits: Hit[] = [];
  for (const m of text.matchAll(BASE32_RUN)) {
    const raw = m[0];
    const body = raw.replace(/=+$/, "");
    const bytes = base32Bytes(body);
    if (bytes === null) continue;
    if (bytes < 10 || bytes > 64) continue;
    const start = m.index ?? 0;
    const before = text.slice(Math.max(0, start - 48), start);
    const after = text.slice(start + raw.length, Math.min(text.length, start + raw.length + 24));
    if (!TOTP_CONTEXT.test(before) && !TOTP_CONTEXT.test(after)) continue;
    hits.push({ label: "TOTP_SECRET", start, end: start + raw.length, value: raw, by: "base32" });
  }
  return hits;
}

// --- URL userinfo -----------------------------------------------------------

/**
 * The userinfo slot of an HTTP(S) family URL: `scheme://user:password@host`.
 *
 * The password, and only the password, is the credential. Scheme, user, host,
 * port and path are the structure a person pastes a config to keep working, so
 * the span ends exactly at the character before `@` and begins exactly at the
 * character after the user's `:`. An empty password (`scheme://user:@host`) is
 * no credential and never matches.
 *
 * Every quantifier is bounded and the scan is linear in the row length: the
 * class runs stop at `:`, `@`, `/` and whitespace, which is where the userinfo
 * definition ends anyway.
 */
const URL_USERINFO =
  /(?<![-_.A-Za-z0-9])([A-Za-z][A-Za-z0-9+.-]{1,20}:\/\/[A-Za-z0-9._~%!$&'()*+,;={}-]{1,128}:)([^:/@\s"'`\\]{1,2048})@/g;

/**
 * Passwords inside URL userinfo, with rule id `url-userinfo`.
 *
 * The placeholder lexicon is honoured inside the detector: the allowlist's
 * whole-value contract means a templated or documented password
 * (`${DATABASE_PASSWORD}`, `changeme`, `<password>`) is not redactable in the
 * first place, so no candidate is emitted for one.
 */
export function urlPasswords(text: string): Hit[] {
  const hits: Hit[] = [];
  for (const m of text.matchAll(URL_USERINFO)) {
    const password = m[2];
    if (!password) continue;
    if (isAllowed(password) !== null) continue;
    const start = (m.index ?? 0) + (m[1] ?? "").length;
    hits.push({
      label: "URL_PASSWORD",
      start,
      end: start + password.length,
      value: password,
      by: "url-userinfo",
    });
  }
  return hits;
}

// --- Basic-auth headers -----------------------------------------------------

/**
 * A base64 candidate: the standard alphabet with optional padding, delimited by
 * anything that is not itself a base64 or base64url character. The floor is six
 * alphabet characters -- the smallest *padded* form (`dXNlcg==`), so the
 * lower-boundary case reaches the decode proof instead of bouncing off a length
 * gate no test can see. Bounded, and the `.` in the boundary classes keeps a
 * JWT's dotted segments out of a single run.
 */
const B64_TOKEN = /(?<![A-Za-z0-9+/=.-])([A-Za-z0-9+/]{6,4096}={0,2})(?![A-Za-z0-9+/=.-])/g;

/**
 * The word `Basic` immediately before a candidate: the one header this
 * detector answers to, and the anchor that separates an HTTP Basic credential
 * from any base64 run. Variants beyond `Basic` are out of scope by design.
 */
const BASIC_SCHEME = /\bbasic[ \t]{1,8}$/i;

/**
 * Decode standard base64 (with optional padding) without `atob`, for the same
 * reason the JWT header decodes here instead of trusting a shape: a missing
 * decoder would mean silent blindness. Rejects anything whose bytes are not
 * printable ASCII -- that requirement is most of the precision, because it
 * refuses the prose words and identifiers a b64-charset regex happily matches.
 */
function decodeB64(seg: string): string | null {
  // A run whose length is 1 mod 4 cannot be base64, padded or not.
  if (seg.length % 4 === 1 && !seg.endsWith("=")) return null;
  const body = seg.replace(/=+$/, "");
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const ch of body) {
    const value = B64_ALPHABET.indexOf(ch);
    if (value < 0) return null;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      const byte = (buffer >> bits) & 0xff;
      if (byte < 0x20 || byte > 0x7e) return null;
      out += String.fromCharCode(byte);
    }
  }
  return out;
}

/**
 * `Authorization: Basic` credentials, with rule id `basic-auth`.
 *
 * The span is the base64 value only, so the header keeps its scheme word.
 * The proof is the same shape the URL detector leans on, decoded: the value
 * must decode (padding allowed) to printable ASCII carrying a `user:pass`
 * split with both halves non-empty. A base64 value that does not decode to
 * that shape is left untouched -- `Basic dXNlcg==` and `Basic not-base64!`
 * both survive verbatim.
 */
export function basicAuthCredentials(text: string): Hit[] {
  const hits: Hit[] = [];
  for (const m of text.matchAll(B64_TOKEN)) {
    const token = m[1];
    if (!token) continue;
    const start = m.index ?? 0;
    const before = text.slice(Math.max(0, start - 64), start);
    if (!BASIC_SCHEME.test(before)) continue;
    const decoded = decodeB64(token);
    if (decoded === null) continue;
    const colon = decoded.indexOf(":");
    if (colon < 1) continue;
    if (decoded.length - colon < 2) continue;
    hits.push({ label: "BASIC_AUTH", start, end: start + token.length, value: token, by: "basic-auth" });
  }
  return hits;
}

/**
 * Every structural detector, in the order their spans should win conflicts.
 */
export function structuralHits(text: string): Hit[] {
  return [
    ...pemPrivateKeys(text),
    ...jwts(text),
    ...ibans(text),
    ...cards(text),
    ...ssns(text),
    ...totpSecrets(text),
    ...urlPasswords(text),
    ...basicAuthCredentials(text),
  ];
}
