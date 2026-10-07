// mermaid-pane — renders ```mermaid blocks from the conversation inline, as
// ASCII art or images, per the user's pick (see research/mermaid-in-tui.md).
//
// Modes (via /mermaid ascii | /mermaid image; picked per session in $.state,
// remembered across sessions in $.store):
//   ascii — each reply's mermaid fence is rewritten in place into rendered
//           ASCII art (the chart sits with the response it belongs to)
//   image — replies keep their source; each chart draws as a real diagram
//           PNG, degrading to art where the terminal cannot draw images
//
// External rendering (mermaid.ink) is OFF by default — image mode alone is
// not consent. Opt in with /mermaid external on (persists in $.store). Local
// mmdc is preferred; on miss/fail/timeout with external OFF, fail closed to
// ASCII with a short actionable diagnostic (never logs diagram source or
// encoded URLs).
//
// No-cut strategy (art): termaid (--width + compact gaps) → built-in
// edge-list art → the source itself; every Text draws with wrap:'wrap',
// lines wrap, never clip. PNG path: local mmdc → (opt-in) mermaid.ink → sips.

const MODE = { plugin: "mermaid-pane", key: "mode" }; // read while drawing: a set redraws the drawer
const PNG_DIR = "/tmp/mermaid-pane";
const LOCAL_RENDER_SECS = 45; // bound local mmdc so a hung Chromium cannot stall redraws
const RETRY_MS = 60000; // a failed chart renders again after this long

// Module-level memos: survive redraws, reset on hot reload (fine for caches).
const artCache = new Map(); // `${budget}|${code}` -> art string
const pngCache = new Map(); // base -> { file, w, h, native } (successes only)
const pngFailed = new Map(); // base -> { at, diag } of the last failure (retry window)
const pngInflight = new Map(); // base -> the render in flight (shared by overlapping draws)
const pngAwaited = new Set(); // bases a draw stopped waiting for: redraw when they land
let pngsDirty = false; // a PNG was produced after some row may have drawn without it
let probedTool; // undefined = not probed this load
let lastPngDiag = null; // last safe diagnostic for /mermaid status (no source/URLs)

// --- tiny utils (sandbox: no Node, no btoa) ---------------------------------

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function b64url(str) {
  const bytes = [...unescape(encodeURIComponent(str))].map((c) => c.charCodeAt(0));
  let out = "";
  for (let i = 0; i < bytes.length; ) {
    const b1 = bytes[i++];
    const b2 = i < bytes.length ? bytes[i++] : NaN;
    const b3 = i < bytes.length ? bytes[i++] : NaN;
    out += B64[b1 >> 2];
    out += B64[((b1 & 3) << 4) | (isNaN(b2) ? 0 : b2 >> 4)];
    out += isNaN(b2) ? "" : B64[((b2 & 15) << 2) | (isNaN(b3) ? 0 : b3 >> 6)];
    out += isNaN(b3) ? "" : B64[b3 & 63];
  }
  return out;
}

function inkUrl(code, kind = "svg") {
  const payload = b64url(JSON.stringify({ code, mermaid: { theme: "default" } }));
  return `https://mermaid.ink/${kind}/${payload}`;
}

function hash(s) {
  let h = 5381;
  for (const c of s) h = ((h << 5) + h + c.charCodeAt(0)) | 0;
  return (h >>> 0).toString(36);
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

let modeMemo; // undefined = not loaded this load; render path must stay sync-fast
let externalMemo; // undefined = not loaded; "on" | "off"

async function getMode($) {
  if (modeMemo === undefined) {
    try {
      const { value } = await $.state.get(MODE); // this session's pick; subscribes the drawer
      if (value === "image" || value === "ascii") {
        modeMemo = value;
        return modeMemo;
      }
    } catch {
      // fall through to the durable store
    }
    try {
      const remembered = await $.store.get("mode"); // durable across sessions and reloads
      modeMemo = remembered === "image" ? "image" : "ascii";
    } catch {
      modeMemo = "ascii";
    }
  }
  return modeMemo;
}

// External mermaid.ink is opt-in and durable. Default OFF — a saved image mode
// never implies consent. Check immediately before every network send.
async function getExternalAllowed($) {
  if (externalMemo === undefined) {
    try {
      const remembered = await $.store.get("external");
      externalMemo = remembered === "on" ? "on" : "off";
    } catch {
      externalMemo = "off";
    }
  }
  return externalMemo === "on";
}

function clearImageCaches() {
  pngCache.clear();
  svgCache.clear();
  pngFailed.clear();
  pngsDirty = false;
  lastPngDiag = null;
}

async function setExternalAllowed($, allowed) {
  externalMemo = allowed ? "on" : "off";
  clearImageCaches(); // revocation/opt-in must affect queued retries and redraws
  await $.store.set("external", externalMemo);
}

async function run($, cmd, init) {
  const r = await $.process.run(["/bin/sh", "-c", cmd], init);
  return r?.value ?? r ?? {};
}

// Hook shells don't source rc files, so nvm's node bin dir is often missing
// from PATH; prepend the newest installed nvm node when probing/installing.
const NVM_PATH_PRELUDE =
  'NB=$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | tail -1); [ -n "$NB" ] && export PATH="$NB:$PATH"; ';

// Locate a binary: ambient PATH first, then ~/.local/bin (the setup target).
// Everything env-sensitive stays in $HOME/uname — nothing per-machine hardcoded.
function whichSh(bin, prelude = "") {
  return (
    `${prelude}if command -v ${bin} >/dev/null 2>&1; then command -v ${bin};` +
    ` elif [ -x "$HOME/.local/bin/${bin}" ]; then echo "$HOME/.local/bin/${bin}"; fi`
  );
}

// The path, null when absent, undefined when the probe was cut (not an answer).
async function probeSh($, sh) {
  try {
    const { exitCode, stdout } = await run($, sh);
    return (exitCode ?? 1) === 0 && stdout?.trim() ? stdout.trim() : null;
  } catch (err) {
    return isAborted(err) ? undefined : null;
  }
}

async function probeTool($) {
  if (probedTool !== undefined) return probedTool;
  probedTool = await probeSh($, whichSh("termaid"));
  return probedTool;
}

// --- tier 1: termaid (multi-type Mermaid → Unicode/ASCII art) ----------------

function artWidth(art) {
  return Math.max(0, ...art.split("\n").map((l) => l.length));
}

async function asciiFor($, code, budget) {
  code = normalize(code);
  const cacheKey = `${budget}|${code}`;
  if (artCache.has(cacheKey)) return artCache.get(cacheKey);
  const tool = await probeTool($);
  let cut = tool === undefined; // a cut probe or run is no answer: don't cache
  let art = null;
  if (tool) {
    // termaid already re-renders with smaller gaps and padding to fit --width;
    // what still overflows is as compact as it gets, so edge art takes over.
    const sh = `printf '%s' ${shellQuote(code)} | ${shellQuote(tool)} --width ${budget} 2>/dev/null`;
    try {
      const { exitCode, stdout } = await run($, sh);
      if ((exitCode ?? 1) === 0 && stdout?.trim()) {
        art = stdout.replace(/\n+$/, "");
        if (artWidth(art) > budget) art = null;
      }
    } catch (err) {
      cut = isAborted(err);
      art = null;
    }
  }
  const result = art ?? edgeArt(code) ?? code; // full code, wrapped — never cut
  if (!cut) artCache.set(cacheKey, result);
  return result;
}

// --- tier 2: built-in edge-list art (always fits; lines wrap, never cut) -----

// Normalize: the header ("flowchart LR") must open its own line for termaid
// and for line-based edge parsing; replies often inline it.
function normalize(code) {
  return code.replace(/^(flowchart|graph)\s+(TD|TB|LR|RL|BT)\b[: ]*/i, "$1 $2\n").trim();
}

function edgeArt(code) {
  code = code.replace(/<br\s*\/?>/gi, " "); // one edge per line: label breaks become spaces
  const labels = {};
  for (const m of code.matchAll(/([A-Za-z]\w*)\s*[\[\(\{]+([^\]\)\}]+)[\]\)\}]+/g)) {
    labels[m[1]] = m[2].trim();
  }
  const name = (id) => (labels[id] ? `${id}[${labels[id]}]` : id);
  const glyph = (arr) => ({ "-->" : "──", "===" : "══", "---" : "──", "-.->" : "┄┄", "->>" : "──", "-->>" : "┄┄" }[arr] ?? "──");
  const idOf = (tok) => /^\s*([A-Za-z]\w*)/.exec(tok)?.[1] ?? null;
  const lines = [];
  for (let raw of normalize(code).split("\n")) {
    const line = raw.trim();
    if (!line || /^(subgraph|end$|participant|title|%%)/i.test(line)) continue;
    // Tokenize chains (A --> B --> C) and sequence arrows (A->>B: msg) alike.
    const segs = line.split(/(-->>|-->|===|---|-\.->|->>)/);
    if (segs.length < 3) continue;
    for (let i = 1; i < segs.length - 1; i += 2) {
      const arr = segs[i];
      let after = segs[i + 1];
      let lbl = null;
      let extra = null;
      const pipe = /^\s*\|([^|]*)\|\s*/.exec(after);
      if (pipe) {
        lbl = pipe[1].trim();
        after = after.slice(pipe[0].length);
      }
      const colon = /^\s*([A-Za-z]\w*)\s*:\s*(.+)$/.exec(after);
      if (colon) {
        extra = colon[2].trim();
        after = colon[1];
      }
      const a = idOf(segs[i - 1]);
      const b = idOf(after);
      if (!a || !b) continue;
      const tag = extra ? `: ${extra}` : lbl ? ` |${lbl}|` : "";
      lines.push(`${name(a)} ${glyph(arr)}▶ ${name(b)}${tag}`);
    }
  }
  return lines.length ? lines.join("\n") : null;
}

// --- image mode: local mmdc render (no network) → opt-in mermaid.ink ------

let probedMmdc; // undefined = not probed this load

async function mmdcPath($) {
  if (probedMmdc !== undefined) return probedMmdc;
  probedMmdc = await probeSh($, whichSh("mmdc", NVM_PATH_PRELUDE));
  return probedMmdc;
}

// Safe, source-free reason strings for the user. Never include diagram text,
// encoded payloads, mermaid.ink URLs, or raw shell commands that embed them.
function diagLocal(kind) {
  const remoteHint =
    "Remote mermaid.ink is off — /mermaid external on to allow (sends full diagram source; persists).";
  switch (kind) {
    case "missing":
      return `Local PNG unavailable (mermaid-cli not found). ASCII fallback. ${remoteHint}`;
    case "failed":
      return `Local PNG render failed. ASCII fallback. ${remoteHint}`;
    case "timeout":
      return `Local PNG render timed out. ASCII fallback. ${remoteHint}`;
    case "meta":
      return `Local PNG unreadable (bad image metadata). ASCII fallback. ${remoteHint}`;
    case "remote-failed":
      return "Remote PNG unavailable. ASCII fallback. /mermaid setup installs local mermaid-cli.";
    default:
      return `Local PNG unavailable. ASCII fallback. ${remoteHint}`;
  }
}

// A superseded draw's in-flight command is cut by the host ("… aborted").
// That is not a render failure: nothing is recorded, a later draw renders.
// The host words its own timeoutMs kill "aborted: still running after …ms";
// that one is a real timeout.
const ABORTED = Symbol("aborted");

function isRunTimeout(err) {
  return /still running after/i.test(String(err?.message ?? err));
}

function isAborted(err, signal) {
  if (isRunTimeout(err)) return false;
  return Boolean(signal?.aborted) || err?.name === "AbortError" || /\baborted\b/i.test(String(err?.message ?? err));
}

// Waiting on another draw's render is not a $ call, so this hook's budget
// runs on through it: stop short of the budget (or at this draw's abort).
const GAVE_UP = Symbol("gave-up");
const WAIT_MARGIN_MS = 2000;

async function awaitShared($, pending, next) {
  const remaining = next?.budget?.remainingMs;
  const ms = (Number.isFinite(remaining) ? remaining : 8000 + WAIT_MARGIN_MS) - WAIT_MARGIN_MS;
  if (ms <= 0 || next?.signal?.aborted) return GAVE_UP;
  const stop = new AbortController();
  const cut = () => stop.abort();
  next?.signal?.addEventListener?.("abort", cut);
  try {
    const timer = $.clock.sleep(ms, { signal: stop.signal }).then(
      () => GAVE_UP,
      () => GAVE_UP
    );
    return await Promise.race([pending, timer]);
  } finally {
    stop.abort();
    next?.signal?.removeEventListener?.("abort", cut);
  }
}

// Overlapping draws of one chart (several redraws, the turn-end pre-warm)
// share the render in flight instead of racing their own mmdc runs.
async function ensurePng($, code, next) {
  code = normalize(code);
  const base = `d${hash(code)}`;
  const signal = next?.signal;
  for (;;) {
    if (pngCache.has(base)) return pngCache.get(base);
    const pending = pngInflight.get(base);
    if (!pending) break;
    const shared = await awaitShared($, pending, next);
    if (shared === GAVE_UP) {
      pngAwaited.add(base); // draw the fallback now; redraw when it lands
      return null;
    }
    if (shared !== ABORTED) return shared;
    // the draw that owned it was cut: this one renders for itself
  }
  const own = renderPng($, code, base, signal).finally(() => pngInflight.delete(base));
  pngInflight.set(base, own);
  const result = await own;
  return result === ABORTED ? null : result;
}

// The note a chart's ASCII fallback carries: its own last failure, if any.
function pngDiag(code) {
  return pngFailed.get(`d${hash(normalize(code))}`)?.diag ?? null;
}

async function renderPng($, code, base, signal) {
  // Failures retry after a minute — never cached permanently, so missed
  // charts upgrade on a later draw. Without a clock a failure stands for the
  // session rather than re-running mmdc on every redraw.
  let now = 0;
  try {
    now = (await $.clock.now()) || 0;
  } catch {
    now = 0;
  }
  const failed = pngFailed.get(base);
  if (failed && (!now || now - failed.at < RETRY_MS)) return null;
  let result = null;
  let failKind = "failed";
  const png = `${PNG_DIR}/${base}.png`;
  const mmdc = await mmdcPath($);
  if (mmdc === undefined) return ABORTED; // the probe was cut
  if (!mmdc) {
    failKind = "missing";
  } else {
    // Tier 0: local render via mermaid-cli + the system browser — no network.
    // -s 2 doubles the pixels; the terminal downsamples the crisp source.
    // Bound duration so a hung Chromium cannot stall the render hook.
    try {
      const sh =
        `${NVM_PATH_PRELUDE}command -v node >/dev/null 2>&1 || exit 0; ` +
        `mkdir -p '${PNG_DIR}' && printf '%s' ${shellQuote(code)} > '${PNG_DIR}/${base}.mmd' && ` +
        `P=""; [ -f '${PNG_DIR}/puppeteer.json' ] && P="-p ${PNG_DIR}/puppeteer.json"; ` +
        `[ -f '${PNG_DIR}/puppeteer.json' ] || for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" "/Applications/Chromium.app/Contents/MacOS/Chromium" "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"; do [ -x "$c" ] && printf '{"executablePath":"%s"}' "$c" > '${PNG_DIR}/puppeteer.json' && P="-p ${PNG_DIR}/puppeteer.json" && break; done; ` +
        `if command -v timeout >/dev/null 2>&1; then ` +
        `timeout ${LOCAL_RENDER_SECS} '${mmdc}' $P -i '${PNG_DIR}/${base}.mmd' -o '${png}' -b white -s 2 >/dev/null 2>&1; ec=$?; ` +
        `[ "$ec" -eq 124 ] && exit 124; [ "$ec" -eq 0 ] || exit "$ec"; ` +
        `else '${mmdc}' $P -i '${PNG_DIR}/${base}.mmd' -o '${png}' -b white -s 2 >/dev/null 2>&1 || exit $?; fi; ` +
        `sips -g pixelWidth -g pixelHeight '${png}'`;
      // $.process.run kills at 30 s by default — before `timeout` could report.
      const { exitCode, stdout } = await run($, sh, { timeoutMs: (LOCAL_RENDER_SECS + 15) * 1000 });
      if ((exitCode ?? 1) === 124) {
        failKind = "timeout";
      } else {
        const w = /pixelWidth: (\d+)/.exec(stdout ?? "")?.[1];
        const h = /pixelHeight: (\d+)/.exec(stdout ?? "")?.[1];
        if ((exitCode ?? 1) === 0 && w && h) {
          // -s 2: the PNG is the natural layout at 2x — native cell width = w/2/16.
          const native = Math.max(24, Math.min(100, Math.round(parseInt(w, 10) / 32)));
          result = { file: png, w: parseInt(w, 10), h: parseInt(h, 10), native };
        } else if ((exitCode ?? 1) === 0) {
          failKind = "meta";
        } else {
          failKind = "failed";
        }
      }
    } catch (err) {
      if (isAborted(err, signal)) return ABORTED;
      failKind = isRunTimeout(err) ? "timeout" : "failed";
      result = null;
    }
  }
  if (!result) {
    // Tier 1 fallback: mermaid.ink (network) — only when explicitly opted in.
    // Re-check permission immediately before sending so revoke stops in-flight work.
    if (await getExternalAllowed($)) {
      try {
        const jpg = `${PNG_DIR}/${base}.jpg`;
        const targetPx = 2400;
        // Permission still holds at the moment of the request construction.
        if (await getExternalAllowed($)) {
          const sh =
            `mkdir -p '${PNG_DIR}' && curl -sfL --max-time 25 '${inkUrl(code, "img")}?type=png&width=${targetPx}' -o '${jpg}'` +
            ` && sips -s format png '${jpg}' --out '${png}' >/dev/null 2>&1` +
            ` && sips -g pixelWidth -g pixelHeight '${png}'`;
          const { exitCode, stdout } = await run($, sh);
          const w = /pixelWidth: (\d+)/.exec(stdout ?? "")?.[1];
          const h = /pixelHeight: (\d+)/.exec(stdout ?? "")?.[1];
          if ((exitCode ?? 1) === 0 && w && h) {
            const natural = await naturalCols($, code);
            result = { file: png, w: parseInt(w, 10), h: parseInt(h, 10), native: natural };
          } else {
            failKind = "remote-failed";
          }
        }
      } catch (err) {
        if (isAborted(err, signal)) return ABORTED;
        failKind = "remote-failed";
        result = null;
      }
    }
  }
  if (result) {
    // Only successes are cached, so no failure can ever replace one.
    pngFailed.delete(base);
    lastPngDiag = null;
    pngCache.set(base, result);
    pngsDirty = true; // a row may have drawn without this PNG
    if (pngAwaited.delete(base)) {
      try {
        await $.ui.invalidate("ui.render"); // a draw gave up waiting: upgrade it now
      } catch {
        // the turn-end pre-warm redraws it instead
      }
    }
    return result;
  }
  lastPngDiag = diagLocal(failKind); // the newest failure, for /mermaid status
  pngFailed.set(base, { at: now, diag: lastPngDiag });
  return null;
}

// Cell grid for an Image. COMFORT_SCALE: mermaid label text is ~8px per char
// at native size while a terminal char is ~16px, so 1.5x native reads well and
// stays dense. The box is columns*cellW px wide and rows*cellH px tall, so an
// undistorted picture needs rows/columns = (png.h/png.w) x (cellW/cellH) —
// multiply by the cell aspect, never divide. Aspect-fits into BOTH bounds:
// tall diagrams (class/ER) shrink to the height cap instead of distorting.
const COMFORT_SCALE = 1.5;
const CELL_ASPECT = 16 / 34; // herdr cell: 16px wide x 34px tall

function sizePng(png, maxColumns, maxRows) {
  const target = Number.isFinite(png.native) && png.native > 0 ? png.native : FALLBACK_NATIVE_COLS;
  const rowsPerCol = (png.h / png.w) * CELL_ASPECT;
  let columns = Math.max(20, Math.floor(Math.min(target * COMFORT_SCALE, maxColumns)));
  let rows = Math.max(1, Math.round(columns * rowsPerCol));
  const cap = Math.max(6, maxRows ?? 60);
  if (rows > cap) {
    rows = cap;
    columns = Math.max(20, Math.floor(rows / rowsPerCol));
  }
  return { file: png.file, columns, rows };
}

// Center the image horizontally in the full row width, with vertical padding.
function centered(box, child, key) {
  const { Box, Image } = box;
  return Box({ width: "100%", alignItems: "center", paddingY: 1, children: [Image({ key, source: child.source, columns: child.columns, rows: child.rows, alt: child.alt })] });
}

// --- transcript scan (for the image-mode pre-warm on turn completion) -------

// The newest distinct mermaid codes in the conversation, oldest first. Called
// once a turn, so no caching; defensive about message row shapes.
async function lastChartCodes($) {
  let rows = [];
  try {
    rows = (await $.session.messages()) ?? [];
  } catch {
    return [];
  }
  const codes = [];
  for (const t of Array.isArray(rows) ? rows : []) {
    const text = typeof t?.text === "string" ? t.text : "";
    const role = t?.role;
    if (!text || (role && !/assistant|model/i.test(String(role)))) continue;
    for (const m of text.matchAll(/```mermaid[^\n]*\n([\s\S]*?)```/g)) {
      const code = m[1].trim();
      if (code && !codes.includes(code)) codes.push(code);
    }
  }
  return codes.slice(-3);
}

// Transcript budget: replies draw full width less the bullet indent, the
// code-block frame's padding, and a margin so charts don't touch the edges.
function budgetOf(e) {
  const columns = e?.viewport?.columns ?? 120;
  return Math.max(24, Math.min(160, columns - 14));
}

// Native cell width of a diagram, from the SVG's own viewBox (like a font's
// point size: fixed, independent of the pane). Fallback when unreadable.
const FALLBACK_NATIVE_COLS = 60;
const svgCache = new Map(); // base -> native columns

async function naturalCols($, code) {
  const base = `d${hash(normalize(code))}`;
  if (svgCache.has(base)) return svgCache.get(base);
  let cols = FALLBACK_NATIVE_COLS;
  // SVG sizing hits mermaid.ink — same opt-in gate as the image fallback.
  // Re-check immediately before sending so revoke stops queued sizing work.
  if (await getExternalAllowed($)) {
    try {
      if (!(await getExternalAllowed($))) {
        svgCache.set(base, cols);
        return cols;
      }
      const { exitCode, stdout } = await run($, `curl -sfL --max-time 20 '${inkUrl(code, "svg")}' | head -c 3000`);
      if ((exitCode ?? 1) === 0) {
        const vb = /viewBox="([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+)"/.exec(stdout ?? "");
        const mw = /max-width:\s*(\d+)px/.exec(stdout ?? "");
        const naturalPx = vb ? parseFloat(vb[3]) : mw ? parseFloat(mw[1]) : NaN;
        if (Number.isFinite(naturalPx) && naturalPx > 0) cols = Math.max(24, Math.min(100, Math.round(naturalPx / 16)));
      }
    } catch (err) {
      if (isAborted(err)) throw err; // a cut draw: its render is redone, not mis-sized
      // fallback stands
    }
  }
  svgCache.set(base, cols);
  return cols;
}

// Split a reply into text parts and mermaid fence parts, in order.
function splitByFences(text) {
  const parts = [];
  let last = 0;
  for (const m of text.matchAll(/```mermaid[^\n]*\n([\s\S]*?)```/g)) {
    if (m.index > last) parts.push({ kind: "text", text: text.slice(last, m.index) });
    parts.push({ kind: "chart", code: m[1].trim() });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ kind: "text", text: text.slice(last) });
  return parts;
}

// Replace each mermaid fence with a fenced ASCII-art block (ascii mode).
async function embedArt($, text, budget) {
  const matches = [...text.matchAll(/```mermaid[^\n]*\n([\s\S]*?)```/g)];
  if (!matches.length) return null;
  let out = "";
  let last = 0;
  for (const m of matches) {
    out += text.slice(last, m.index);
    const art = await asciiFor($, m[1].trim(), budget);
    out += "```\n" + art + "\n```"; // fenced: the transcript preserves it verbatim
    last = m.index + m[0].length;
  }
  return out + text.slice(last);
}

// ascii mode: embed each fence as rendered art (text rewrite).
// image mode: embed a real Image element in the reply row; if the PNG can't
// be produced, degrade to the ascii art embed. Either way the chart sits
// with the response it belongs to.
async function renderAssistant($, e, next) {
  const text = e?.props?.text;
  if (typeof text !== "string" || !text.includes("```mermaid")) return next(e);
  const budget = budgetOf(e);
  const maxRows = Math.max(8, Math.round((e?.viewport?.rows ?? 40) * 0.7));
  const resolved = $.ui.resolve(e);
  const { Box, Text } = resolved;
  if ((await getMode($)) === "image") {
    const blocks = [];
    for (const part of splitByFences(text)) {
      if (part.kind === "text") {
        const t = part.text.replace(/^\n+|\n+$/g, "");
        if (t) blocks.push(Text({ wrap: "wrap", children: t }));
      } else {
        const png = await ensurePng($, part.code, next);
        if (png) {
          const sized = sizePng(png, budget, maxRows);
          blocks.push(centered(resolved, { source: { file: sized.file, format: "png" }, columns: sized.columns, rows: sized.rows, alt: await asciiFor($, part.code, budget) }));
        } else {
          const art = await asciiFor($, part.code, budget);
          const diag = pngDiag(part.code);
          const note = diag ? `\n\n(${diag})` : "";
          blocks.push(Text({ wrap: "wrap", children: art + note }));
        }
      }
    }
    if (!blocks.length) return next(e);
    return Box({ flexDirection: "column", children: blocks });
  }
  const out = await embedArt($, text, budget);
  if (!out) return next(e);
  return next({ ...e, props: { ...e.props, text: out } });
}

// --- optional renderers: availability + one-shot setup -----------------------

// Fresh (non-memoized) probe — setup must see installs made this session.
const probeFresh = ($, bin, prelude = "") => probeSh($, whichSh(bin, prelude));

// termaid is a pure-Python package on PyPI (zero native deps). Install with
// pip --user, then symlink the console script into ~/.local/bin so the probe
// path (PATH, then ~/.local/bin) finds it even when the user site scripts dir
// is not on PATH (common on macOS Homebrew/Python.org installs).
const ASCII_INSTALL_SH =
  `set -e; ` +
  `command -v python3 >/dev/null 2>&1 || { echo "python3 not found — install Python 3.9+ first" >&2; exit 1; }; ` +
  `python3 -m pip install --user --upgrade 'termaid>=0.9.0' || python3 -m pip install --user --upgrade termaid; ` +
  `mkdir -p "$HOME/.local/bin"; ` +
  `T=""; ` +
  `if command -v termaid >/dev/null 2>&1; then T=$(command -v termaid); ` +
  `elif [ -x "$HOME/.local/bin/termaid" ]; then T="$HOME/.local/bin/termaid"; ` +
  `else ` +
  `UB=$(python3 -c 'import os,site; print(os.path.join(site.USER_BASE,"bin"))' 2>/dev/null || true); ` +
  `SB=$(python3 -c 'import sysconfig; print(sysconfig.get_path("scripts") or "")' 2>/dev/null || true); ` +
  `for d in "$HOME/.local/bin" "$UB" "$SB"; do [ -n "$d" ] && [ -x "$d/termaid" ] && T="$d/termaid" && break; done; ` +
  `fi; ` +
  `[ -n "$T" ] || { echo "termaid installed but console script not found" >&2; exit 1; }; ` +
  `[ "$T" = "$HOME/.local/bin/termaid" ] || ln -sf "$T" "$HOME/.local/bin/termaid"; ` +
  `echo "installed $HOME/.local/bin/termaid ← $T"`;

// mermaid-cli ships prebuilt on npm; puppeteer fetches a prebuilt Chromium on
// first render. The spec is pinned to the Node major that will run it
// (12.x needs Node ≥ 22.13, 11.x ≥ 18.19) so an install on an older Node
// cannot die on engines. npm resolves through the nvm prelude.
const MMDC_INSTALL_SH =
  `${NVM_PATH_PRELUDE}command -v npm >/dev/null 2>&1 || { echo "npm not found — install Node first" >&2; exit 1; }; ` +
  `M=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0); ` +
  `S=@mermaid-js/mermaid-cli@latest; ` +
  `[ "$M" -ge 23 ] || S=@mermaid-js/mermaid-cli@11; ` +
  `[ "$M" -ge 19 ] || S=@mermaid-js/mermaid-cli@10.9.1; ` +
  `npm install -g "$S"`;

// Installs run detached (nohup) so the hook never blocks on npm/pip; the log
// lands in PNG_DIR and a re-run of /mermaid setup reports progress.
async function startInstall($, key, sh) {
  try {
    const r = await run(
      $,
      `mkdir -p '${PNG_DIR}' && printf '%s' ${shellQuote(sh)} > '${PNG_DIR}/install-${key}.sh' && nohup sh '${PNG_DIR}/install-${key}.sh' >> '${PNG_DIR}/setup.log' 2>&1 & echo started`
    );
    return /started/.test(r.stdout ?? "");
  } catch {
    return false;
  }
}

// --- registration ------------------------------------------------------------
export function register(on) {

  on("session.start", async ($, e, next) => {
    const r = await next(e);
    await $.command.register({
      name: "mermaid",
      description: "Mermaid charts: ascii/image mode; external on|off; setup installs renderers",
      argumentHint: "[ascii|image|setup|external on|external off]",
    });
    return r;
  });

  on("turn.complete", async ($, e, next) => {
    const r = await next(e);
    if (e?.agentId) return r; // skip subagent loops
    try {
      if ((await getMode($)) === "image") {
        for (const code of await lastChartCodes($)) await ensurePng($, code, next); // pre-warm (respects external gate)
        if (pngsDirty) {
          // Rows that drew without a ready PNG show the fallback; a redraw now
          // upgrades them to the image.
          pngsDirty = false;
          await $.ui.invalidate("ui.render");
        }
      }
    } catch {
      // drawing must never break the turn
    }
    return r;
  });

  on("ui.render", { component: "AssistantMessage" }, async ($, e, next) => {
    return renderAssistant($, e, next);
  });

  on("command.run", async ($, e, next) => {
    if (e?.command === "mermaid") {
      const arg = (e?.args ?? "").trim().toLowerCase();
      if (/^setup/.test(arg)) {
        const lines = [];
        const starting = [];
        const ascii = await probeFresh($, "termaid");
        const mmdc = await probeFresh($, "mmdc", NVM_PATH_PRELUDE);
        if (ascii) lines.push("✓ termaid (multi-type ASCII art)");
        if (mmdc) lines.push("✓ mermaid-cli (offline PNG rendering)");
        for (const [key, have, label] of [
          ["ascii", ascii, "termaid"],
          ["mmdc", mmdc, "mermaid-cli (mmdc)"],
        ]) {
          if (have) continue;
          if (key === "ascii" && !(await probeFresh($, "python3"))) {
            lines.push(`✗ ${label} — install it manually (needs Python 3.9+ and pip)`);
            continue;
          }
          if (key === "mmdc" && !(await probeFresh($, "npm", NVM_PATH_PRELUDE))) {
            lines.push(`✗ ${label} — install it manually (needs Node + npm)`);
            continue;
          }
          const sh = key === "ascii" ? ASCII_INSTALL_SH : MMDC_INSTALL_SH;
          if (await startInstall($, key, sh)) {
            starting.push(label);
            lines.push(`… ${label} — installing in the background`);
          } else {
            lines.push(`✗ ${label} — could not start the install; see /mermaid setup docs (no diagram source is logged)`);
          }
        }
        let text;
        if (starting.length) {
          const blocked = lines.filter((l) => l.startsWith("✗"));
          text =
            `Installing ${starting.join(", ")} in the background (log: ${PNG_DIR}/setup.log).` +
            (blocked.length ? `\n${blocked.join("\n")}` : "") +
            `\nRe-run /mermaid setup to check; new sessions pick renderers up automatically.` +
            `\nImage mode stays local unless you /mermaid external on (sends full diagram source to mermaid.ink).`;
        } else if (lines.every((l) => l.startsWith("✓"))) {
          text =
            "Everything is installed — ascii art via termaid, images via mermaid-cli." +
            "\nRemote mermaid.ink fallback is opt-in: /mermaid external on (sends full diagram source; persists).";
        } else {
          text = `Renderer status:\n${lines.join("\n")}`;
        }
        return { text };
      }
      if (/^external\s+on\b/.test(arg) || arg === "external on") {
        await setExternalAllowed($, true);
        return {
          text:
            "External rendering ON (persists across sessions). " +
            "When local mermaid-cli is missing or fails, the full diagram source is sent to mermaid.ink " +
            "(image + SVG sizing). /mermaid external off to revoke.",
        };
      }
      if (/^external\s+off\b/.test(arg) || arg === "external off") {
        await setExternalAllowed($, false);
        return {
          text:
            "External rendering OFF (persists). Image mode uses only local mermaid-cli; " +
            "on failure charts fall back to ASCII. No diagram source leaves this machine via mermaid-pane.",
        };
      }
      if (/^external\b/.test(arg)) {
        const allowed = await getExternalAllowed($);
        return {
          text:
            `External rendering is ${allowed ? "ON" : "OFF"} (persists). ` +
            (allowed
              ? "Full diagram source may be sent to mermaid.ink when local render fails. /mermaid external off to revoke."
              : "Image mode stays local. /mermaid external on allows mermaid.ink (sends full diagram source)."),
        };
      }
      if (/^(image|ascii)/.test(arg)) {
        const mode = arg.startsWith("image") ? "image" : "ascii";
        modeMemo = mode;
        await $.store.set("mode", mode); // durable across sessions and reloads
        await $.state.set(MODE, mode); // redraws the rows drawing with it
        const external = await getExternalAllowed($);
        return {
          text:
            mode === "image"
              ? external
                ? "Image mode: charts draw as pictures in replies (local mermaid-cli, then mermaid.ink). /mermaid ascii to switch; /mermaid external off to revoke remote."
                : "Image mode: charts draw as pictures via local mermaid-cli only. Remote mermaid.ink is OFF — /mermaid external on to allow (sends full diagram source; persists). /mermaid ascii to switch."
              : "ASCII mode: charts draw as art inside each reply (always local). /mermaid image to switch.",
        };
      }
      const mode = await getMode($);
      const external = await getExternalAllowed($);
      const ascii = await probeFresh($, "termaid");
      const mmdc = await probeFresh($, "mmdc", NVM_PATH_PRELUDE);
      let text = `${mode} mode — external ${external ? "ON" : "OFF"} — /mermaid ${mode === "image" ? "ascii" : "image"} to switch.`;
      if (!ascii || !mmdc) {
        const parts = [];
        parts.push(`termaid ${ascii ? "✓" : "✗"}`);
        parts.push(`mermaid-cli ${mmdc ? "✓" : "✗"}`);
        text += `\nrenderers: ${parts.join(" · ")} — /mermaid setup installs missing ones`;
      }
      if (!external) {
        text += `\nremote: OFF — /mermaid external on allows mermaid.ink (sends full diagram source; persists)`;
      }
      if (lastPngDiag) text += `\nlast image: ${lastPngDiag}`;
      return { text };
    }
    return next(e);
  });
}
