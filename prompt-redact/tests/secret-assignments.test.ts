import { describe, expect, test } from "claude-code/testing";

import { scrub, type ScrubOptions } from "../hooks/scrub.ts";

// The incident: a shell-environment dump read through `Read` reached the model
// with two secrets raw. Rows keep Read's `NN\t` line prefix, because the prefix
// sits where a name boundary does and the detector must not need a clean line.
// Every value below is invented.

const balanced: ScrubOptions = {
  salt: "secret-assignments-salt",
  tier: "balanced",
  minEntropy: 3.2,
  budgetMs: 5000,
};

/** 9 characters, all distinct: 3.17 bits, under the generic rule's 3.5 floor and its 10-char minimum. */
const SHORT_KEY = "mK4xP9qR2";
/** 32 lowercase hex characters: the MD5 / checksum shape the allowlist excuses. */
/** A synthetic GitHub PAT: real prefix, invented body. */
const GHP_CANARY = "ghp_" + "Zz9QwErTyUiOpAsDfGhJkLzXcVbNm12AbCdEf";
const HEX32 = "3f9a1c07d2b84e65a0c1f7e93b2d58a4";
/** 32 hex characters at 3.0 bits: below the generic rule's entropy floor. */
const LOW_ENTROPY_HEX32 = "a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4";
/** A well-formed placeholder, assembled so this file never carries one as a literal. */
const PLACEHOLDER = "[REDACTED:" + "GENERIC_API_KEY#0123456789abcdef]";

describe("secret-named assignments", () => {
  test("a short value assigned to a *_KEY name is redacted though no rule's length or entropy floor admits it", () => {
    const out = scrub(`93\tBASE_URL=http://127.0.0.1:8080\n94\tMLX_API_KEY=${SHORT_KEY}\n95\tNO_COLOR=1\n`, balanced);
    expect(out.text).not.toContain(SHORT_KEY);
    expect(out.text).toMatch(/^93\tBASE_URL=http:\/\/127\.0\.0\.1:8080\n94\tMLX_API_KEY=\[REDACTED:SECRET_ASSIGNMENT#[0-9a-f]{16}\]\n95\tNO_COLOR=1\n$/);
    expect(out.hits.map((h) => h.value)).toEqual([SHORT_KEY]);
  });

  test("a checksum-shaped value assigned to a *_TOKEN name is a credential, not a checksum", () => {
    // The incident shape, and a 3.0-bit hex run that only the name can condemn
    // (the generic rule's entropy floor is 3.5).
    for (const hex of [HEX32, LOW_ENTROPY_HEX32]) {
      const out = scrub(`36\tCLAUDE_CODE_NO_FLICKER=1\n37\tCLAUDE_CODE_MESSAGING_TOKEN=${hex}\n38\tCLAUDE_CODE_NO_FLICKER=1\n`, balanced);
      expect(out.text).not.toContain(hex);
      expect(out.hits.map((h) => h.value)).toEqual([hex]);
      expect(out.text).toMatch(/^36\tCLAUDE_CODE_NO_FLICKER=1\n37\tCLAUDE_CODE_MESSAGING_TOKEN=\[REDACTED:[A-Z_]+#[0-9a-f]{16}\]\n38\tCLAUDE_CODE_NO_FLICKER=1\n$/);
    }
  });

  test("a name that only contains a secret word, or ends in another word, is left alone", () => {
    // The incident dump held KEYBOARD_HACK and SSH_AUTH_SOCK beside the secrets;
    // neither is one, but KEYBOARD_HACK is under the value floor and SSH_AUTH_SOCK is a
    // path, so KEYBOARD_LAYOUT and TOKEN_COUNT carry the name claim. MAX_TOKENS is a limit.
    const rows = [
      "12\tKEYBOARD_HACK=ab\n",
      "13\tKEYBOARD_LAYOUT=colemak-dh\n",
      "14\tSSH_AUTH_SOCK=/tmp/x.sock\n",
      "15\tTOKEN_COUNT=colemak-dh\n",
      "16\tMAX_TOKENS=4096000\n",
      "17\tMONKEY_NAME=colemak-dh\n",
    ].join("");
    expect(scrub(rows, balanced)).toEqual({ text: rows, hits: [] });
  });

  test("the value floor is six characters: five stay, six are redacted", () => {
    const five = "55\tPAGE_KEY=qW3rT\n";
    expect(scrub(five, balanced)).toEqual({ text: five, hits: [] });
    const six = scrub("56\tPAGE_KEY=qW3rTy\n", balanced);
    expect(six.hits.map((h) => h.value)).toEqual(["qW3rTy"]);
  });

  test("a path, a template and the placeholder lexicon under a secret name need no redaction", () => {
    const rows = [
      "70\tGOOGLE_APPLICATION_CREDENTIALS=/home/ezou/.config/gcloud/key.json\n",
      "71\tAPI_KEY=${API_KEY}\n",
      "72\tAPI_TOKEN=<your-token>\n",
      "73\tSERVICE_KEY=changeme\n",
      "74\tSERVICE_KEY=" + PLACEHOLDER + "\n",
    ].join("");
    expect(scrub(rows, balanced)).toEqual({ text: rows, hits: [] });
  });

  test("a checksum that is not the value of a secret-named assignment is left alone", () => {
    const rows = [
      `80\tchecksum=${HEX32}\n`,
      `81\tGIT_COMMIT=${HEX32}${HEX32.slice(0, 8)}\n`,
      `82\t${HEX32}  node-v22.tar.gz\n`,
    ].join("");
    expect(scrub(rows, balanced)).toEqual({ text: rows, hits: [] });
  });

  test("it runs at the default tier only, and its id switches it off", () => {
    const row = `94\tMLX_API_KEY=${SHORT_KEY}\n`;
    expect(scrub(row, { ...balanced, tier: "strict" })).toEqual({ text: row, hits: [] });
    expect(scrub(row, { ...balanced, tier: "precision" })).toEqual({ text: row, hits: [] });
    expect(scrub(row, { ...balanced, disabledRules: ["secret-assignment"] })).toEqual({ text: row, hits: [] });
  });

  test("scrubbing its own output changes nothing", () => {
    const once = scrub(`94\tMLX_API_KEY=${SHORT_KEY}\n37\tFOO_TOKEN=${HEX32}\n`, balanced);
    expect(once.hits.length).toBe(2);
    expect(scrub(once.text, balanced)).toEqual({ text: once.text, hits: [] });
  });

  test("a checksum-shaped value under a secret-named JSON or YAML key is a credential too", () => {
    const json = scrub(`{"name": "svc", "api_key": "${HEX32}", "region": "us-east-1"}`, balanced);
    expect(json.text).not.toContain(HEX32);
    expect(json.hits.map((h) => h.value)).toEqual([HEX32]);
    const yaml = scrub(`service:\n  auth_token: ${HEX32}\n`, balanced);
    expect(yaml.hits.map((h) => h.value)).toEqual([HEX32]);
    // The checksum exemption holds for names that merely contain a secret word.
    const sha = `{"author_sha": "${HEX32}${HEX32.slice(0, 8)}", "keyboard": "${HEX32}"}`;
    expect(scrub(sha, balanced)).toEqual({ text: sha, hits: [] });
  });

  test("a camelCase name is read by its last word", () => {
    const out = scrub(`export authToken=${SHORT_KEY}\nexport keyboardLayout=colemak-dh\n`, balanced);
    expect(out.hits.map((h) => h.value)).toEqual([SHORT_KEY]);
    expect(out.text).toMatch(/^export authToken=\[REDACTED:SECRET_ASSIGNMENT#[0-9a-f]{16}\]\nexport keyboardLayout=colemak-dh\n$/);
  });

  test("a base64 value containing a slash is a credential, not a path", () => {
    const out = scrub("94\tMLX_API_KEY=mK4x/P9qR2\n95\tAWS_SESSION_TOKEN=mK4x+P9q/R2==\n", balanced);
    expect(out.hits.map((h) => h.value)).toEqual(["mK4x/P9qR2", "mK4x+P9q/R2=="]);
  });

  test("an env dump inside a JSON string ends each value at its escaped newline", () => {
    // A transcript row or JSON tool result carries the dump with literal `\n` and `\t`.
    const row = `{"output":"94\\tMLX_API_KEY=${SHORT_KEY}\\n95\\tNO_COLOR=1\\n96\\tHOME=/Users/ezou\\n"}`;
    const out = scrub(row, balanced);
    expect(out.hits.map((h) => h.value)).toEqual([SHORT_KEY]);
    expect(out.text).toMatch(/MLX_API_KEY=\[REDACTED:SECRET_ASSIGNMENT#[0-9a-f]{16}\]\\n95\\tNO_COLOR=1\\n96\\tHOME=\/Users\/ezou\\n"\}$/);
  });

  test("a keyword argument or a call in source code is not an env assignment", () => {
    // Only a line-shaped `NAME=value` is an assignment; the same words inside an
    // expression name a variable, and redacting it would unread the code.
    const code = [
      "12\tclient = OpenAI(api_key=api_key)",
      "13\t    api_key=api_key,",
      "14\tClient(token=self.token, auth=auth_obj)",
      '15\tOpenAI(api_key=os.environ["OPENAI_API_KEY"])',
      "",
    ].join("\n");
    expect(scrub(code, balanced)).toEqual({ text: code, hits: [] });
  });

  test("a value a vendor rule already names keeps that rule's label", () => {
    const out = scrub(`37\tGITHUB_TOKEN=${GHP_CANARY}\n`, balanced);
    expect(out.text).not.toContain(GHP_CANARY);
    expect(out.hits.length).toBe(1);
    expect(out.hits[0]?.by).not.toBe("secret-assignment");
  });
});
