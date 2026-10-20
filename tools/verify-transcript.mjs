#!/usr/bin/env node
// Verify a Claude Code session transcript against prompt-redact's real guarantee.
//
//   node tools/verify-transcript.mjs <session.jsonl> \
//        --canary <value> [--canary <value> ...] \
//        --file <path-on-disk> --file-has <value>
//
// The guarantee this checks, and the one it deliberately does NOT claim:
//
//   GUARANTEED -- a canary never appears in a row the model reads. That is
//   `message.content` on user/assistant/attachment rows, including the text of
//   a tool_result block, plus the `toolUseResult` sidecar the engine keeps beside
//   the row. Redacting the tool result at `tool.call` is what keeps the sidecar
//   clean, because the engine records a hook's returned result as the tool's.
//
//   NOT GUARANTEED, measured instead -- a settings hook's own execution record
//   (`attachment` rows of type `hook_success`: its stdout/stderr) keeps what the
//   hook printed, because that row has no `message` field for `session.append`
//   to rewrite. The context it injected into the request IS scrubbed, at
//   `prompt.attachment`. The other row kind was,
//   so `session.append` cannot rewrite them: `attachment` rows of type
//   `hook_success` (a settings hook's stdout/stderr/content, stored verbatim) and
//   `api-request-blob` rows (recorded request bodies). They are reported as
//   RESIDUAL and do not fail the run; see DECISIONS.md §12.

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith("--") && !isFlagValue(argv, a));
const canaries = collectFlag(argv, "--canary");
const filePath = firstFlag(argv, "--file");
const fileHas = firstFlag(argv, "--file-has");

function isFlagValue(all, candidate) {
  const idx = all.indexOf(candidate);
  return idx > 0 && ["--canary", "--file", "--file-has", "--jsonl"].includes(all[idx - 1]);
}

function collectFlag(all, name) {
  const out = [];
  for (let i = 0; i < all.length; i++) if (all[i] === name && all[i + 1] !== undefined) out.push(all[i + 1]);
  return out;
}

function firstFlag(all, name) {
  const values = collectFlag(all, name);
  return values.length > 0 ? values[0] : undefined;
}

const transcript = firstFlag(argv, "--jsonl") ?? positional[0];
if (!transcript) {
  console.error("usage: node tools/verify-transcript.mjs <session.jsonl> --canary <v> [--file <p> --file-has <v>]");
  process.exit(2);
}
if (canaries.length === 0) {
  console.error("at least one --canary <value> is required");
  process.exit(2);
}

let lines;
try {
  lines = readFileSync(resolve(transcript), "utf8").split("\n").filter((l) => l.trim() !== "");
} catch (error) {
  console.error(`cannot read transcript: ${error.message}`);
  process.exit(2);
}

const countIn = (haystack, needle) => {
  let n = 0;
  let i = 0;
  for (;;) {
    const at = haystack.indexOf(needle, i);
    if (at === -1) return n;
    n += 1;
    i = at + needle.length;
  }
};

const modelFacing = [];
const toolSidecar = [];
const residual = { "hook_success attachment": [] };
const rows = { total: lines.length, modelFacing: 0, toolUseResult: 0, residual: 0 };
const placeholders = new Map();

const PLACEHOLDER = /\[REDACTED:[A-Z0-9_]+#[0-9a-f]{16}\]/g;

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (typeof block.text === "string") parts.push(block.text);
    if (block.type === "tool_result") {
      if (typeof block.content === "string") parts.push(block.content);
      else if (Array.isArray(block.content)) {
        for (const nested of block.content) {
          if (nested && typeof nested === "object" && typeof nested.text === "string") parts.push(nested.text);
        }
      }
    }
  }
  return parts.join("\n");
}

for (const [index, line] of lines.entries()) {
  let row;
  try {
    row = JSON.parse(line);
  } catch {
    continue;
  }
  const type = row.type;
  const content = row.message && typeof row.message === "object" ? row.message.content : undefined;

  // A recorded request blob is not a conversation row, but it is the request the
  // model actually received -- literally the bytes sent. Excluding it from
  // "model-facing" was how an earlier version of this script reported 0 while
  // three `role: system` bodies carried the raw canary in their additional
  // context. Anything the model read counts, however it was stored.
  if (type === "api-request-blob") {
    rows.modelFacing += 1;
    rows.residual += 1;
    const role = row.message && typeof row.message === "object" ? row.message.role : "?";
    modelFacing.push({ index: index + 1, type: `${type}(role=${role})`, text: JSON.stringify(row.message ?? {}) });
  } else if (["user", "assistant", "attachment", "system"].includes(type) && content !== undefined) {
    rows.modelFacing += 1;
    modelFacing.push({ index: index + 1, type, text: textFromContent(content) });
  }

  // An attachment row keeps its own fields beside (or instead of) `message`.
  // `text` and `rendered` are what the engine shows for the attachment; the
  // stdout/stderr of a settings hook are that hook's own record, which reaches
  // the model only through `prompt.attachment` -- where the mod scrubs it -- so
  // they are measured as residual, not asserted clean here.
  if (type === "attachment") {
    const attachment = row.attachment;
    if (attachment && typeof attachment === "object") {
      const shown = [];
      for (const key of ["text", "rendered", "content"]) {
        if (typeof attachment[key] === "string") shown.push(attachment[key]);
      }
      const hookRecord = attachment.type === "hook_success";
      if (hookRecord) {
        const recorded = [];
        for (const key of ["stdout", "stderr", "content"]) {
          if (typeof attachment[key] === "string") recorded.push(attachment[key]);
        }
        if (recorded.length > 0) {
          rows.residual += 1;
          residual["hook_success attachment"].push({ index: index + 1, type, text: recorded.join("\n") });
        }
      } else if (shown.length > 0) {
        rows.modelFacing += 1;
        modelFacing.push({ index: index + 1, type: `attachment(${attachment.type ?? "?"})`, text: shown.join("\n") });
      }
    }
  }

  // The sidecar the engine stores beside the row.
  if (row.toolUseResult !== undefined) {
    rows.toolUseResult += 1;
    toolSidecar.push({ index: index + 1, type, text: JSON.stringify(row.toolUseResult) });
  }

  for (const match of JSON.stringify(row).match(PLACEHOLDER) ?? []) {
    placeholders.set(match, (placeholders.get(match) ?? 0) + 1);
  }
}

function tally(bucket) {
  const per = new Map();
  for (const canary of canaries) {
    let total = 0;
    const hits = [];
    for (const row of bucket) {
      const n = countIn(row.text, canary);
      if (n > 0) {
        total += n;
        hits.push(`line ${row.index} (${row.type}) x${n}`);
      }
    }
    per.set(canary, { total, hits });
  }
  return per;
}

const failures = [];
const report = [];

report.push(`transcript: ${transcript}`);
report.push(`rows: ${rows.total} total — ${rows.modelFacing} with content, ${rows.toolUseResult} with toolUseResult, ${rows.residual} residual`);

const modelTally = tally(modelFacing);
const sidecarTally = tally(toolSidecar);
const residualTally = tally(Object.values(residual).flat());

for (const [canary, { total, hits }] of modelTally) {
  if (total > 0) failures.push(`GUARANTEE VIOLATED: canary appears in model-facing content x${total} — ${hits.join(", ")}`);
}
for (const [canary, { total, hits }] of sidecarTally) {
  if (total > 0) failures.push(`GUARANTEE VIOLATED: canary appears in toolUseResult sidecar x${total} — ${hits.join(", ")}`);
}

report.push(`model-facing canary occurrences: ${[...modelTally.values()].reduce((n, v) => n + v.total, 0)} (must be 0)`);
report.push(`toolUseResult canary occurrences: ${[...sidecarTally.values()].reduce((n, v) => n + v.total, 0)} (must be 0)`);
report.push(`RESIDUAL (not hook-reachable, documented): ${[...residualTally.values()].reduce((n, v) => n + v.total, 0)}`);

for (const [bucket, list] of Object.entries(residual)) {
  if (list.length === 0) continue;
  const n = [...canaries].reduce((sum, canary) => sum + countIn(list.map((r) => r.text).join(""), canary), 0);
  report.push(`  ${bucket}: ${n} canary occurrence(s) across ${list.length} row(s)`);
}

report.push(`distinct placeholders present: ${placeholders.size}`);
for (const [placeholder, count] of [...placeholders.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  report.push(`  ${placeholder} x${count}`);
}

if (filePath) {
  if (!existsSync(resolve(filePath))) {
    failures.push(`file on disk missing: ${filePath}`);
  } else {
    const body = readFileSync(resolve(filePath), "utf8");
    if (fileHas && !body.includes(fileHas)) {
      failures.push(`rehydration failed: ${filePath} does not contain the real canary`);
    } else {
      report.push(`rehydration: ${filePath} holds the real value (${body.length} bytes)`);
    }
  }
}

for (const line of report) console.log(line);

if (failures.length > 0) {
  console.error("");
  for (const failure of failures) console.error(`FAIL ${failure}`);
  console.error(`\n${failures.length} verification failure(s).`);
  process.exit(1);
}
console.log("\nverified: the model never read a canary, and no sidecar kept one.");
