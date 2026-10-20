#!/usr/bin/env python3
"""Generate prompt-redact/hooks/rules.generated.ts from the vendored gitleaks corpus.

Provenance is the point of this script: every emitted rule carries the exact
gitleaks id and a source URL, and RULES.md is regenerated in the same pass so a
rule can never exist without a documented source. Nothing here runs at mod
runtime; the mod only ever sees the generated TypeScript.

gitleaks writes RE2 patterns. The conversions below are the only places where
RE2 and JavaScript RegExp disagree for this corpus:

  (?i)          inline flag     -> stripped, the rule's `flags` becomes "i"
  (?-i:...)     scoped un-flag  -> (?:...)  (the row is scanned case-insensitively
                                  anyway; this widens matching, never narrows it)
  (?P<n>...)    named group     -> (?<n>...)
  [[:alnum:]]   POSIX class     -> [A-Za-z0-9]
  \\z           absolute end    -> $  (without the m flag, so end-of-input)

Secret selection: gitleaks' own rules disagree on which capture group holds the
value -- in most rules it is group 1, but in `atlassian-api-token` group 1 is the
vendor keyword and group 2 is the secret, and `curl-auth-header` has eight
alternative credential groups of which exactly one is non-empty per match. So
this generator records every capture group and lets the runtime pick the
highest-entropy one (longest on a tie) and redact only that group's span.
`secretGroup` is honoured when gitleaks states it.
"""

import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOML = ROOT / "prompt-redact" / "vendor" / "gitleaks.toml"
OUT_TS = ROOT / "prompt-redact" / "hooks" / "rules.generated.ts"
OUT_MD = ROOT / "prompt-redact" / "RULES.md"
SOURCE_URL = "https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml"

POSIX = {
    "[[:alnum:]]": "[A-Za-z0-9]",
    "[[:alpha:]]": "[A-Za-z]",
    "[[:digit:]]": "[0-9]",
    "[[:xdigit:]]": "[0-9A-Fa-f]",
    "[[:space:]]": r"[\t\n\v\f\r ]",
    "[[:punct:]]": r"[!-/:-@\[-`{-~]",
    "[[:lower:]]": "[a-z]",
    "[[:upper:]]": "[A-Z]",
}


def capture_groups(pattern: str) -> int:
    """Count capturing groups, skipping escapes, character classes and (?:/lookarounds."""
    n = 0
    i = 0
    in_class = False
    while i < len(pattern):
        c = pattern[i]
        if c == "\\":
            i += 2
            continue
        if in_class:
            if c == "]":
                in_class = False
            i += 1
            continue
        if c == "[":
            in_class = True
            i += 1
            continue
        if c == "(":
            if pattern[i + 1 : i + 2] == "?":
                # (?<name> is a capture; (?<= and (?<! are lookbehinds; (?P< was converted earlier
                if pattern[i + 2 : i + 3] == "<" and pattern[i + 3 : i + 4] not in ("=", "!"):
                    n += 1
            elif pattern[i + 1 : i + 2] == "P" and pattern[i + 2 : i + 3] == "<":
                n += 1
            else:
                n += 1
        i += 1
    return n


def to_js(pattern: str):
    """Convert one RE2 pattern to a JavaScript RegExp source plus its flags.

    Inline flag groups are the subtle part. JavaScript has no `(?i:` or `(?s:)`
    at all, and RE2 patterns use them mid-pattern, not only as a prefix:
    `hf_(?i:[a-z]{34})` is a real gitleaks rule. The conversion widens rather than
    narrows -- a rule carrying any inline `(?i:` gets the whole-pattern `i` flag --
    because a redactor must favour recall, and a narrower rule is a false negative.
    """
    flags = "i"
    pattern = pattern.replace("(?i)", "")
    pattern = pattern.replace("(?-i:", "(?:")
    # (?s:.) is "any char including newline": [\s\S] in JavaScript.
    pattern = pattern.replace("(?s:.)", "[\\s\\S]")
    pattern = pattern.replace("(?s:", "(?:")
    pattern = pattern.replace("(?i:", "(?:")
    pattern = re.sub(r"\(\?P<", "(?<", pattern)
    for go, js in POSIX.items():
        pattern = pattern.replace(go, js)
    pattern = pattern.replace(r"\z", "$")
    return pattern, flags


# Cap used for every unbounded repetition. A session row is a conversation, not
# a source tree: 4096 characters covers the widest realistic credential (a
# 2048-bit RSA PEM body is ~1.6 KB) while keeping catastrophic backtracking
# impossible by construction. Anything longer is caught by the structural PEM
# scanner below, which walks the block linearly instead of matching a regex.
BOUNDED_CAP = 4096

# Rules replaced by a linear structural scanner in hooks/structural.ts. The
# regex form of `private-key` ends in `{64,}`, so truncating it at the cap would
# redact a key's head and leave its tail in the transcript -- a leak, not a
# safety win. The scanner finds BEGIN..END and redacts the whole block.
STRUCTURAL_INSTEAD = {"private-key"}


def _walk(pattern: str):
    """Yield (index, char, in_class, escaped) for every character.

    A quantifier inside `[...]` is a literal `*` or `+`, not a repetition, so the
    scanner has to know where classes start and end. Two class quirks matter: a
    `]` immediately after `[` or `[^` is literal, and an escaped character never
    changes the state.
    """
    i = 0
    in_class = False
    n = len(pattern)
    while i < n:
        ch = pattern[i]
        if ch == "\\":
            yield i, ch, in_class, True
            if i + 1 < n:
                # The escaped character is a literal: `\*` is an asterisk, never a
                # repetition, so it must not be rewritten into a brace.
                yield i + 1, pattern[i + 1], in_class, True
                i += 2
            else:
                i += 1
            continue
        if in_class:
            if ch == "]":
                yield i, ch, in_class, False
                in_class = False
                i += 1
                continue
            yield i, ch, in_class, False
            i += 1
            continue
        if ch == "[":
            in_class = True
            yield i, ch, in_class, False
            i += 1
            # A `]` here (after `[` or `[^`) is a literal member, not the close.
            j = i
            if j < n and pattern[j] == "^":
                yield j, pattern[j], in_class, False
                j += 1
            if j < n and pattern[j] == "]":
                yield j, pattern[j], in_class, False
                j += 1
            i = j
            continue
        yield i, ch, in_class, False
        i += 1


def bound_quantifiers(pattern: str) -> str:
    """Cap every unbounded repetition, including bare `*` and `+`."""
    # `{n,}` first: those carry no upper bound.
    pattern = re.sub(r"\{(\d+),\}", lambda m: "{" + m.group(1) + "," + str(BOUNDED_CAP) + "}", pattern)

    chars = list(pattern)
    for index, ch, in_class, escaped in _walk(pattern):
        if escaped or in_class or ch not in "*+":
            continue
        lazy = index + 1 < len(pattern) and pattern[index + 1] == "?"
        lo = 1 if ch == "+" else 0
        chars[index] = "{" + str(lo) + "," + str(BOUNDED_CAP) + "}"
        # A lazy `*?`/`+?` keeps its `?`: the brace form is greedy by default.
        if not lazy and index + 1 < len(pattern) and pattern[index + 1] == "?":
            chars[index + 1] = ""
    return "".join(chars)


def unbounded_quantifiers(pattern: str):
    """Every remaining unbounded repetition, for the generator to refuse if any."""
    found = []
    for m in re.finditer(r"\{(\d+),\}", pattern):
        found.append(m.group(0))
    for index, ch, in_class, escaped in _walk(pattern):
        if escaped or in_class or ch not in "*+":
            continue
        found.append(ch)
    return found


def toml_string(raw: str) -> str:
    raw = raw.strip()
    if raw.startswith("'''") and raw.endswith("'''"):
        return raw[3:-3]
    if raw.startswith('"""') and raw.endswith('"""'):
        return raw[3:-3]
    if raw.startswith('"') and raw.endswith('"'):
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ValueError(f"unreadable TOML basic string: {raw[:40]}") from exc
        if not isinstance(parsed, str):
            raise ValueError(f"expected a string, got {type(parsed).__name__}")
        return parsed
    raise ValueError(f"unrecognised TOML string: {raw[:40]}")


def parse_array(block: str, key: str):
    m = re.search(rf"\n{key}\s*=\s*\[(.*?)\]", block, re.S)
    if not m:
        return []
    return [toml_string(s) for s in re.findall(r"'''(?:.*?)'''|\"(?:[^\"\\]|\\.)*\"", m.group(1), re.S)]


def _optional_number(m, conv, rid: str, field: str):
    """Parse an optional numeric TOML field, or None when it is absent."""
    if not m:
        return None
    try:
        return conv(m.group(1))
    except ValueError as exc:
        raise ValueError(f"rule {rid}: unreadable {field}={m.group(1)!r}") from exc


def label_for(rule_id: str) -> str:
    return re.sub(r"[^A-Z0-9]+", "_", rule_id.upper()).strip("_")


GENERIC_WORDS = {
    "access", "api", "auth", "credential", "creds",
    "key", "passwd", "password", "secret", "token",
}


def classify(pattern: str, keywords) -> str:
    """Three coverage families, as measured on the shipped corpus.

    'generic' is the recall workhorse: its whole keyword set is made of generic
    credential words, so it fires on any vendor nobody wrote a rule for. A rule
    with even one vendor-specific keyword is 'vendor-keyword' -- it only ever
    sees that vendor. 'prefix' matches an unmistakable literal prefix rather than
    a name, so it needs neither keyword nor entropy to stay precise.
    """
    if keywords and all(k in GENERIC_WORDS for k in keywords):
        return "generic"
    head = pattern.lstrip("(")
    if re.match(r"^(?:\\b)?(?:\\?\()?(?:[A-Za-z0-9][A-Za-z0-9_\-]{2,})", head) and "|[" not in head[:40]:
        return "prefix"
    if keywords:
        return "vendor-keyword"
    return "generic"


def main() -> int:
    if not TOML.exists():
        print(f"missing vendored corpus: {TOML}", file=sys.stderr)
        return 1

    text = TOML.read_text()
    digest = hashlib.sha256(text.encode()).hexdigest()
    blocks = re.split(r"\n\[\[rules\]\]\n", text)[1:]

    rules = []
    # Every vendored rule that does not reach the regex corpus is recorded with its
    # reason, so RULES.md can name the absences instead of leaving a silent gap.
    skipped: list[tuple[str, str]] = []
    vendored_total = 0
    for block in blocks:
        id_match = re.search(r'\n?id\s*=\s*"([^"]+)"', block)
        if not id_match:
            raise ValueError(f"rule block without an id: {block[:80]!r}")
        rid = id_match.group(1)
        m = re.search(r"\n?regex\s*=\s*('''.*?'''|\"(?:[^\"\\]|\\.)*\"|\"\"\".*?\"\"\")", block, re.S)
        vendored_total += 1
        if not m:
            # a path- or entropy-only rule: nothing to match on text
            skipped.append((rid, "path"))
            continue
        if rid in STRUCTURAL_INSTEAD:
            skipped.append((rid, "structural"))
            continue
        raw_regex = toml_string(m.group(1))
        regex, flags = to_js(raw_regex)
        regex = bound_quantifiers(regex)
        leftover = unbounded_quantifiers(regex)
        if leftover:
            raise ValueError(f"rule {rid}: unbounded quantifiers survived: {leftover}")
        groups = capture_groups(regex)
        entropy = _optional_number(re.search(r"\nentropy\s*=\s*([\d.]+)", block), float, rid, "entropy")
        keywords = [k.lower() for k in parse_array(block, "keywords")]
        secret_group = _optional_number(re.search(r"\nsecretGroup\s*=\s*(\d+)", block), int, rid, "secretGroup")
        allow = []
        for ab in re.findall(r"\[\[rules\.allowlists\]\](.*?)(?=\n\[\[|\Z)", block, re.S):
            for a in parse_array(ab, "regexes"):
                allow.append(to_js(a)[0])
        rules.append(
            {
                "id": rid,
                "label": label_for(rid),
                "regex": regex,
                "flags": flags,
                "groups": groups,
                "secretGroup": secret_group,
                "entropy": entropy,
                "keywords": keywords,
                "allow": allow,
                "kind": classify(regex, keywords),
                "source": f"{SOURCE_URL}#{rid}",
            }
        )

    # Global allowlist (regexes + stopwords; gitleaks' `paths` cannot apply here,
    # because session rows carry no file path).
    glob = re.search(r"\n\[allowlist\](.*?)(?=\n\[\[|\Z)", text, re.S)
    global_regexes, global_stopwords = [], []
    if glob:
        for a in parse_array(glob.group(1), "regexes"):
            global_regexes.append(to_js(a)[0])
        global_stopwords = [s.lower() for s in parse_array(glob.group(1), "stopwords")]

    kinds = {"prefix": 0, "vendor-keyword": 0, "generic": 0}
    for r in rules:
        kinds[r["kind"]] += 1

    body = [
        "// GENERATED FILE -- do not edit by hand.",
        "// Source: tools/gen-rules.py over prompt-redact/vendor/gitleaks.toml",
        f"// gitleaks.toml sha256: {digest}",
        f"// {len(rules)} rules: {kinds['prefix']} prefix-anchored, "
        f"{kinds['vendor-keyword']} vendor-keyword, {kinds['generic']} generic.",
        "",
        "export type Rule = {",
        "  /** gitleaks rule id, the provenance key. */",
        "  readonly id: string;",
        "  /** Label a placeholder carries: [REDACTED:<label>#<hash>]. */",
        "  readonly label: string;",
        "  /** JavaScript RegExp source, converted from the upstream RE2 pattern. */",
        "  readonly regex: string;",
        "  readonly flags: string;",
        "  /** Capture groups present; the runtime redacts the highest-entropy one. */",
        "  readonly groups: number;",
        "  /** Which group holds the value, when gitleaks states it explicitly. */",
        "  readonly secretGroup: number | null;",
        "  /** Minimum Shannon entropy of the value, when the rule gates on it. */",
        "  readonly entropy: number | null;",
        "  /** Prefilter: the rule is only run when one of these appears in the row. */",
        "  readonly keywords: readonly string[];",
        "  /** Per-rule allowlist: a value matching one of these is left alone. */",
        "  readonly allow: readonly string[];",
        "  readonly kind: 'prefix' | 'vendor-keyword' | 'generic';",
        "  /** Provenance, one URL per rule. */",
        "  readonly source: string;",
        "};",
        "",
        "export const RULES: readonly Rule[] = [",
    ]
    for r in rules:
        body.append(
            "  {"
            f' id: {json.dumps(r["id"])},'
            f' label: {json.dumps(r["label"])},'
            f' regex: {json.dumps(r["regex"])},'
            f' flags: {json.dumps(r["flags"])},'
            f' groups: {r["groups"]},'
            f' secretGroup: {json.dumps(r["secretGroup"])},'
            f' entropy: {json.dumps(r["entropy"])},'
            f' keywords: {json.dumps(r["keywords"])},'
            f' allow: {json.dumps(r["allow"])},'
            f' kind: {json.dumps(r["kind"])},'
            f' source: {json.dumps(r["source"])} '
            "},"
        )
    body.append("];")
    body.append("")
    body.append("/** gitleaks' own global allowlist, minus its path patterns (rows carry no path). */")
    body.append("export const GLOBAL_ALLOW_REGEXES: readonly string[] = [")
    for g in global_regexes:
        body.append(f"  {json.dumps(g)},")
    body.append("];")
    body.append("")
    body.append("export const GLOBAL_STOPWORDS: readonly string[] = [")
    for s in global_stopwords:
        body.append(f"  {json.dumps(s)},")
    body.append("];")
    body.append("")
    body.append(f"export const CORPUS_SHA256 = {json.dumps(digest)};")
    body.append("")
    OUT_TS.parent.mkdir(parents=True, exist_ok=True)
    OUT_TS.write_text("\n".join(body))

    md = [
        "# Rule provenance",
        "",
        "Every rule prompt-redact ships names a public source. This file is generated by",
        "`tools/gen-rules.py` in the same pass that writes `hooks/rules.generated.ts`,",
        "so a rule cannot exist without a provenance row -- `tools/check-rules.mjs`",
        "fails the build otherwise.",
        "",
        f"- Corpus: [`config/gitleaks.toml`]({SOURCE_URL}) (MIT, see `vendor/GITLEAKS-LICENSE`)",
        f"- Vendored copy: `vendor/gitleaks.toml`, sha256 `{digest}`",
        f"- Rules: **{len(rules)}** -- {kinds['prefix']} prefix-anchored, "
        f"{kinds['vendor-keyword']} vendor-keyword, {kinds['generic']} generic",
        "",
    ]
    md += [
        "The brief that commissioned this corpus said \"222 rules: 48 literal-prefix-anchored",
        "+ 173 vendor-keyword-gated + 1 generic\". Those figures describe how *upstream*",
        "gitleaks thinks about its rules; the counts above describe how this generator",
        "classifies the same rules by what makes them cheap to run.",
        "",
        f"The vendored corpus holds **{vendored_total}** rules; the regex corpus holds "
        f"**{len(rules)}**. {len(skipped)} `id`s are absent, and each is deliberate:",
        "",
    ]
    for rid, reason in skipped:
        if reason == "structural":
            md += [
                f"- `{rid}` -- handled by the linear PEM scanner (`hooks/structural.ts`)",
                "  instead of a regex. Its upstream pattern ends in `{64,}`, and capping that would",
                "  redact a key's head while leaving its tail in the transcript. A leak, not a",
                "  saving.",
            ]
        else:
            md += [
                f"- `{rid}` -- a gitleaks **`path`** rule. It fires on a *file path*, not on",
                "  content, and this mod scans content, so it is not ported. Nothing is lost: a",
                "  `.p12` file is binary, and the password protecting it is the secret, which the",
                "  generic family already covers.",
            ]
    # `generic` holds more than one upstream rule because a rule is classified by what
    # gates it; naming each one is what stops "one generic rule" from being restated.
    generic_rules = [r for r in rules if r["kind"] == "generic"]
    md += [
        "",
        f"The family counts also differ from the brief: `generic` reads **{len(generic_rules)}**, not 1, and",
        "none of them is a local invention. A rule is classified by what gates it, and these",
        "upstream rules are gated only on a generic keyword:",
        "",
    ]
    for r in generic_rules:
        kws = r["keywords"]
        if len(kws) > 3:
            gate = "the keyword alternation (" + "|".join(kws) + ")"
        elif len(kws) == 1:
            gate = f"its only keyword is the bare word `{kws[0]}`"
        elif kws:
            gate = "its keywords are " + ", ".join(f"`{k}`" for k in kws)
        else:
            gate = "no keyword at all"
        shaped = "kind:" in r["regex"]
        md.append(
            f"- `{r['id']}` -- {gate}"
            + (
                ", with its shape carried by a `kind: Secret` / `data:` block rather than by the keyword."
                if shaped
                else "."
            )
        )
    md += [
        "",
        "A rule anchored by a literal prefix is counted `prefix` even when upstream also",
        "gives it a keyword -- the prefix is what makes it cheap to run.",
        "",
        "Coverage families, and what each is blind to:",
        "",
        "| Family | Count | Catches | Blind to |",
        "| --- | --- | --- | --- |",
        f"| prefix | {kinds['prefix']} | an unmistakable literal prefix (`AKIA`, `ghp_`, `ops_eyJ`) | any vendor that ships no prefix |",
        f"| vendor-keyword | {kinds['vendor-keyword']} | a vendor name within 50 chars of a high-entropy value | every vendor nobody wrote a rule for |",
        f"| generic | {kinds['generic']} | a `keyword = value` assignment, or a Kubernetes Secret `kind:`/`data:` block | a secret with no name and no shape |",
        "",
        "The corpus is an enumeration of *vendors*, so its coverage has a long, open tail.",
        "The generic family is what covers the tail, at a much higher false-positive rate --",
        "which is exactly why it is the only family the entropy floor can tighten",
        "(`minEntropy` raises the generic rules, never the vendor ones).",
        "",
        "| Rule | Label | Family | Entropy gate | Provenance |",
        "| --- | --- | --- | --- | --- |",
    ]
    for r in rules:
        md.append(
            f"| `{r['id']}` | `{r['label']}` | {r['kind']} | "
            f"{r['entropy'] if r['entropy'] is not None else '--'} | [source]({r['source']}) |"
        )
    OUT_MD.write_text("\n".join(md) + "\n")

    print(f"wrote {OUT_TS.relative_to(ROOT)} ({len(rules)} rules)")
    print(f"wrote {OUT_MD.relative_to(ROOT)}")
    print(f"families: prefix={kinds['prefix']} vendor-keyword={kinds['vendor-keyword']} generic={kinds['generic']}")
    print(f"global allow regexes={len(global_regexes)} stopwords={len(global_stopwords)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
