# Redacting secrets before they reach the model

Research record for `prompt-redact`. Every claim below is either quoted from a
public source or measured on the shipped corpus; where the two disagree, the
measurement wins and the disagreement is noted.

## 1. The constraint that decides the architecture

`UserPromptSubmit` (a settings hook) **cannot replace prompt text**. It can only
block or append `additionalContext`. Four open Anthropic issues ask for a rewrite
channel ([#53330](https://github.com/anthropics/claude-code/issues/53330),
[#66172](https://github.com/anthropics/claude-code/issues/66172),
[#34390](https://github.com/anthropics/claude-code/issues/34390),
[#20833](https://github.com/anthropics/claude-code/issues/20833), the last about an
undocumented `updatedPrompt` that the docs' own Python SDK example uses).

So every hook-based redactor in the wild is a tripwire, not a redactor:
`l-mb/claude-code-redaction-hooks` documents a per-event matrix where
`UserPromptSubmit` is "block Y / redact N (warns only)", and warns outright
*"DO NOT rely on this tool to actually offer meaningful protection."*

The **mods** API can rewrite: `on('prompt.submit', ($, e, next) => next({ ...e,
text }))`, where "Later handlers and Claude Code receive the trimmed prompt and
never see the original." That is why this is a mod, not a hooks plugin.

## 2. Where secrets actually get in — and which event catches each

| Carrier | Event that catches it | Notes |
| --- | --- | --- |
| typed prompt | `prompt.submit` | rewrite before queueing |
| `@file` mention expansion | `session.append` | `prompt.mention` can only change `path` or deny; the expansion lands as a row, so the row rewrite covers it |
| tool result (Read/Bash/Grep/MCP) | `session.append` | door `tool-result` |
| Claude's own reply blocks | `session.append` | closes the echo-back leak |
| reminders / attachments / notices | `session.append`, `prompt.attachment` | doors `attachment`, `notice`, `hook-context` |
| subagent rows | `session.append` with `e.agentId` | |
| compaction summaries | `session.append` (door `compaction`) | the summary becomes a row |
| system-prompt sections | `prompt.section` | only additive (a notice), never a scrub target |

`session.append` is the load-bearing event: it fires once per row *before* it is
stored, and the model and the transcript file read the same rewritten row.

## 3. Why rule-based recall is the hard part

| Tool | Precision | Recall | Benchmark |
| --- | ---: | ---: | --- |
| gitleaks | 0.931 | 0.413 | ProwlBench v2 |
| detect-secrets | 0.848 | 0.423 | ProwlBench v2 |
| TruffleHog | 0.940 | 0.303 | ProwlBench v2 |
| Prowl (Go cascade, no ML) | 0.951 | 0.823 | ProwlBench v2 |

The same gitleaks scores **88% recall / 46% precision** in the
[comparative study](https://arxiv.org/html/2307.00714). Recall is a property of
the benchmark's distribution, not of the tool: ProwlBench is 57% generic
passwords/keys in prose, which prefix scanners do not target by design.

Measured on Samsung's CredData by LeakWatch: **recall 0.168** before tuning,
0.518 after. The entire deficit sat on secrets with no recognisable shape —
fixed-format rules already worked (PEM 0.96, Basic Auth 0.94), while
`Key` was 0.002 and `Password` 0.002.

The two levers that moved it:

1. **The anchor, not the value.** Accepting any prefix
   (`[\w.-]{0,50}?(?:secret|key|token)`) took recall 0.173 -> 0.518 *and raised
   precision 11 points*, because real secrets live in `MINIO_SECRET_KEY=` while
   the narrow rule only matched the rare bare `access_token =` form. Widening the
   accepted *value* (the length floor) is what costs precision.
2. **Three independent defects in one generic rule:** a keyword that had to start
   the token, a separator looked for before the closing quote (breaking JSON and
   quoted YAML), and a length floor of 24 above the real 10th percentile of 16-20.

gitleaks' own `generic-api-key` already has the corrected shape, so this mod
ports it rather than writing a new one.

## 4. The allowlist is what buys aggression

A redactor's false positive is cheap. But one class of false positive breaks the
task: redacting a value the model *needs* — a git SHA, an object id, a lockfile
integrity hash, an AWS ARN (a resource identifier; there is nothing to revoke, and
in one measurement ARNs produced 1,230 of 1,399 unlabelled false positives at
0.076 precision).

So the aggression is paid for by naming every benign high-entropy shape
explicitly, which lets the generic threshold sit low. `hooks/allowlist.ts` carries
29 named shapes, each with a stated reason.

A related trap: masking a value before judging it (`<RND>`) deletes the word
`EXAMPLE` — which is exactly the evidence that `AKIAIOSFODNN7EXAMPLE` is a
documented sample. This mod never masks before judging.

## 5. The shipped corpus, measured

`vendor/gitleaks.toml` (MIT, sha256 `e163e53b9e7e…`) -> 220 generated rules:

| Family | Count | Catches | Blind to |
| --- | ---: | --- | --- |
| prefix | 95 | an unmistakable literal prefix | vendors that ship no prefix |
| vendor-keyword | 123 | a vendor name within 50 chars of a high-entropy value | every vendor nobody wrote a rule for |
| generic | 2 | any `keyword = value` assignment | a secret with no name and no shape |

Transformations applied, all documented in `tools/gen-rules.py`: `(?i)` -> flag,
`(?-i:` -> `(?:`, `(?P<` -> `(?<`, `[[:alnum:]]` -> JS class, `\z` -> `$`, and
every unbounded repetition capped at 4096.

`private-key` is **removed** from the regex corpus and handled by a linear
structural scanner instead: its upstream pattern ends in `{64,}`, so capping it
would redact a key's head and leave its tail in the transcript. That is a leak,
not a safety win.

## 6. Coverage matrix — tier × carrier, with measured recall

Measured, not projected. `node tools/measure-recall.mjs` runs 35 synthetic
fixtures (invented for the test; no real credential) through the shipped detector
and reports what it actually catches:

| Tier | Meaning | L1 recall | L1+L2 recall |
| --- | --- | --- | --- |
| T1 | vendor-prefixed credential (`AKIA`, `ghp_`, `xoxb-`, `sk_live_`) | 100% | 100% |
| T2 | generic `keyword = value` | 100% | 100% |
| T3 | prose / multilingual password (ProwlBench's hard tier) | **0%** | **40%** |
| T4 | self-proving structural shape (PEM, JWT, IBAN, Luhn, SSA, TOTP) | 100% | 100% |
| T5 | shapeless proprietary value (high entropy, no anchor) | **0%** | **100%** |
| T6 | benign high-entropy control — must NOT be redacted | FP 0% | FP 0% |

L1 is structural detectors + the 220-rule corpus + allowlist + context score.
L2 adds an optional local weights file (`hooks/classifier.ts`), evaluated with
ordinary arithmetic in-process.

**Read the L1+L2 column with its provenance.** Those numbers come from
`prompt-redact/tests/fixtures/classifier.example.json`, an *untrained* synthetic
weights file written to exercise the loader and scorer. No weights ship: fitting
them requires a corpus of real credentials to leave the machine, which this mod
forbids. So the L1 column is a measurement of shipped behaviour, and the L1+L2
column is a measurement of the *mechanism* -- what a trained model could recover,
not what any shipped model does.

The two rows worth reading carefully are T3 and T5. They are 0% at L1 for the
same structural reason: a detector built on anchors has nothing to grip on a
value that carries neither a vendor prefix nor a keyword beside it. T5 closes
completely at L2 on this fixture set because a proprietary token is still
high-entropy and machine-shaped. T3 only reaches 40%: prose passwords are often
*low* entropy and dictionary-shaped, so features computed from characters alone
cannot separate `Sommerberg-2019` from an ordinary phrase. That is a real gap,
stated as a gap, not rounded up.

Carrier reachability is a different question from recall: the detectors may be
right, but a hook has to be given the carrier.

| Carrier | Hook that reaches it | Reach |
| --- | --- | --- |
| typed prompt | `prompt.submit` | always |
| tool result (Read/Bash/Grep/MCP) | `tool.call` | always |
| reply block, subagent row | `session.append` | reached at user tier; the guard does not skip these doors |
| compaction summary, injected rows (attachment, hook-context, skill body, org note) | `session.append` | **not reached at user tier** — the guard forwards these doors past the user tier |
| managed CLAUDE.md / instruction context | none (`prompt.context` unhooked) | **not covered at any tier** |
| skill body as text | none (`skill.prompt` unhooked) | **not covered at any tier** |
| `@`-mentioned file content (attachment blob) | `prompt.attachment` | **not covered on this deployment — measured leak** (organization account, outer policy plugin seats first) |
| injected attachment (a settings hook's context) | `prompt.attachment` | where the platform lets a user plugin hook it |
| system-prompt notice | `prompt.compose`, `prompt.section` | where the platform lets a user plugin hook it |

The attachment row is a measurement, not a projection. On the organization
account, a live Haiku session referenced a file holding two synthetic canaries
from the prompt as an `@`-mention. `tools/verify-transcript.mjs` over that session
exits non-zero with two `FAIL GUARANTEE VIOLATED` lines:

```text
FAIL GUARANTEE VIOLATED: canary appears in model-facing content x1 — line 21 (api-request-blob(role=system))
FAIL GUARANTEE VIOLATED: canary appears in model-facing content x1 — line 21 (api-request-blob(role=system))
2 verification failure(s)
```

`grep -c` finds **2** raw occurrences of each canary in the session file, and
`prompt.attachment` never fired for the event: `/redact why` reported it under
`not observed`, while the platform stated at session start that the hook was
*skipped* because `cc-plugin-sec-default` "runs first and sent the event on past
it". So an `@`-mentioned file's content reaches the model unredacted. That is a
guarantee violation for this carrier on this deployment, not a caveat. It is not
fixable from inside the mod: a hook the outer policy plugin skips cannot be made
to fire from here. On an account where the hook does fire, the same content would
be scanned by the same detectors — that is the code path, not a measurement.

Captures: `reports/evidence/05/attachment-probe.txt` under
`.scratch/prompt-redact-followups/`, and session
`219934f7-2129-4185-a6f5-973a584cfc47.jsonl`.

That deployment caveat is measured, not hypothetical. On this machine an
organization OAuth account seats the builtin `cc-plugin-sec-default` outermost,
and the engine logged that this mod's `session.append`, `prompt.section`,
`prompt.compose` and `prompt.attachment` hooks were each *skipped* ("runs first
and sent the event on past it"). The builtin plugin states its purpose plainly:
it keeps organization prompt content "out of reach of the plugins a person
installs".

Redaction held for the typed prompt and the tool result — the two carriers a
secret must cross, governed by `prompt.submit` and `tool.call`, which do run — but
it did **not** hold for the attachment carrier above. The remaining carriers
(reply rows, notices) are defence in depth for a value that already crossed
`prompt.submit` or `tool.call`: a reply can only echo a placeholder, since the
model never saw the real value. That reasoning does not transfer to a carrier the
model receives directly, which is why the attachment row is stated as a leak
rather than as depth. A person on an org account who needs any of these hooks to
run has to ask their administrator to list this plugin under managed
`prependPlugins`.

Two categories are deliberately abandoned, matching LeakWatch's own reasoning:
bare `Password` values in fixtures (they capped out on exactly this) and bare
`UUID`s (64% carry no keyword; redacting every UUID breaks real work). The UUID
case is covered by the allowlist instead: accept a small blind spot to keep the
tool usable.

## 7. Reversibility, the dangerous half

A placeholder that can be turned back into a real value anywhere is an
exfiltration primitive. This mod restores values **only** inside `Edit`, `Write`
and `NotebookEdit` arguments — enough for an edit to a line holding a real key to
still match disk, and never enough for the model to pipe a placeholder into a
shell command. `Bash` never receives a real value.

Placeholder identity is `[REDACTED:<LABEL>#<16 hex>]` from two FNV-1a passes over
`salt + value`, so the same secret yields the same placeholder in a prompt row, a
tool-result row, an edit and a compaction summary. The salt is per-session, so a
placeholder copied in from another session restores nothing.

The vault lives in `$.state` only: session-scoped, survives a hot reload, cleared
by `/clear`/`/resume`, gone at exit, never on disk and never in `$.store`.

## 8. Measurement protocol (what would falsify the above)

- **Per-rule**, not per-tool. [Boundary-mutation testing](https://arxiv.org/pdf/2609.02983.pdf)
  varies the text surrounding a credential to catch context-sensitivity at the
  rule level.
- **A false negative cannot be attributed to a rule** (no rule fired). Group
  misses by secret *kind* from the benchmark taxonomy, then walk back manually —
  LeakWatch's method; without it a gain on `Key` cancelling a loss on `Token` is
  invisible.
- **Dedupe before measuring.** SecretBench is 69.3% exact duplicates; CredData's
  false-positive set is 32.8% duplicates. An undeduped benchmark measures
  duplicate rejection.
- Use **CredData** and **ProwlBench v2**; not SecretBench alone.

## Sources

- Claude Code mods events and reference: <https://code.claude.com/docs/en/plugins/mods/events>, <https://code.claude.com/docs/en/plugins/mods/reference>
- Hooks reference (rewrite matrix): <https://code.claude.com/docs/en/hooks>
- `karanb192/claude-code-redact` (prior art: mods-based redaction): <https://github.com/karanb192/claude-code-redact>
- `l-mb/claude-code-redaction-hooks` (per-event block/redact matrix, warnings): <https://github.com/l-mb/claude-code-redaction-hooks>
- `datumbrain/claude-code-privacy-guard`, `coo-quack/sensitive-canary`, `CaptainASIC/datasentry` (block-based prior art)
- LeakWatch, *Tripling our secret scanner's recall* (CredData measurements): <https://leakwatch.net/blog/tripling-our-secret-scanner-recall>
- GitHub, *GitHub's model for secret detection* (regex + ModernBERT two-stage): <https://github.blog/ai-and-ml/githubs-model-for-secret-detection-finding-more-secrets-with-less-noise/>
- Basak et al., *A Comparative Study of Software Secrets Reporting by Secret Detection Tools*: <https://arxiv.org/html/2307.00714>
- *Boundary-Mutation Testing for Pattern-Based Secret Detection*: <https://arxiv.org/pdf/2609.02983.pdf>
- ProwlBench v2 (tiered, 24,603 cases): <https://github.com/Lercas/prowlbench>
- Samsung CredData: <https://github.com/Samsung/CredData>
- Rahman et al., *Secret Breach Detection in Source Code with Large Language Models*: <https://arxiv.org/abs/2504.18784>
- Presidio entity coverage and its EU gap: <https://github.com/microsoft/presidio/blob/main/docs/supported_entities.md>, <https://anonym.legal/blog/presidio-eu-entity-coverage-gap-gdpr-2025>
