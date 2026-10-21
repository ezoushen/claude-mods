# prompt-redact

Puts a placeholder where a secret used to be — before the model or the session
file sees it — and puts the real value back only where the disk demands it.

Requires Claude Code ≥ 2.1.287. No network, no subprocess, no model call: a
detector that transmits the value it is hiding would defeat itself, so a scan
that needs egress is not a scan this mod runs.

```sh
claude plugin marketplace add ezoushen/claude-mods
claude plugin install prompt-redact@claude-mods
```

Or try it for one session without installing: `claude --plugin-dir ./prompt-redact`.

## What it does

- **Prompts** — a typed secret becomes `[REDACTED:LABEL#hash]` before the prompt
  is queued. The transcript and prompt history show the placeholder.
- **Tool output** — file reads, shell output and MCP results are rewritten before
  the model reads them. A `cat` of a file holding a key hands the model a
  placeholder.
- **Reply rows and stored rows** — `session.append` rewrites a stored row before
  both the model and the transcript see it, which closes the echo-back leak where
  the model restates a secret. **Caveat:** an organization account seats the
  builtin `cc-plugin-sec-default` outermost. That guard forwards *past* the user
  tier (`next.to(e, "append")`) for the rows the engine injects itself — the
  `attachment`, `hook-context`, `compaction` and skill `tool-message` doors, plus
  an organization plugin's own notes — so those four are not reached at user
  tier. Ordinary prompt, reply and tool-result rows are reached: the guard does
  not skip those doors. Two carriers have no hook at all, at any tier:
  `prompt.context` (where managed CLAUDE.md most likely travels) and
  `skill.prompt`. An `@`-mentioned file is not a stored row; it travels on the
  next carrier.
- **Injected context** — `prompt.attachment` scrubs text another settings hook
  injects into the request (SessionStart/UserPromptSubmit additional context),
  which `session.append` never sees because it is not a stored row. A file
  referenced with `@` also travels through this carrier. **On an organization
  account this hook is skipped, and the file's content reaches the model
  unredacted — a measured leak, quantified under Known limitation.**
- **Edits** — the real value is restored *only* inside `Edit`, `Write` and
  `NotebookEdit` arguments, so an edit to a line holding a real key still matches
  the file on disk. `Bash` never receives a real value.

A one-line band above the prompt shows what it has hidden, by label and count —
never a value.

## Detection

Five layers, auto-selected per machine and per row:

1. **Structural** — PEM private keys (linear scan, whole block), JWTs (header
   decoded to JSON with an `alg`), IBAN mod-97, Luhn card numbers, SSA numbers
   under the issuance rules. These carry their own proof, so they need no entropy
   gate or context.
2. **Rule corpus** — 220 rules generated from gitleaks (MIT): 95 prefix-anchored,
   123 vendor-keyword, 2 generic. Every rule carries a provenance URL, checked by
   `tools/check-rules.mjs`.
3. **Generic** — the corrected `keyword = value` shape, with a tolerant prefix, a
   quote tolerated before the separator, and a low length floor.
4. **Context score** — for the generic family only, weighted by nearby
   deployment vocabulary and by value shape.
5. **Local rules** — an optional `.claude/prompt-redact.rules` (one
   `LABEL <javascript-regex>` per line) is probed at session start and merged.
   A session that only has the built-in corpus starts silently; the readiness
   line appears when local rules or the optional classifier are loaded, and
   `/redact` answers on demand.

**Allowlisted** (left untouched, because redacting them breaks the task): git and
content hashes, UUID/ULID/ObjectId, lockfile integrity, bcrypt, SSH *public*
keys, `data:` URIs, SRI, ARNs, account ids, IPs, emails, timestamps, versions,
and the placeholder lexicon (`changeme`, `${ENV}`, `<your-key>`, …).

**Fail closed:** a row whose scan throws or overruns its budget is withheld
(`[redact withheld this content: the redactor failed while scanning it]`); a prompt that cannot be scanned is
dropped rather than sent.

## Commands

```text
/redact            counts by label, restore count, vault size
/redact on|off     enable or disable scanning for this session
/redact tier strict|balanced|precision
/redact allow <re> never redact values matching <re>
/redact deny <re>  always redact values matching <re>
/redact why        how detection works, and this session's posture
```

`strict` redacts anything suspicious, `balanced` is the default, `precision`
only clear-cut secrets. Rules can be added (`.claude/prompt-redact.rules`, one `LABEL <regex>` per line)
and **removed**: `userConfig.disabledRules` or `/redact rule off <id>` switches a
shipped rule off for the session, `/redact rule on <id>` puts it back, and
`/redact rule list` shows what is off. `/redact` is also where `on|off`, `tier`,
`allow`, `deny` and `why` live.

Configuration also lives in the plugin's `userConfig`
(`enabled`, `tier`, `minEntropy`, `scanBudgetMs`), so `/config` can set it.

## Using a credential

Everything above keeps the model from holding a real value — which also means
the model cannot hand one to a command. A credential reaches the shell on one
of three paths, each measured on a live Haiku session with the plugin loaded
from source and a synthetic 35-character canary (never a real key). The
placeholder that would stand in for it, `[REDACTED:…#…]`, is 43 characters, so
a command printing **35** proves the shell held the real value — the
placeholder is not 35 characters long.

**1. Export before launch.** `Bash` inherits the launching shell's
environment. With `E2E_ENV_CANARY` exported before Claude Code starts, the
model was asked to run `printf %s "$E2E_ENV_CANARY" | wc -c`; it printed
**35**, the real value's length. The model sees the variable's *name*, runs
the command, and reports a number: the value never enters its context, so
there is nothing to redact in this path. `grep -c` on the session file
returned 0, and `tools/verify-transcript.mjs` reported 0 model-facing, 0
tool-result, 0 residual occurrences.

**2. The `!` prefix.** A command typed with `!` runs in the same shell.
`!printf %s "$E2E_ENV_CANARY" | wc -c` printed **35** in the same measured
session, and the transcript check held: 0 model-facing, 0 tool-result, 0
residual. The stored row shows only the command line and its status line.

**3. Through a file an edit tool writes.** Type or paste the secret once —
prompt redaction turns it into `[REDACTED:LABEL#hash]` across the prompt and
the transcript. Then have Claude write the file you actually need:

```text
> create env.sh with the line STRIPE_KEY=<the redacted placeholder>
```

The `Write` call carries the placeholder — the measured session's tool
argument read `STRIPE_KEY=[REDACTED:GENERIC_API_KEY#6997db91011b1685]` — and
rehydration swaps it for the real value in the file on disk, the one channel
`Edit`, `Write` and `NotebookEdit` get (see the *Edits* bullet above). The
shell then picks it up:

```sh
set -a; . ./env.sh; set +a        # export all; source; stop exporting
printf %s "$STRIPE_KEY" | wc -c   # → 35
```

The transcript check passed with 0 model-facing, 0 tool-result, 0 residual
occurrences, and the transcript carried the two placeholders for the redacted
values rather than either raw value.

Three things these paths do **not** permit:

- **`Bash` never receives a real value.** Rehydration is scoped to `Edit`,
  `Write` and `NotebookEdit` (`DECISIONS.md` §8, which is what keeps a
  restored placeholder from becoming an exfiltration primitive). A literal
  secret typed into a `Bash` command becomes a placeholder before the shell
  sees it, so an inline `curl -H "Authorization: Bearer …"` with the secret
  cannot work — the command would carry the placeholder. That call is now
  refused outright rather than run as a silent no-op (see *Teaching the model
  what a placeholder means*).
- **A credential that exists only in prompt text cannot be used by `Bash` at
  all.** It must live in the environment before launch (path 1) or be
  materialised on disk (path 3). Handing the value to Claude in prose buys
  you neither.
- **The file path 3 creates holds the real value in plaintext at rest.** The
  redactor protects the transcript and the model, never the disk. `Write` is
  the channel that materialises it, so treat the result as a secret file:
  `chmod 600 env.sh`, list it in the repository's `.gitignore` before the
  write, and delete it when the task is done.

Captures: paths 1 and 2 in `reports/evidence/06-operator-capture.txt` and
session `435fbaf4-ee44-45a4-b723-9556a00f5077.jsonl`; path 3 in session
`abb84738-c36b-4c70-bcc3-86bf25c64e7f.jsonl`.

## Teaching the model what a placeholder means

A placeholder is opaque, and the model has to know both what it is and what it
cannot do with it. Three layers, weakest to strongest:

1. **A skill** — `skills/redacted-values/SKILL.md`, also runnable as
   `/prompt-redact:redacted-values`. It sorts the three origins (the user's own
   message, tool output, the model's own reply) and states the correct move for
   each. Advisory by nature: Claude invokes it when the description matches, and
   can miss the turn it matters.
2. **A standing notice** — `prompt.compose` / `prompt.section` append the opaque
   description to the system prompt, so the model is told on every turn what the
   placeholders are, whichever of the two hooks the engine reaches.
3. **Two deterministic hooks** — these do not depend on the model reading
   anything:
   - On the turn a secret is redacted out of the **user's** message, the injected
     context says so, tells the model to stop rather than work around it, forbids
     asking the user to paste the value, and gives the route that works
     (`set -a; . ./.env; set +a`, or reference by variable name).
   - `tool.call` **refuses** a `Bash`, `WebFetch` or `WebSearch` call whose
     arguments carry a placeholder. Those tools are deliberately never
     rehydrated, so without this a command would run with `[REDACTED:…#…]` as
     literal text and report success. The refusal names the file-loading route.

The honest split: "stop and tell the user" cannot be forced as prose — a hook
cannot dictate the model's words. What *can* be forced is the refusal, and a
refusal with the instruction attached leaves the model no way to continue
without surfacing it to the user.

## Troubleshooting: "its session.append hook was skipped"

On a machine with managed settings, `cc-plugin-sec-default` forwards some events
past the user tier and Claude Code prints one line per event and kind. That line
names the event, not the door, so it reads as if the whole hook were dead.

**Cause: Claude Code's own injected rows, not another plugin.** Measured with
claude-mem disabled entirely: the line still appeared, with 2 bypassed
`session.append` runs. The engine emits `environment`, `model`, `skill_listing`,
`date`, `instructions` and `session_context` attachments at startup, and every one
takes the `attachment` door the guard forwards. claude-mem's `SessionStart`
context adds more of the same (upstream issue #1269 calls them
`saved_hook_context`).

**Since 0.3.2 this plugin no longer registers those doors.** `session.append` is
matched only for the doors a user-tier mod can actually read — `prompt`,
`command`, `response`, `tool-result`, `delivery`, `notice`, `queue` — so the
engine has no skipped hook of this plugin's to report. The injected doors were
never readable at this tier, so no carrier is lost. A deployment seated above the
guard still reads them, and the injected-door code paths remain for that case.

`/redact why` shows what did arrive. Measured on a quiet session before 0.3.2:
21 `session.append` runs reached the mod while 2–9 injected runs were bypassed;
`prompt.submit` fired normally.

`prompt.context` (managed CLAUDE.md) and `skill.prompt` have no hook at all, at
any tier, so those carriers remain uncovered regardless of seating.

## Known limitation

Measured on a live Haiku session with `tools/verify-transcript.mjs`, plugin
loaded from source, memory plugin excluded so no third party pre-injected text.
The session exercised the typed-prompt and tool-result carriers, not an
`@`-mentioned file (see item 1 below):

```text
model-facing canary occurrences: 0
toolUseResult canary occurrences: 0
RESIDUAL (not hook-reachable): 0
rehydration: saved3.txt holds the real value
```

`grep -c '<canary>' <session>.jsonl` returns 0 for both canaries. The model never
saw a real value, no tool sidecar kept one, and the file on disk still got the
real key because rehydration fired.

Two things that number does **not** claim:

1. **Hook reach depends on deployment.** On an organization account the builtin
   `cc-plugin-sec-default` seats outermost and forwards past the user tier on
   this mod's `prompt.section`, `prompt.compose`, `prompt.attachment` hooks and
   on the engine-injected `session.append` doors ("runs first and sent the event
   on past it"). Prompt, reply and tool-result rows still reach `session.append`;
   typed prompts and tool results stay covered by `prompt.submit` and
   `tool.call`.

   Registering this plugin org-wide from a GitHub marketplace (for example
   `extraKnownMarketplaces` + `enabledPlugins` in managed settings) makes it
   available to every member, but it does **not** change the seating: a plugin
   Claude Code copies into its cache counts as the person's, even when managed
   settings enable it. To seat it ahead of the guard, an administrator needs all
   of: a marketplace declared with a **directory** source on each machine,
   managed `enabledPlugins`, and `prependPlugins` listing this plugin **before**
   `sec-default@builtin` (the list replaces the default seating, so the guard
   must be named). The remote payload also needs `managedSourcesBehavior:
   "merge"`, or a local `managed-settings.json` is ignored under first-wins.

   For the attachment carrier this is not a theoretical caveat. Measured on this
   account (organization OAuth, live Haiku session, policy plugin outermost): a
   file holding two synthetic canaries was referenced from the prompt as an
   `@`-mention, and both canaries reached model-facing content **unredacted** —
   **2 raw occurrences of each canary** in the session file,
   `api-request-blob(role=system)` at line 21. `tools/verify-transcript.mjs`
   exited non-zero:

   ```text
   FAIL GUARANTEE VIOLATED: canary appears in model-facing content x1 — line 21 (api-request-blob(role=system))
   FAIL GUARANTEE VIOLATED: canary appears in model-facing content x1 — line 21 (api-request-blob(role=system))
   2 verification failure(s)
   ```

   `prompt.attachment` never fired for the event, and the platform reported at
   session start that its `prompt.attachment` hook was skipped because
   `cc-plugin-sec-default` runs first. So **attachments are not safe to use with
   this mod on this deployment**: `@`-mentioning a file hands its contents to the
   model unscrubbed. This cannot be fixed from inside the mod — a skipped hook
   cannot be made to fire from here. On an account where the hook does fire the
   same content would be scanned by the same detectors, but that path is not what
   this account measured. Captures:
   `reports/evidence/05/attachment-probe.txt` and session
   `219934f7-2129-4185-a6f5-973a584cfc47.jsonl`.
2. **Prose passwords remain a gap.** Measured recall on the synthetic fixture set
   is 0% at L1 and 40% with a local classifier (`tools/measure-recall.mjs`). A
   bare 8-character alphabetic password with no keyword anchor has nothing for a
   rule to grip. The local classifier closes the shapeless-token tier (0% → 100%)
   but not this one, and it ships without weights: training needs data that
   leaves the machine, which this mod forbids.

## Development

```sh
node tools/check-rules.mjs          # corpus integrity: provenance, compile, bounded
claude plugin validate ./prompt-redact
claude plugin test ./prompt-redact  # 80 tests
python3 tools/gen-rules.py          # regenerate rules + RULES.md
```

Research record: `../research/prompt-redaction.md`.
