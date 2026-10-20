// prompt-redact: put a placeholder where a secret used to be, before the model
// and the session file ever see it, and put the real value back only where the
// disk demands it.
//
// Design constraints that shaped every line below:
//
//   * Reach L0. No network call, no subprocess, no model call -- the static
//     posture check greps for exactly those. A detector that transmits the value
//     it is trying to hide would defeat itself. The one capability probed is
//     filesystem access, for an optional local rules file.
//   * Fail closed. A row that throws or overruns its budget is withheld, never
//     stored raw.
//   * Rehydrate narrowly. Only `Edit`/`Write`/`NotebookEdit` get real values
//     back. `Bash` never does: otherwise any command the model writes becomes an
//     exfiltration primitive and the placeholder resolves on the way out.
//   * Deterministic placeholders, so an edit to a line holding a real key still
//     matches the file on disk.
//   * The vault lives in `$.state` only: session-scoped, survives a hot reload,
//     gone at exit, never written to disk or `$.store`.
//
// The state accessors below are written out one per key on purpose. The engine
// requires every `$.state.get`/`$.state.set` reference to name its plugin and key
// as string literals written at the call site, so the full state surface can be
// listed from the compiled module. A generic `read($, key)` helper would hide it.

import {
  asRehydratable,
  detectorsFor,
  placeholderCount,
  placeholdersIn,
  rehydrate,
  scrub,
  scrubMessage,
  type Rehydratable,
  type ScrubHit,
  type ScrubOptions,
  type Tier,
} from "./scrub.ts";
import { parseClassifier, type ClassifierModel } from "./classifier.ts";
import { RULES } from "./rules.ts";

const WITHHELD =
  "[redact withheld this content: the redactor failed while scanning it]";

/** Fields a rewrite must not touch; the engine refuses them anyway. */
const RESERVED = new Set(["tool", "tool_use_id", "agentId"]);

/** Tools whose arguments may receive a real value back. */
const REHYDRATE_TOOLS = ["Edit", "Write", "NotebookEdit"] as const;

/**
 * Tools that must never carry a placeholder onward. Rehydration is deliberately
 * absent here, so a placeholder that reached one of these would run or travel as
 * literal text: the command "succeeds" while doing nothing, which is worse than
 * refusing. A refusal can carry the route that works; a silent no-op cannot.
 */
const GUARDED_TOOLS = ["Bash", "WebFetch", "WebSearch"] as const;

const OPAQUE_NOTICE =
  "\n\nSome values in this conversation appear as `[REDACTED:<LABEL>#<hash>]`. " +
  "They are opaque placeholders the session minted for credentials, API keys and " +
  "private keys that never left this machine. Treat them as opaque identifiers: " +
  "you may reference them, and copy them into `Edit`/`Write`/`NotebookEdit` " +
  "arguments (the real value is restored there, so an edit to a line holding a key " +
  "still matches the file), but you cannot read or reveal their contents, and " +
  "asking the person to paste the real value would defeat the point. Do not guess " +
  "or reconstruct them. They are stable for the whole session.";

const LOCAL_RULES_PATHS = [".claude/prompt-redact.rules", ".prompt-redact.rules"];

/**
 * Where an L2 weights file may sit. Both are project-local: the model is read
 * with `$.fs` from the session's own directory, so nothing about the value being
 * judged ever leaves the machine.
 */
const MODEL_PATHS = [".claude/prompt-redact.model.json", ".prompt-redact.model.json"];

/** Re-probe interval for the optional model: a trainer can edit it mid-session. */
const MODEL_CACHE_MS = 30_000;

/** Section id the notice is appended under; a plugin's own ids are namespaced. */
const NOTICE_SECTION_ID = "prompt-redact:notice";

const TIERS: readonly Tier[] = ["strict", "balanced", "precision"];

/**
 * The interception surface, in the order `/redact why` lists it.
 *
 * `prompt.submit` and `tool.call` carry the typed prompt and the tool results on
 * every deployment. The other four are the prompt-content hooks a managed
 * account's builtin policy plugin can keep from ever reaching this mod: the
 * platform seats such a plugin outermost, and one run it answers itself means
 * this mod never sees that run. Whether that happened is written only by the
 * platform, outside this process (its skip notice reaches the transcript or the
 * debug log and no hook), so the report below can state exactly one thing:
 * how many runs of each hook arrived. It can never state that a carrier was
 * covered, because a skipped run is indistinguishable from no run.
 */
const INTERCEPTION_HOOKS = [
  "prompt.submit",
  "tool.call",
  "session.append",
  "prompt.attachment",
  "prompt.compose",
  "prompt.section",
] as const;
type InterceptionHook = (typeof INTERCEPTION_HOOKS)[number];

/**
 * Rule ids the engine honours that are not rows in the generated corpus:
 * `local-classifier` switches the optional L2 stage, the other three switch
 * detector families delivered alongside it. They are validated by the command
 * exactly like a corpus id, so a real id never reports "no such rule".
 */
const ENGINE_RULE_IDS = ["local-classifier", "url-userinfo", "basic-auth", "password-value"] as const;

// --- state surface, one literal reference per key ---------------------------

async function getSalt($: any): Promise<string | undefined> {
  try {
    const got = await $.state.get({ plugin: "prompt-redact", key: "salt" });
    return typeof got?.value === "string" ? got.value : undefined;
  } catch {
    return undefined;
  }
}
async function setSalt($: any, value: string): Promise<void> {
  try {
    await $.state.set({ plugin: "prompt-redact", key: "salt" }, value);
  } catch {
    /* a failed state write must never block the redaction itself */
  }
}

async function getVault($: any): Promise<Record<string, string>> {
  try {
    const got = await $.state.get({ plugin: "prompt-redact", key: "vault" });
    return got?.value && typeof got.value === "object" ? (got.value as Record<string, string>) : {};
  } catch {
    return {};
  }
}
async function setVault($: any, value: Record<string, string>): Promise<void> {
  try {
    await $.state.set({ plugin: "prompt-redact", key: "vault" }, value);
  } catch {
    /* best-effort */
  }
}

async function getCounts($: any): Promise<Record<string, number>> {
  try {
    const got = await $.state.get({ plugin: "prompt-redact", key: "counts" });
    return got?.value && typeof got.value === "object" ? (got.value as Record<string, number>) : {};
  } catch {
    return {};
  }
}
async function setCounts($: any, value: Record<string, number>): Promise<void> {
  try {
    await $.state.set({ plugin: "prompt-redact", key: "counts" }, value);
  } catch {
    /* best-effort */
  }
}

async function getRestored($: any): Promise<number> {
  try {
    const got = await $.state.get({ plugin: "prompt-redact", key: "restored" });
    return typeof got?.value === "number" ? got.value : 0;
  } catch {
    return 0;
  }
}
async function setRestored($: any, value: number): Promise<void> {
  try {
    await $.state.set({ plugin: "prompt-redact", key: "restored" }, value);
  } catch {
    /* best-effort */
  }
}

async function getEnabled($: any): Promise<boolean | undefined> {
  try {
    const got = await $.state.get({ plugin: "prompt-redact", key: "enabled" });
    return typeof got?.value === "boolean" ? got.value : undefined;
  } catch {
    return undefined;
  }
}
async function setEnabled($: any, value: boolean): Promise<void> {
  try {
    await $.state.set({ plugin: "prompt-redact", key: "enabled" }, value);
  } catch {
    /* best-effort */
  }
}

async function getTier($: any): Promise<Tier | undefined> {
  try {
    const got = await $.state.get({ plugin: "prompt-redact", key: "tier" });
    const value = got?.value;
    return TIERS.includes(value as Tier) ? (value as Tier) : undefined;
  } catch {
    return undefined;
  }
}
async function setTier($: any, value: Tier): Promise<void> {
  try {
    await $.state.set({ plugin: "prompt-redact", key: "tier" }, value);
  } catch {
    /* best-effort */
  }
}

async function getAllow($: any): Promise<string[]> {
  try {
    const got = await $.state.get({ plugin: "prompt-redact", key: "allow" });
    return Array.isArray(got?.value) ? (got.value as string[]) : [];
  } catch {
    return [];
  }
}
async function setAllow($: any, value: string[]): Promise<void> {
  try {
    await $.state.set({ plugin: "prompt-redact", key: "allow" }, value);
  } catch {
    /* best-effort */
  }
}

async function getDeny($: any): Promise<string[]> {
  try {
    const got = await $.state.get({ plugin: "prompt-redact", key: "deny" });
    return Array.isArray(got?.value) ? (got.value as string[]) : [];
  } catch {
    return [];
  }
}
async function setDeny($: any, value: string[]): Promise<void> {
  try {
    await $.state.set({ plugin: "prompt-redact", key: "deny" }, value);
  } catch {
    /* best-effort */
  }
}

/** Cached probe result; `null` model means L1 only. */
let modelCache: { at: number; model: ClassifierModel | null } | null = null;

async function getDisabled($: any): Promise<string[] | undefined> {
  try {
    const got = await $.state.get({ plugin: "prompt-redact", key: "disabled" });
    return Array.isArray(got?.value) ? (got.value as string[]) : undefined;
  } catch {
    return undefined;
  }
}
async function setDisabled($: any, value: string[]): Promise<void> {
  try {
    await $.state.set({ plugin: "prompt-redact", key: "disabled" }, value);
  } catch {
    /* best-effort */
  }
}

async function getFires($: any): Promise<Record<string, number>> {
  try {
    const got = await $.state.get({ plugin: "prompt-redact", key: "hookFires" });
    return got?.value && typeof got.value === "object" ? (got.value as Record<string, number>) : {};
  } catch {
    return {};
  }
}
async function setFires($: any, value: Record<string, number>): Promise<void> {
  try {
    await $.state.set({ plugin: "prompt-redact", key: "hookFires" }, value);
  } catch {
    /* best-effort */
  }
}

/**
 * How many runs of each interception hook reached this code. This is the only
 * in-process evidence there is: an engine-skipped run never enters a hook, and
 * the platform's skip notice is written outside this process, where no hook
 * can read it.
 *
 * One read plus one write per delivered run. `session.append` runs on every
 * stored row but already reads several state keys per row, so this stays in the
 * cost class the hot path already pays.
 */
async function markObserved($: any, hook: InterceptionHook): Promise<void> {
  try {
    const fires = await getFires($);
    await setFires($, { ...fires, [hook]: (fires[hook] ?? 0) + 1 });
  } catch {
    /* a failed state write must never block the hook protecting the row */
  }
}

// --- helpers ----------------------------------------------------------------

/**
 * A per-session salt. A placeholder minted under one salt is meaningless under
 * another, so a placeholder copied in from a different session restores nothing.
 */
function newSalt(): string {
  let out = "";
  for (let i = 0; i < 4; i++) out += Math.random().toString(36).slice(2, 10);
  return `${out}${Date.now().toString(36)}`;
}

function compile(source: string): RegExp | null {
  try {
    return new RegExp(source, "i");
  } catch {
    return null;
  }
}

async function optionsFor(
  $: any,
  salt: string,
  tier: Tier,
  minEntropy: number,
  budgetMs: number,
  disabledRules: readonly string[],
): Promise<ScrubOptions> {
  return {
    salt,
    tier,
    minEntropy,
    extraRules: await localRules($),
    allowExtra: (await getAllow($)).map(compile).filter((r): r is RegExp => r !== null),
    deny: (await getDeny($)).map(compile).filter((r): r is RegExp => r !== null),
    budgetMs,
    classifier: await localClassifier($),
    disabledRules: (await getDisabled($)) ?? disabledRules,
  };
}

/**
 * Merge a local rules file when one exists. This is the capability probe: the
 * redactor adapts to what the machine already has, and degrades silently to the
 * built-in corpus when it has nothing. Format, one rule per line:
 *
 *   LABEL_NAME <javascript-regex>
 */
async function localRules($: any): Promise<ScrubOptions["extraRules"]> {
  for (const rel of LOCAL_RULES_PATHS) {
    try {
      if (!(await $.fs.exists(rel))) continue;
      const raw = await $.fs.read(rel);
      const text = typeof raw === "string" ? raw : String(raw ?? "");
      const rules = text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#"))
        .flatMap((line) => {
          const separator = line.indexOf(" ");
          if (separator < 1) return [];
          const label = line.slice(0, separator);
          const pattern = line.slice(separator + 1).trim();
          if (!pattern) return [];
          if (!compile(pattern)) return [];
          return [
            {
              id: `local:${label}`,
              label: label.toUpperCase().replace(/[^A-Z0-9]+/g, "_"),
              regex: pattern,
              flags: "i",
              groups: 0,
              secretGroup: null,
              entropy: null,
              keywords: [] as string[],
              allow: [] as string[],
              kind: "generic" as const,
              source: `local file ${rel}`,
            },
          ];
        });
      if (rules.length > 0) return rules;
    } catch {
      // Unreadable or unparseable rules file: fall back to the built-in corpus.
    }
  }
  return [];
}

/**
 * Probe for an optional L2 model and return it, or null.
 *
 * This is the ladder's capability probe for the prose/multilingual tier: the
 * model is a project-local weights file, evaluated in-process by classifier.ts.
 * Absent, unreadable or malformed, this returns null and the pipeline stays at
 * L1 -- silently, because a missing model is the normal case, not an error.
 */
async function localClassifier($: any): Promise<ClassifierModel | null> {
  const now = Date.now();
  if (modelCache && now - modelCache.at < MODEL_CACHE_MS) return modelCache.model;
  let model: ClassifierModel | null = null;
  for (const rel of MODEL_PATHS) {
    try {
      if (!(await $.fs.exists(rel))) continue;
      const raw = await $.fs.read(rel);
      const text = typeof raw === "string" ? raw : String(raw ?? "");
      const parsed = parseClassifier(text);
      if (parsed) {
        model = parsed;
        break;
      }
    } catch {
      // Unreadable weights are not a reason to stop redacting: stay at L1.
    }
  }
  modelCache = { at: now, model };
  return model;
}

function totals(hits: readonly ScrubHit[], counts: Record<string, number>): Record<string, number> {
  const next = { ...counts };
  for (const hit of hits) next[hit.label] = (next[hit.label] ?? 0) + 1;
  return next;
}

async function recordHits($: any, hits: readonly ScrubHit[]): Promise<void> {
  if (hits.length === 0) return;
  const vault = await getVault($);
  for (const hit of hits) vault[hit.placeholder] = hit.value;
  await setVault($, vault);
  await setCounts($, totals(hits, await getCounts($)));
}

function report(
  counts: Record<string, number>,
  restored: number,
  enabled: boolean,
  tier: Tier,
  vaultSize: number,
): string {
  const lines = [`prompt-redact — ${enabled ? "on" : "OFF"} (tier: ${tier})`];
  const labels = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (labels.length === 0) {
    lines.push("hid nothing yet this session.");
  } else {
    const total = labels.reduce((n, [, count]) => n + count, 0);
    lines.push(`hid ${total} value${total === 1 ? "" : "s"} this session:`);
    for (const [label, count] of labels) lines.push(`  ${label} x${count}`);
  }
  lines.push(`restored ${restored} placeholder${restored === 1 ? "" : "s"} into edit arguments.`);
  lines.push(`vault: ${vaultSize} value${vaultSize === 1 ? "" : "s"} in session state (never on disk).`);
  lines.push("Values are never shown here — only labels and counts.");
  return lines.join("\n");
}

/**
 * The interception posture: how many runs each hook delivered this session, and
 * which have never reached us. Names, counts and a fixed reason only — never a
 * value, a placeholder or a hash.
 *
 * The word "armed" is never printed. It is the word a live session contradicted:
 * counts say what ran here; they say nothing about runs the platform sent past
 * the mod, so presenting them as coverage would repeat exactly that lie.
 */
function interceptionPosture(fires: Readonly<Record<string, number>>): string[] {
  const known = INTERCEPTION_HOOKS.filter((hook) => typeof fires[hook] === "number" && fires[hook] > 0);
  const unseen = INTERCEPTION_HOOKS.filter((hook) => !(typeof fires[hook] === "number" && fires[hook] > 0));
  const lines = [`interception hooks: ${known.length} fired this session, ${unseen.length} not observed`];
  lines.push(
    `  fired this session: ${
      known.length === 0 ? "none" : known.map((hook) => `${hook} x${fires[hook]}`).join(", ")
    }`,
  );
  if (unseen.length > 0) {
    lines.push(
      `  not observed: ${unseen.join(", ")} (an outer policy plugin can keep an event from reaching this mod, or no such event has occurred yet — this mod cannot see which)`,
    );
  }
  lines.push(
    "  observed firing is not coverage: an outer policy plugin can send the event past any of these hooks without this mod seeing it, so the counts name only the runs that arrived",
  );
  return lines;
}

type Cfg = {
  readonly enabled: boolean;
  readonly tier: Tier;
  readonly minEntropy: number;
  /** Wall-clock ceiling for scanning one row; exceeding it fails closed. */
  readonly budgetMs: number;
  /** Rule ids off at session start, from the manifest's `disabledRules`. */
  readonly disabledRules: readonly string[];
};

async function posture($: any, cfg: Cfg): Promise<{ enabled: boolean; tier: Tier; salt: string }> {
  const salt = (await getSalt($)) ?? "";
  const enabled = (await getEnabled($)) ?? cfg.enabled;
  const tier = (await getTier($)) ?? cfg.tier;
  return { enabled, tier, salt };
}

async function initialized($: any, cfg: Cfg): Promise<void> {
  if (!(await getSalt($))) await setSalt($, newSalt());
  if ((await getEnabled($)) === undefined) await setEnabled($, cfg.enabled);
  if (!(await getTier($))) await setTier($, cfg.tier);
  await setVault($, await getVault($));
  await setCounts($, await getCounts($));
  await setRestored($, await getRestored($));
  await setAllow($, await getAllow($));
  await setDeny($, await getDeny($));
  if ((await getDisabled($)) === undefined) await setDisabled($, [...cfg.disabledRules]);
}

async function scrubText($: any, text: string, cfg: Cfg): Promise<{ enabled: boolean; text: string; hits: readonly ScrubHit[] }> {
  const { enabled, tier, salt } = await posture($, cfg);
  if (!enabled || !salt) return { enabled: false, text, hits: [] as const };
  const result = scrub(text, await optionsFor($, salt, tier, cfg.minEntropy, cfg.budgetMs, cfg.disabledRules));
  return { enabled: true, text: result.text, hits: result.hits };
}

export function register(on: any, options: Record<string, unknown>): void {
  const configuredEnabled = options.enabled !== false;
  const configuredTier = (TIERS.includes(options.tier as Tier) ? options.tier : "balanced") as Tier;
  const configuredEntropy = typeof options.minEntropy === "number" ? options.minEntropy : 3.2;
  const configuredBudget = typeof options.scanBudgetMs === "number" ? options.scanBudgetMs : 1500;
  // `disabledRules` arrives from the manifest as "a,b,c"; the live list is session
  // state, seeded from this once so `/redact rule on` can put a rule back.
  const configuredDisabled =
    typeof options.disabledRules === "string"
      ? options.disabledRules
          .split(",")
          .map((id) => id.trim())
          .filter((id) => id.length > 0)
      : [];

  // Helpers that take `$` are module-level declarations (the engine's static
  // analysis requires it), and `cfg` is passed explicitly rather than closed over.
  const cfg: Cfg = {
    enabled: configuredEnabled,
    tier: configuredTier,
    minEntropy: configuredEntropy,
    budgetMs: configuredBudget,
    disabledRules: configuredDisabled,
  };

  // --- session.start: initial readings, capability probe, command ------------
  on("session.start", async ($: any, e: any, next: (e: any) => unknown) => {
    // `next(e)` resolves to the session's `{ cwd }`, and this event's hook must
    // echo that shape back. Returning `undefined` made the engine log "returned
    // the wrong shape (no result)" and skip the answer in a live session.
    const answer = (await next(e)) as { cwd?: string } | undefined;
    try {
      await initialized($, cfg);
    } catch {
      // never fail a session start over state
    }

    let probed = "built-in 220-rule corpus";
    try {
      const found = await localRules($);
      if (found && found.length > 0) probed = `built-in corpus + ${found.length} local rule(s)`;
    } catch {
      probed = "built-in 220-rule corpus";
    }
    try {
      const model = await localClassifier($);
      if (model) probed += ` + L2 local classifier (threshold ${model.threshold})`;
    } catch {
      // the ladder simply stays at L1
    }

    try {
      await $.command.register({
        name: "redact",
        description: "Inspect and control prompt-redact: /redact [stats|on|off|tier|allow|deny|why|help]",
      });
    } catch {
      // a duplicate registration on hot reload is not fatal
    }
    try {
      $.ui.log(`prompt-redact ready — ${probed}`);
    } catch {
      // drawing is best-effort
    }
    return answer ?? { cwd: String(e.cwd ?? "") };
  });

  // --- prompt.submit: the typed prompt, before it is queued ------------------
  on("prompt.submit", async ($: any, e: any, next: (e: any) => unknown) => {
    await markObserved($, "prompt.submit");
    try {
      const result = await scrubText($, String(e.text ?? ""), cfg);
      if (!result.enabled || result.hits.length === 0) return next(e);
      await recordHits($, result.hits);
      const labels = result.hits.map((hit) => hit.label).join(", ");
      try {
        $.ui.log(`prompt-redact hid ${result.hits.length} value(s) in this prompt: ${labels}`);
      } catch {
        // best-effort
      }
      // Context has to ride on the way *down*: an entry added after `next` has
      // resolved is not attached, the prompt already entered. This is the one
      // delivery channel that cannot be short-circuited by another plugin, so
      // the model learns what it is looking at on the very turn it appears.
      const existing = Array.isArray(e.context) ? (e.context as readonly string[]) : [];
      const note =
        `prompt-redact hid ${result.hits.length} value(s) in this message (${labels}). ` +
        `They appear below as opaque [REDACTED:<LABEL>#<hash>] placeholders, and they came from the user's own ` +
        `message, so stop rather than work around them: do not guess, decode or reconstruct the value, and do not ` +
        `ask the user to paste it into the conversation. Tell them it was redacted before it reached you, then give ` +
        `them the route that works: keep the secret in a file (for example .env) and load it with ` +
        `\`set -a; . ./.env; set +a\`, or refer to it by variable name. Copy a placeholder verbatim into ` +
        `Edit/Write/NotebookEdit arguments only when the user wants the value written somewhere: prompt-redact ` +
        `restores the real value on the way to disk.`;
      return next({ ...e, text: result.text, context: [...existing, note] });
    } catch {
      // Fail closed. A dropped prompt is visible and recoverable; a leaked key is
      // neither, so an unscannable prompt must not be sent.
      try {
        $.ui.log("prompt-redact could not scan this prompt; it was withheld rather than sent unscanned.");
      } catch {
        // best-effort
      }
      return { drop: "prompt-redact withheld this prompt: the redactor failed while scanning it" };
    }
  });

  // --- session.append: every stored row -------------------------------------
  // Doors: prompt, command, response, tool-result, tool-message, delivery,
  // attachment, hook-context, note, compaction, notice. This is the one event
  // that sees a row before BOTH the model and the transcript file, so it closes
  // the echo-back leak where the model restates a secret in its reply.
  on("session.append", async ($: any, e: any, next: (e: any) => unknown) => {
    await markObserved($, "session.append");
    try {
      const { enabled, tier, salt } = await posture($, cfg);
      if (!enabled || !salt) return next(e);
      const result = scrubMessage(e.message, await optionsFor($, salt, tier, cfg.minEntropy, cfg.budgetMs, cfg.disabledRules));
      if (result.hits.length === 0) return next(e);
      await recordHits($, result.hits);
      return next({ ...e, message: result.message });
    } catch {
      // Fail closed on the row while keeping its shape: the model and the
      // transcript must never read this content raw.
      return next({ ...e, message: { ...e.message, content: [{ type: "text", text: WITHHELD }] } });
    }
  });

  // --- prompt.attachment: every message the engine injects on its own ------
  // This is the event that sees an injected message as a request is about to
  // carry it, and `e.text` is exactly "what the model reads".
  //
  // It matters because a settings hook's additional context arrives here with
  // `origin.kind === "hook"` (SessionStart, UserPromptSubmit, PostToolUse). A
  // live session showed that context carrying a raw canary straight into the
  // request body's system channel: `session.append` never sees it, because it is
  // not a conversation row, and no hook in this plugin was registered for it.
  // Redacting it here is the only place that reaches it.
  on("prompt.attachment", async ($: any, e: any, next: (e: any) => unknown) => {
    await markObserved($, "prompt.attachment");
    try {
      const { enabled, tier, salt } = await posture($, cfg);
      const got = (await next(e)) as { text: string | null } | undefined;
      const text = got?.text ?? e.text;
      if (!enabled || !salt || typeof text !== "string") {
        return got ?? { text: typeof text === "string" ? text : null };
      }
      if (text === "") return { text };
      const result = scrub(text, await optionsFor($, salt, tier, cfg.minEntropy, cfg.budgetMs, cfg.disabledRules));
      if (result.hits.length === 0) return { text };
      await recordHits($, result.hits);
      return { text: result.text };
    } catch {
      // Fail closed: leaving one attachment out is recoverable; carrying it raw
      // into the request is not.
      return { text: null };
    }
  });

  // --- prompt.compose: the standing notice, on the system-prompt surface -----
  // `prompt.section` was skipped in a live session because another plugin's hook
  // ran first and passed the event on without calling `next`. `prompt.compose`
  // is the composition of the whole system prompt, so appending a `session`
  // section here delivers the notice even when the per-section chain is not
  // reached. Both are registered: whichever one the engine reaches, the model
  // is told the placeholders are opaque.
  on("prompt.compose", async ($: any, e: any, next: (e: any) => unknown) => {
    await markObserved($, "prompt.compose");
    const got = (await next(e)) as
      | { sections?: readonly { id: string; text: string; scope: "shared" | "session" }[] }
      | undefined;
    if (!got || !Array.isArray(got.sections)) return got;
    const { enabled } = await posture($, cfg);
    if (!enabled) return got;
    if (got.sections.some((section) => section.id === NOTICE_SECTION_ID)) return got;
    return {
      sections: [...got.sections, { id: NOTICE_SECTION_ID, text: OPAQUE_NOTICE.trim(), scope: "session" as const }],
    };
  });

  // --- prompt.section: tell the model the placeholders are opaque -----------
  on("prompt.section", async ($: any, e: any, next: (e: any) => unknown) => {
    // The event reaching this handler is the evidence, even for a section this
    // mod does not rewrite.
    await markObserved($, "prompt.section");
    if (e.name !== "env_info_simple") return next(e);
    const { enabled } = await posture($, cfg);
    if (!enabled) return next(e);
    const got = (await next(e)) as { text: string | null } | undefined;
    const text = got?.text ?? e.text;
    if (typeof text !== "string") return got ?? { text: null };
    return { text: text + OPAQUE_NOTICE };
  });

  // --- tool.call: rehydrate ONLY the three file-editing tools ---------------
  for (const tool of REHYDRATE_TOOLS) {
    on("tool.call", { tool }, async ($: any, e: any, next: (e: any) => unknown) => {
      await markObserved($, "tool.call");
      const { enabled } = await posture($, cfg);
      if (!enabled) return next(e);
      const vault = await getVault($);
      if (Object.keys(vault).length === 0) return next(e);
      const rewritten: Record<string, unknown> = {};
      let restored = 0;
      for (const [key, value] of Object.entries(e as Record<string, unknown>)) {
        if (RESERVED.has(key)) {
          rewritten[key] = value;
          continue;
        }
        const parsed = asRehydratable(value);
        if (parsed === undefined) {
          rewritten[key] = value;
          continue;
        }
        // Count what is about to be restored, before restoring it.
        restored += placeholdersIn(parsed);
        rewritten[key] = rehydrate(parsed, vault);
      }
      if (restored > 0) await setRestored($, (await getRestored($)) + restored);
      return next(rewritten);
    });
  }

  // --- tool.call: refuse a placeholder on tools that never receive real values
  // Bash and the network tools are absent from REHYDRATE_TOOLS on purpose: that
  // absence is what stops a model-written command or URL from becoming an
  // exfiltration path. The cost is that a placeholder reaches them as literal
  // text, so a command that "works" silently does nothing. Refusing is the honest
  // move, and the refusal carries the route that does work.
  for (const tool of GUARDED_TOOLS) {
    on("tool.call", { tool }, async ($: any, e: any, next: (e: any) => unknown) => {
      await markObserved($, "tool.call");
      const { enabled } = await posture($, cfg);
      if (!enabled) return next(e);
      const vault = await getVault($);
      // No vault means no placeholder of ours is in play: nothing to refuse.
      if (Object.keys(vault).length === 0) return next(e);
      let carried = 0;
      for (const [key, value] of Object.entries(e as Record<string, unknown>)) {
        if (RESERVED.has(key)) continue;
        const parsed = asRehydratable(value);
        if (parsed === undefined) continue;
        carried += placeholdersIn(parsed);
      }
      if (carried === 0) return next(e);
      return {
        deny:
          `prompt-redact: this ${tool} call carries ${carried} redacted placeholder(s). ` +
          `${tool} never receives real values — that rule is what keeps a model-written command or URL from ` +
          `becoming an exfiltration path — so this call would have run with [REDACTED:...] as literal text, ` +
          `not as the secret. Nothing was executed. Use the value without typing it: keep the secret in a file ` +
          `and load it (\`set -a; . ./.env; set +a\`) then reference $NAME, or ask the user where the value ` +
          `should be supplied. Do not ask them to paste it into the conversation.`,
      };
    });
  }

  // --- command.run: /redact -------------------------------------------------
  on("command.run", { command: "redact" }, async ($: any, e: any) => {
    const args = String(e.args ?? "").trim();
    const [sub, ...rest] = args.split(/\s+/);
    const counts = await getCounts($);
    const restored = await getRestored($);
    const enabled = (await getEnabled($)) ?? configuredEnabled;
    const tier = (await getTier($)) ?? configuredTier;
    const vault = await getVault($);
    const allow = await getAllow($);
    const deny = await getDeny($);
    const disabled = (await getDisabled($)) ?? [...cfg.disabledRules];
    const fires = await getFires($);

    switch (sub) {
      case "":
      case "stats":
        return { text: report(counts, restored, enabled, tier, Object.keys(vault).length) };
      case "on":
        await setEnabled($, true);
        return { text: "prompt-redact on." };
      case "off":
        await setEnabled($, false);
        return {
          text:
            "prompt-redact OFF for this session. Nothing is scanned: secrets in prompts, " +
            "tool results and replies will reach the model and the transcript file as typed. " +
            "`/redact on` restores it.",
        };
      case "tier": {
        const wanted = rest[0] as Tier;
        if (!TIERS.includes(wanted)) {
          return { text: `usage: /redact tier <${TIERS.join("|")}> — strict redacts most, precision only clear-cut secrets` };
        }
        await setTier($, wanted);
        return { text: `prompt-redact tier set to ${wanted}.` };
      }
      case "allow": {
        const pattern = rest.join(" ");
        if (!pattern) return { text: "usage: /redact allow <regex> — values matching are never redacted" };
        if (!compile(pattern)) return { text: `not a valid regex: ${pattern}` };
        await setAllow($, [...allow, pattern]);
        return { text: `allowlisted: ${pattern}` };
      }
      case "deny": {
        const pattern = rest.join(" ");
        if (!pattern) return { text: "usage: /redact deny <regex> — values matching are always redacted" };
        if (!compile(pattern)) return { text: `not a valid regex: ${pattern}` };
        await setDeny($, [...deny, pattern]);
        return { text: `force-redact: ${pattern}` };
      }
      case "rule": {
        // The "remove rules" half of L3. Adding a rule has always been possible
        // through `.claude/prompt-redact.rules`; until now there was no way to
        // switch a shipped rule off, which left a person stuck with a noisy rule
        // and no recourse but disabling the whole mod.
        const action = rest[0];
        const ids = rest.slice(1);
        if (action === undefined || action === "list") {
          return {
            text:
              disabled.length === 0
                ? "no rules disabled. /redact rule off <id> switches one off; ids are listed in RULES.md."
                : `disabled (${disabled.length}): ${disabled.join(", ")}`,
          };
        }
        if (action !== "on" && action !== "off") {
          return { text: "usage: /redact rule on|off <id> [<id>...] — ids are listed in RULES.md" };
        }
        if (ids.length === 0) {
          return { text: `usage: /redact rule ${action} <id> — ids are listed in RULES.md` };
        }
        // Validate before writing: a typo must not silently disable nothing.
        const known = new Set<string>([...RULES.map((rule) => rule.id), ...ENGINE_RULE_IDS]);
        const unknown = ids.filter((id) => !known.has(id));
        if (unknown.length > 0) {
          return { text: `no such rule: ${unknown.join(", ")} — ids are listed in RULES.md` };
        }
        const next =
          action === "off"
            ? [...new Set([...disabled, ...ids])]
            : disabled.filter((id) => !ids.includes(id));
        await setDisabled($, next);
        return {
          text: `${action === "off" ? "disabled" : "re-enabled"}: ${ids.join(", ")}\nnow disabled: ${
            next.length === 0 ? "none" : next.join(", ")
          }`,
        };
      }
      case "why": {
        return {
          text: [
            "How a value becomes a placeholder:",
            "  1. structural detectors (PEM private keys, JWTs, IBANs, Luhn card numbers, SSA numbers) — self-proving, no entropy gate.",
            `  2. the generated rule corpus, prefiltered by keyword — ${detectorsFor(4096)}.`,
            "  3. the allowlist — benign high-entropy shapes (git SHAs, UUIDs, checksums, public keys, placeholders) are left alone.",
            "  4. a context score for the generic family only.",
            "",
            `tier ${tier}: strict redacts most, balanced is the default, precision only clear-cut secrets.`,
            `user allowlist entries: ${allow.length}; force-redact entries: ${deny.length}`,
            `rules switched off: ${disabled.length === 0 ? "none" : `${disabled.length} (${disabled.join(", ")})`}`,
            `labels hidden this session: ${Object.keys(counts).length}`,
            ...interceptionPosture(fires),
            "No network, no subprocess, no model call: a detector never transmits the value it hides.",
          ].join("\n"),
        };
      }
      case "help":
      default:
        return {
          text: [
            "/redact            counts by label, restore count, vault size",
            "/redact on|off     enable or disable scanning for this session",
            `/redact tier <${TIERS.join("|")}>`,
            "/redact allow <re> stop redacting values matching <re>",
            "/redact deny <re>  always redact values matching <re>",
            "/redact rule on|off <id>  switch a shipped rule off or back on",
            "/redact rule list  which rules are off",
            "/redact why        how detection works, and this session's posture",
            "/redact help       this text",
          ].join("\n"),
        };
    }
  });

  // --- tool.call (every tool): redact the tool's own result -----------------
  // `session.append` rewrites `message.content`, but the transcript ALSO stores
  // the tool's structured result as a sidecar (`toolUseResult`) outside that
  // field. A live run showed the model reading a redacted row while the sidecar
  // kept the raw file content. Rewriting the result here is what makes the
  // sidecar match what the model reads, because the engine records a hook's
  // returned result in the transcript as the tool's result.
  on("tool.call", async ($: any, e: any, next: (e: any) => unknown) => {
    await markObserved($, "tool.call");
    const answer = await next(e);
    const { enabled, tier, salt } = await posture($, cfg);
    if (!enabled || !salt) return answer;
    if (!answer || typeof answer !== "object" || !("result" in (answer as Record<string, unknown>))) {
      return answer;
    }
    try {
      const opts = await optionsFor($, salt, tier, cfg.minEntropy, cfg.budgetMs, cfg.disabledRules);
      const hits: ScrubHit[] = [];
      // A tool's result is JSON-shaped; `asRehydratable` is the boundary parse,
      // so the walk below is typed end to end instead of threading `unknown`.
      const scrubNode = (node: Rehydratable): Rehydratable => {
        if (typeof node === "string") {
          const result = scrub(node, opts);
          if (result.hits.length > 0) hits.push(...result.hits);
          return result.text;
        }
        if (Array.isArray(node)) return [...node].map(scrubNode);
        if (node !== null && typeof node === "object") {
          const out: Record<string, Rehydratable> = {};
          for (const [key, child] of Object.entries(node)) out[key] = scrubNode(child);
          return out;
        }
        return node;
      };
      const rewritten = { ...(answer as Record<string, unknown>) };
      // Parse each field at its boundary. A field that is not JSON-shaped (a
      // Buffer, a function) has no parsed form, so it is left alone for the
      // row-level pass rather than coerced into one.
      for (const field of ["text", "result"] as const) {
        if (!(field in rewritten)) continue;
        const parsed = asRehydratable(rewritten[field]);
        if (parsed !== undefined) rewritten[field] = scrubNode(parsed);
      }
      if (hits.length > 0) await recordHits($, hits);
      return rewritten;
    } catch {
      // Fail closed: the tool ran, but its raw output must not reach the model
      // or the transcript. An error result is recoverable; a leak is not.
      return { deny: "prompt-redact could not scan this tool result; it was withheld rather than returned raw" };
    }
  });

  // --- ui.render: the transparent band above the prompt ---------------------
  // Draws only when there is something to say. Elements come from the surface's
  // own constructors (`$.ui.resolve`), never hand-built plain objects: a tree
  // that does not validate draws the engine's own component instead, silently.
  on("ui.render", { component: "AbovePrompt" }, async ($: any, e: any, next: (e: any) => unknown) => {
    const counts = await getCounts($);
    const enabled = (await getEnabled($)) ?? configuredEnabled;
    const total = Object.values(counts).reduce((n, count) => n + count, 0);
    if (enabled && total === 0) return next(e);
    const labels = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([label, count]) => `${label} x${count}`);
    const line = enabled
      ? `\u{1F6E1} prompt-redact hid ${total}${labels.length ? ` \u2014 ${labels.join(" \u00b7 ")}` : ""}`
      : `\u{1F6E1} prompt-redact OFF${total > 0 ? ` (${total} hidden earlier)` : ""}`;
    try {
      const { Box, Text } = $.ui.resolve(e);
      return Box({ paddingLeft: 1 }, Text({ dimColor: true }, line));
    } catch {
      // A surface with no drawable element set: say nothing rather than draw wrong.
      return next(e);
    }
  });
}
