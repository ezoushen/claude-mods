import { describe, expect, test } from "claude-code/testing";

import { pemPrivateKeys, ssns, verhoeffCheckDigit, verhoeffOk } from "../hooks/structural.ts";

// All values below are synthetic. The check-digit fixtures are the published
// Verhoeff examples (Verhoeff 1969 tables: gen 236 -> 3, validate 2363; gen
// 942 -> 7; gen 12345 -> 1 with 123451 valid and 122451/128451 invalid, as
// reproduced from the canonical d/p/inv tables) plus numbers generated from
// those same tables for SSA-shaped values.

describe("ssn", () => {
  // The brief names two validators for SSA numbers: the FICA issuance rules and
  // a Verhoeff check digit. Review found that requiring the digit as a conjunct
  // cut recall from 100% to 83% on this suite -- real SSNs carry no published
  // check digit (Verhoeff was proposed for the scheme and never adopted), so
  // the digit is accepted as an additional path, never as a precondition.
  test("the Verhoeff check digit validates, and is an accepted path on its own", () => {
    // Published vectors: the worked examples of the Verhoeff tables.
    expect(verhoeffCheckDigit("236")).toEqual(3); // published: 236 -> 3
    expect(verhoeffOk("2363")).toBe(true); // published: the check digit in 2363 validates
    expect(verhoeffOk("2362")).toBe(false); // anything but the check digit fails
    expect(verhoeffCheckDigit("942")).toEqual(7); // published: the check digit for 942 is 7
    expect(verhoeffOk("9427")).toBe(true);
    // Vectors from the same tables: 12345 -> 1, and 123451 verifies while the
    // transcription/twins of it that keep the same check digit do not.
    expect(verhoeffCheckDigit("12345")).toEqual(1);
    expect(verhoeffOk("123451")).toBe(true);
    expect(verhoeffOk("122451")).toBe(false);
    expect(verhoeffOk("128451")).toBe(false);

    // SSA-shaped values with a valid check digit are redacted.
    expect(ssns("ssn 510-23-8453").length).toBe(1);
    expect(ssns("ssn 123-45-6784").length).toBe(1);
  });

  test("the issuance rules decide, so a real SSN without a check digit is redacted", () => {
    // 123-45-6789 is FICA-issued but its 9th digit is not a Verhoeff check
    // digit -- exactly the shape of a real SSN. Requiring the digit dropped
    // this and ~90% of real numbers; it must be redacted.
    expect(ssns("ssn 123-45-6789").length).toBe(1);
    expect(ssns("ssn 510-23-8454").length).toBe(1);
    // The FICA exclusions still refuse what they refused before.
    expect(ssns("ssn 000-45-6789").length).toBe(0);
    expect(ssns("ssn 666-45-6789").length).toBe(0);
    expect(ssns("ssn 123-00-6789").length).toBe(0);
  });
});

describe("pem", () => {
  // X.690: the body of a PEM key block is base64 DER whose outer element is a
  // SEQUENCE. The length octets must be canonical and must not be
  // contradicted by the payload. Two 94-byte twins differing only in the
  // length octet: the well-formed one declares 92 content bytes and carries
  // exactly 92; the malformed one declares 8 while 92 bytes follow its
  // header -- the payload overruns the declared structure, so the block is
  // not the DER it claims to be and is left alone. A payload FALLING SHORT
  // of the declared length is a truncated paste and stays redacted
  // fail-closed, which is what the shared suite's truncated fixtures cover.
  const WELL_FORMED = [
    "-----BEGIN RSA PRIVATE KEY-----",
    "MFwCAQACggEBAMvA27/Ka6Sf9JCoZRniWKM6NretBBvC9OetYNd0dvS7zEeYcrxm",
    "ZRiaZp+ufgOMR1yJyWIj7is6ylJwKXi2fr8NR6HDgGbVitM969urgPJEGDil+A==",
    "-----END RSA PRIVATE KEY-----",
  ].join("\n");
  const MALFORMED = [
    "-----BEGIN RSA PRIVATE KEY-----",
    "MAgCAQACggEBAMvA27/Ka6Sf9JCoZRniWKM6NretBBvC9OetYNd0dvS7zEeYcrxm",
    "ZRiaZp+ufgOMR1yJyWIj7is6ylJwKXi2fr8NR6HDgGbVitM969urgPJEGDil+A==",
    "-----END RSA PRIVATE KEY-----",
  ].join("\n");

  test("the DER header length is validated before redacting", () => {
    const hits = pemPrivateKeys(`before\n${WELL_FORMED}\nafter`);
    expect(hits.length).toBe(1);
    // Whole span, head and tail -- truncation would leak.
    expect(hits[0]?.value.startsWith("-----BEGIN RSA PRIVATE KEY-----")).toBe(true);
    expect(hits[0]?.value.endsWith("-----END RSA PRIVATE KEY-----")).toBe(true);
    // The malformed twin: same markers, same body, contradictory header.
    expect(pemPrivateKeys(MALFORMED).length).toBe(0);
    expect(pemPrivateKeys(`before\n${MALFORMED}\nafter`).length).toBe(0);
  });
});
