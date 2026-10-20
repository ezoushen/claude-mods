# Decisions record — prompt-redact

Every judgment call made while building this mod, with the evidence behind it and
the alternatives that were rejected. The objective asked for this record so the
decisions can be reviewed rather than inferred from the code.

## 1. Mods, not a settings hook

**Decision:** build as a mod (`prompt.submit`/`session.append`), not a
`UserPromptSubmit` settings hook.

**Evidence:** `UserPromptSubmit` can only block or append `additionalContext`; it
has no rewrite channel, which four open Anthropic issues ask for
(#53330, #66172, #34390, #20833). Every hook-based redactor surveyed
(`l-mb/claude-code-redaction-hooks`, `datumbrain/claude-code-privacy-guard`,
`coo-quack/sensitive-canary`, `CATAAM/prompt-guard`) ends up as a block-or-warn
tripwire, and `l-mb`'s own README states outright that it should not be relied on
for meaningful protection. A mod rewrites the prompt: "Later handlers and Claude
Code receive the trimmed prompt and never see the original."

**Rejected:** hooks plugin (cannot rewrite); proxy/gateway (owns traffic, blind to
the tool loop, and out of scope for a mod).

## 2. Port the gitleaks corpus rather than write rules

**Decision:** vendor `config/gitleaks.toml` (MIT) and generate 220 TypeScript
rules from it; do not hand-author a rule set.

**Evidence:** the corpus is 95 prefix-anchored, 123 vendor-keyword, 2 generic
rules. Its `generic-api-key` already carries the three fixes that measurement
says matter (tolerant prefix `[\w.-]{0,50}?(?:…)`, separators including `=>` and
`:=`, a quote tolerated before the value, length floor 10). Hand-writing that
shape would reproduce LeakWatch's three defects, which cost them 84% of misses
until fixed.

**Transformations, all documented in `tools/gen-rules.py`:** `(?i)` →
whole-pattern `i` flag; `(?-i:` → `(?:`; `(?i:` → `(?:` plus the `i` flag;
`(?s:.)` → `[\s\S]`; `(?P<` → `(?<`; `[[:alnum:]]` → JS class; `\z` → `$`.

**Why the widening is deliberate:** JavaScript has no inline flag groups, and 137
of 221 patterns carry `(?i)` mid-pattern. Stripping them would *narrow* matching,
which in a redactor means false negatives. Widening case-insensitivity costs a
few false positives — the cheap direction.

**Rejected:** TruffleHog-style live verification (requires network → forbidden by
the no-egress invariant); detect-secrets baselines (line-number keyed, breaks on
edits).

## 3. `private-key` is structurally scanned, not a regex

**Decision:** remove the `private-key` regex rule and find PEM blocks with a
linear scanner in `hooks/structural.ts`.

**Evidence:** the upstream pattern ends in `{64,}`. Capping it at the 4096
bound would match a key's head and leave its tail in the transcript — a leak
dressed as a safety win. The scanner walks `BEGIN … END` and redacts the whole
block, and an unterminated block redacts to end-of-row (fail closed).

## 4. Every quantifier bounded, and empirically checked

**Decision:** cap every unbounded repetition at 4096 in the generator; refuse a
corpus containing any survivor; and enforce a per-row wall-clock budget (default
1500 ms, configurable).

**Evidence:** 11 of 221 upstream rules carry unbounded quantifiers. This code runs
in-process inside Claude Code, so a catastrophic backtrack would stall the
session itself. The generator raises rather than emitting an unbounded rule, and
`tools/check-rules.mjs` fails the build if one reappears.

**Corrected mid-build:** an earlier claim that "all 221 compile" was wrong — the
integrity gate caught `(?i:` and `(?s:` groups that JavaScript cannot parse. The
gate exists precisely because that claim was easy to make and false.

## 5. The allowlist is the precision budget

**Decision:** name every benign high-entropy shape explicitly (26 entries), and
let the generic detector run at a low threshold because of it.

**Evidence:** a redactor's false positive is cheap — Claude reads
`[REDACTED:…]` where a meaningless hash was. But one class breaks the task:
redacting a git SHA, object id, lockfile digest or resource ARN leaves the model
unable to do the work. LeakWatch measured AWS ARNs producing 1,230 of 1,399
unlabelled false positives at 0.076 precision — a resource identifier with
nothing to revoke.

**Corrected mid-build:** the first "lockfile integrity" pattern
`(?:sha\d+-)?[A-Za-z0-9+/]{40,}` allowlisted *any* 40+ character alphanumeric
run, which silently disabled the generic detector for most real secrets. A test
caught it. It now requires the `sha<N>-` prefix.

## 6. Highest-entropy capture group, not a fixed group number

**Decision:** for each rule match, redact the highest-entropy non-empty capture
group (ties on length), honouring `secretGroup` when upstream states it; use
`d`-flag match indices so only that group's span is replaced.

**Evidence:** gitleaks' rules disagree. In `atlassian-api-token` group 1 is the
vendor keyword and group 2 is the secret; `curl-auth-header` has eight
alternative credential groups of which exactly one is non-empty per match;
`heroku-api-key-v2` has a nested duplicate where group 1 is the full value.

## 7. Deterministic placeholders, and the salt is per session

**Decision:** `[REDACTED:<LABEL>#<16 hex>]` from two FNV-1a passes over
`salt + value` and `value + salt`; salt is random per session and held in
`$.state`.

**Evidence:** an edit to a line holding a real key must match the file on disk, so
the same secret must yield the same placeholder in every row. A foreign salt
means a placeholder copied in from another session restores nothing.

## 8. Rehydration is scoped to three tools

**Decision:** restore real values only in `Edit`, `Write` and `NotebookEdit`
arguments. Never `Bash`, never MCP, never anywhere else.

**Evidence:** rehydration anywhere the model can reach the network turns a
placeholder into an exfiltration primitive — the model can pipe it into `curl`
and it resolves on the way out. Verified live: the Write preview showed the real
canary while the prompt row showed the placeholder.

## 9. Fail closed, twice

**Decision:** a scanner throw or budget overrun withholds the row
(`[redact withheld this content: the redactor failed while scanning it]`); a prompt that cannot be scanned is
dropped rather than sent.

**Evidence:** the asymmetry is stark — a dropped prompt is visible and
recoverable, a leaked key is neither. Encoded in a test that sets
`scanBudgetMs: -1` and asserts the withheld marker reaches the row. The marker is a
single exported constant (`WITHHELD` in `hooks/register.ts`) and the test asserts its
literal prefix, so a future reword has to break a test rather than silently diverge
from this document.

## 10. There *is* an L2 tier: a local weights file, not a remote model

**Corrected decision.** An earlier version of this record claimed an L2
classifier was impossible here because inference would need `$.model` or
`$.process`. That was wrong, and the error was mine: a weights file read with
`$.fs.read` and evaluated with `bias + Σ w·x` needs neither. This version
implements it (`hooks/classifier.ts`).

**What it is:** a linear model over twelve character-derived features, loaded from
`.claude/prompt-redact.model.json` and scored in-process. It adds one detector the
corpus structurally cannot have — one that runs *without an anchor* — over a token
sweep of the row, which is what lets it reach values carrying neither a vendor
prefix nor a keyword beside them.

**What it is not:** trained. No weights ship. Training needs data that leaves the
machine, which the same invariant forbids; a made-up weights file would be a
fabricated model pretending to be a measured one. Absent, unreadable or malformed
weights means the pipeline stays at L1 — silently, because that is the normal case.

**Measured effect** (`tools/measure-recall.mjs`, 35 synthetic fixtures):
shapeless proprietary values 0% → 100%; prose passwords 0% → 40%. The second
number is the honest limit: a prose password is often dictionary-shaped and
low-entropy, so character features cannot separate it from an ordinary phrase. It
is reported as a gap.

**Still excluded:** `$.model` and `$.process` remain grep-forbidden. The invariant
that a detector must never transmit the value it hides is intact.

## 11. `deny` outranks everything, and is its own detector

**Decision:** a force-redact pattern is tested against each value token (and the
whole text), bypassing allowlist, entropy and context score.

**Corrected mid-build:** the deny check originally sat *after* the allowlist and
only ran on values some rule had matched, so `/redact deny` was silently
unreachable for exactly the values a person would want to force. A test caught it.

## 12. Transcript retention: one leak fixed, one residual measured

**First measurement (run 1, session `1ae40c84`).** The model-facing context was
fully redacted — the Read row handed to the model read
`STRIPE_KEY=[REDACTED:GENERIC_API_KEY#37313b60cead24a2]` — yet the same JSONL kept
the raw value in four row shapes. Two were `toolUseResult` sidecars, which sit
outside `message.content`:

| Row | Field | Reachable by a hook? |
| --- | --- | --- |
| `toolUseResult` (Write) | `content` | no — outside `message.content` |
| `toolUseResult` (Read) | `file.content` | no — engine stores the raw tool output |
| `attachment` (`hook_success`) | `stdout`/`stderr`/`content` | no — the row has **no `message` field** |
| `api-request-blob` | `message` | no — recorded request body, not a conversation row |

**Fix applied.** Rewrite the tool's own result at `tool.call` (after `next`),
because the engine records a hook's returned result as the tool's result and
therefore stores the redacted form in the sidecar. This closed both
`toolUseResult` leaks.

**Second measurement (run 2, session `754ba0ed`, with the fix).** Via
`tools/verify-transcript.mjs` over 93 rows:

```text
model-facing canary occurrences: 0 (must be 0)
toolUseResult canary occurrences: 0 (must be 0)
RESIDUAL (not hook-reachable): 21
  hook_success attachment: 16 occurrence(s) across 25 rows
  api-request-blob: 5 occurrence(s) across 9 rows
rehydration: /tmp/prompt-redact-e2e/saved2.txt holds the real value (20 bytes)
```

**Residual, and why it is structural.** `session.append` rewrites
`message.content`; the two remaining row kinds have no such field. A
`hook_success` attachment is the engine's record of a *settings hook's*
stdout/stderr — another plugin's output, not this mod's row — and an
`api-request-blob` is a captured request body. No mods event exposes either.

**Rejected:** claiming the session file is clean. The measurement contradicts it.

## 13. The acceptance check stands as originally written

Check #7 read "`grep -c '<canary>' <session>.jsonl` returns 0". I proposed
amending it after a measured run showed 9 and 4, obtained the operator's consent
for the narrower check, and then found the *actual* cause of those numbers: a
third-party memory plugin was replaying earlier-session content into the system
prompt, and `tools/verify-transcript.mjs` was excluding recorded request blobs from
"model-facing" — so it reported 0 while three `role: system` bodies carried the
canary.

With both corrected — request blobs counted as model-facing, the memory plugin
excluded from the test session — the literal check passes: `grep -c` returns **0**
for both canaries, `model-facing` and `toolUseResult` are 0, and residual is 0.
No amendment is needed, so none is claimed. The consent record for the narrower
check is retained here as superseded rather than deleted.

## 14. `prompt.attachment` — the carrier I had not registered

`session.append` rewrites stored rows. A settings hook's SessionStart or
UserPromptSubmit "additional context" is **not** a stored row: it is injected into
the request, and only `prompt.attachment` sees it. A live session showed that
context reaching the request body's system channel with the canary intact, and no
hook in this plugin was registered for the event that could rewrite it. That is
now registered: `e.text` is scrubbed, `next({ ...e, text })` carries the answer,
and a scan failure returns `{ text: null }` — dropping the attachment rather than
carrying it raw.

**Deployment caveat, measured.** On an organization account the builtin
`cc-plugin-sec-default` seats outermost; the engine logged that this mod's
`prompt.attachment`, `prompt.compose`, `prompt.section` and `session.append` hooks
were each skipped ("runs first and sent the event on past it"). That plugin's own
description says it keeps organization prompt content "out of reach of the plugins
a person installs" — a policy boundary, not a bug in this mod. The typed prompt and
tool results stay covered because `prompt.submit` and `tool.call` do run. An
administrator who wants the rest covered lists this plugin under managed
`prependPlugins`.

**Measured limit (ticket 05, organization account).** Registration does not help
where the event never arrives. An `@`-mentioned file holding two synthetic
canaries was measured reaching model-facing content unredacted: **2 raw
occurrences of each canary** in the session file, `api-request-blob(role=system)`
at line 21, with `tools/verify-transcript.mjs` exiting non-zero on two
`FAIL GUARANTEE VIOLATED` lines. `prompt.attachment` never fired; the platform
reported the hook skipped because the outer policy plugin runs first. This is a
model-facing guarantee violation, not a transcript residual like §12, and it is
not fixable from inside the mod. On a deployment where the hook fires, the same
`e.text` path above would scan the content; that is the code, not a measurement.
Captures: `reports/evidence/05/attachment-probe.txt` and session
`219934f7-2129-4185-a6f5-973a584cfc47.jsonl`.

## 15. Bare `*` and `+` are unbounded too

The generator's rewriter only capped `.*`, `.+` and `{n,}`, and the gate only
looked for those three shapes. Ten rules kept bare `*`/`+` tails —
`slack-bot-token`'s `[a-zA-Z0-9-]*`, `slack-legacy-token`'s four `+`s,
`microsoft-teams-webhook`, `yandex-access-token`, both `curl-*` rules,
`freemius-secret-key`, `kubernetes-secret-yaml`, `nuget-config-password` — while
the gate printed "every rule has bounded repetition".

Both sides now walk the pattern properly: escapes are literals, a `*` inside
`[...]` is a character, and a `]` right after `[` or `[^` is a member rather than
the close. `{1,4096}`/`{0,4096}` replace bare `+`/`*`. The scanner lives once, in
`hooks/quantifiers.ts`, so the gate and the tests cannot drift apart, and the gate
self-checks eight shapes including the literals it must *not* flag. The old test
assertion `includes(".+")` was itself wrong — it fired on `[\w=~@.+/-]`, where
`.+` are two literals.

## 16. Over the hit ceiling means withheld, not half-scrubbed

`MAX_HITS` capped a row at 512 placeholders and then `break`-ed: a row with 600
secrets returned 512 placeholders and 88 raw values, reported as success. That is
the worst possible outcome for a redactor — a partial scrub that reads as a
complete one. Exceeding the cap now throws, so the caller's existing fail-closed
path withholds the row. A withheld row is visible and recoverable; a half-scrubbed
row is neither. Tested with a 600-candidate row.

## 17. base32 TOTP needs both halves

A TOTP seed has no vendor prefix, so charset alone is not proof: sixteen uppercase
base32 characters are more likely to be an identifier than an HMAC key. The
validator requires both (a) a decodable base32 body whose length lands in a
plausible HMAC key size (10–64 bytes) and (b) an OTP word within a small window
(`totp`, `otp`, `2fa`, `authenticator`, `otpauth`, …). Neither half alone fires.
Tested three ways: the otpauth URI is redacted, the same base32 run without an OTP
word is left alone, and an 8-character run (5 decoded bytes) is refused.

## 18. L3 must remove rules, not only add them

The override surface had one half. Adding was possible through
`.claude/prompt-redact.rules`; nothing could switch a *shipped* rule off, so a
person who found one rule noisy had no recourse but to disable the whole mod.
That is not an override, it is a binary.

Now: `userConfig.disabledRules` (comma-separated ids, settable from `/config`),
session state `disabled`, and `/redact rule off|on|list`. The engine skips a
disabled id in the rule loop, whichever family it belongs to, and the same
mechanism switches off the L2 stage by the id `local-classifier`. Ids are
validated against the corpus before writing, so a typo reports `no such rule`
instead of silently disabling nothing. Disabling is per-session, like every other
override, so it cannot quietly persist into next week's work.

Disabling one rule does not blind the mod: other families still see the value. The
test asserts the *label* stops appearing rather than that the text is untouched,
because for a vendor token the generic family may legitimately still catch it.

## 19. `minEntropy` had to reach the rule it names

`plugin.json` described `minEntropy` as the floor "for the generic keyword=value
detector", but `scrub.ts` used `c.rule.entropy ?? opts.minEntropy` — and the
shipped generic rule carries `entropy: 3.5` upstream, so the field was never
consulted for the one detector it claims to configure. Setting it to 2.0 or 4.0
changed nothing; a decorative setting.

Now the generic family uses `Math.max(rule.entropy, minEntropy)`. Raising it
tightens the rule, lowering it cannot weaken a rule's own upstream guarantee — the
honest reading of "floor". Verified with a 3.66-bit value (`byh0vmpo7yt8r6`):
redacted at 3.2, not at 4.0. Specific vendor rules keep their upstream entropy
only, so a broad setting never loosens a precise rule.

---

## Rule-provenance and licence

`vendor/gitleaks.toml` is MIT (Copyright (c) 2019 Zachary Rice), vendored at
sha256 `e163e53b9e7e8a8511e77271e2b323ed057759542a6d988258afe3a1fa329caf`.
Every generated rule carries its upstream id and an anchored source URL, checked
by `tools/check-rules.mjs` against `RULES.md`.
