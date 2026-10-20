---
name: redacted-values
description: Work correctly when a credential appears as a [REDACTED:<LABEL>#<hash>] placeholder. Use when a prompt, tool result, file, or your own reply contains a prompt-redact placeholder, when a Bash/WebFetch call was refused for carrying one, or when the user asks about a hidden credential value.
---

# Working with redacted values

`prompt-redact` replaces secrets with placeholders **before they reach you**. The shape is
`[REDACTED:<LABEL>#<hash>]`, for example `[REDACTED:GENERIC_API_KEY#951155cccace832e]`. The
hash is salted per session: the same secret always yields the same placeholder in this
session, and a different session always yields a different one.

You are looking at an opaque identifier. You cannot read, decode or recover it, and **nothing
you do makes it become the value**. Treat it as a name for the secret, never as its content.

## Decide by where the placeholder came from

### 1. It came from the user's own message

Stop. Do not work around it.

- Do not guess, mutate, brute-force or reconstruct the value, and do not ask the user to paste
  it into the chat — pasting is what created the placeholder.
- Tell the user plainly: their message contained a credential, and it was replaced before it
  reached you, so you cannot see it.
- Give them the route that works: keep the value in a file (for example `.env`) and have the
  shell load it — `set -a; . ./.env; set +a` — then refer to it by variable name. Or point you
  at the file that already holds it.
- Only if they want the value *written* somewhere, ask them to confirm, then copy the
  placeholder **verbatim** into an `Edit`/`Write`/`NotebookEdit` argument: prompt-redact
  restores the real value on the way to disk.

### 2. It came from tool output or a file (Read, Grep, Bash, MCP)

The file on disk really contains the secret; you were shown a placeholder instead.

- Keep the placeholder byte-for-byte when editing that line. `Edit`, `Write` and
  `NotebookEdit` arguments are rehydrated, so the edit still matches disk. If you retype a
  guessed value there, you overwrite the real secret with a wrong one.
- `Bash`, `WebFetch` and `WebSearch` are **never** rehydrated: a placeholder in their
  arguments is literal text. Use the file-loading route instead — `set -a; . ./.env; set +a`
  then `$NAME` — or reference a config path that reads the value itself.
- If one of those calls was refused for carrying a placeholder, do not retry the same call.
  Follow the refusal: it never ran, and retrying only repeats the mistake.

### 3. It is in your own reply

Do not restate a secret, and do not write a placeholder where a reader expects real prose —
say "the value in `.env` as `$API_KEY`" instead. Referencing is fine; rendering is not.

## Never

- Ask the user to paste the secret "so you can see it", or suggest disabling redaction to
  get around it.
- Guess from the label: `GENERIC_API_KEY` does not narrow a value.
- Send a placeholder to a network tool, a shell command, or a file you then serve.
- Claim a secret is "restored" — you never observe that; the runtime does it silently on
  write paths only.

## What works, in one line

Name the value, do not carry it: put it in a file, load it where it is needed
(`set -a; . ./.env; set +a`), and let the runtime restore it only on the three write-path
tools.
