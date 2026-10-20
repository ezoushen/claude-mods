import { describe, expect, test } from "claude-code/testing";

import { placeholderFor, scrub, type ScrubOptions } from "../hooks/scrub.ts";

const SALT = "test-salt-0000";

const base: ScrubOptions = {
  salt: SALT,
  tier: "balanced",
  minEntropy: 3.2,
  budgetMs: 5000,
};

// Synthetic credentials invented for this suite; they match no real system.
const PG_PASSWORD = "Zz9QwErTyUiOpAsDfGhJkLzXcVbNm12"; // 32 chars, high entropy
const MY_PASSWORD = "Q8zR2vNw4Xp7LmKd9TgYc3Bf2Hn";
const BASIC_TOKEN = "YWRtaW46U3VwZXJTZWNyZXRQYXNzMTIz"; // base64 of admin:SuperSecretPass123

describe("url credentials", () => {
  // The redactor must take the password out of the userinfo and nothing else:
  // the configuration stays readable and runnable, only the secret disappears.
  test("the password becomes a placeholder while the host stays readable", () => {
    const text = `DATABASE_URL=postgres://app:${PG_PASSWORD}@db.internal:5432/prod`;
    const placeholder = placeholderFor("URL_PASSWORD", SALT, PG_PASSWORD);
    expect(scrub(text, base)).toEqual({
      text: `DATABASE_URL=postgres://app:${placeholder}@db.internal:5432/prod`,
      hits: [{ label: "URL_PASSWORD", placeholder, value: PG_PASSWORD, by: "url-userinfo" }],
    });
  });

  test("a mysql URL keeps its host and database", () => {
    const text = `mysql://root:${MY_PASSWORD}@10.0.0.5:3306/db`;
    const placeholder = placeholderFor("URL_PASSWORD", SALT, MY_PASSWORD);
    expect(scrub(text, base)).toEqual({
      text: `mysql://root:${placeholder}@10.0.0.5:3306/db`,
      hits: [{ label: "URL_PASSWORD", placeholder, value: MY_PASSWORD, by: "url-userinfo" }],
    });
  });

  // A value that is not a redactable credential -- a lexicon placeholder, a
  // masked marker, nothing typed at all -- must leave the whole line alone,
  // whatever shape sits in the userinfo slot.
  test("placeholder lexicon and an empty password are left alone", () => {
    const cases = ["${DATABASE_PASSWORD}", "changeme", "<password>", "xxx", ""];
    for (const password of cases) {
      const text = `DATABASE_URL=postgres://app:${password}@db.internal:5432/prod`;
      expect({ password, out: scrub(text, base) }).toEqual({ password, out: { text, hits: [] } });
    }
  });
});

describe("basic auth", () => {
  // Only the credential itself disappears: the header scheme word and its space
  // stay verbatim, so the line still reads as the header it is.
  test("the decoded credential is replaced, the header stays", () => {
    const text = `Authorization: Basic ${BASIC_TOKEN}`;
    const placeholder = placeholderFor("BASIC_AUTH", SALT, BASIC_TOKEN);
    expect(scrub(text, base)).toEqual({
      text: `Authorization: Basic ${placeholder}`,
      hits: [{ label: "BASIC_AUTH", placeholder, value: BASIC_TOKEN, by: "basic-auth" }],
    });
  });

  // The proof is the decoded shape, not the alphabet: a base64 value without a
  // `user:pass` split, and a value that is not base64 at all, are left alone.
  test("a value without a user:pass shape is left alone", () => {
    for (const token of ["dXNlcg==", "not-base64!"]) {
      const text = `Authorization: Basic ${token}`;
      expect({ token, out: scrub(text, base) }).toEqual({ token, out: { text, hits: [] } });
    }
  });
});

describe("new detectors are removable", () => {
  // The same mechanism `/redact rule off <id>` writes into reaches both new
  // detectors: an id switched off stops redacting its own shape while the
  // other detector keeps working.
  test("url-userinfo and basic-auth switch off independently", () => {
    const url = `DATABASE_URL=postgres://app:${PG_PASSWORD}@db.internal:5432/prod`;
    const auth = `Authorization: Basic ${BASIC_TOKEN}`;
    const placeholder = placeholderFor("URL_PASSWORD", SALT, PG_PASSWORD);

    // url-userinfo off: the URL passes through byte-identical...
    expect(scrub(url, { ...base, disabledRules: ["url-userinfo"] })).toEqual({ text: url, hits: [] });
    // ...and the other detector still fires when both shapes share a row.
    const both = scrub(`${url}\n${auth}`, { ...base, disabledRules: ["basic-auth"] });
    expect(both.hits.map((h) => h.by)).toEqual(["url-userinfo"]);
    expect(both.text).toEqual(`DATABASE_URL=postgres://app:${placeholder}@db.internal:5432/prod\n${auth}`);
  });
});
