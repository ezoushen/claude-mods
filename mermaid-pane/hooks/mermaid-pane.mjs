// mermaid-pane — presents ```mermaid blocks from the conversation as ASCII art
// or images, per the user's pick (see research/mermaid-in-tui.md).
//
// Modes (via /mermaid ascii | /mermaid image, persisted in $.state):
//   ascii — each reply's mermaid fence is rewritten in place into rendered
//           ASCII art (the chart sits with the response it belongs to)
//   image — replies keep their source; the /mermaid pane draws real diagram
//           PNGs as Image elements, degrading to art where the terminal
//           cannot draw images
// Either way, /mermaid opens the pane with every chart of the session and
// [ Open ↗ ] hands off to the full-fidelity mermaid.ink SVG.
//
// No-cut strategy (art): tiered mermaid-ascii spacing → built-in edge-list
// art → the source itself; every Text draws with wrap:'wrap', lines wrap,
// never clip. PNG path: mermaid.ink JPEG → sips → PNG file, decoded by the
// terminal itself (no pixel crosses $).

const NS = { plugin: "mermaid-pane", key: "diagrams" };
const TOOL = { plugin: "mermaid-pane", key: "asciiTool" };
const MODE = { plugin: "mermaid-pane", key: "mode" };
const PANE_ID = "mermaid";
const PNG_DIR = "/tmp/mermaid-pane";
const MAX_DIAGRAMS = 20;

// Module-level memos: survive redraws, reset on hot reload (fine for caches).
const artCache = new Map(); // `${budget}|${code}` -> art string
const pngCache = new Map(); // base -> { file, w, h } | null
const pngFailedAt = new Map(); // base -> ms of the last failed fetch (retry window)
let pngsDirty = false; // a PNG was produced after some row may have drawn without it
let probedTool; // undefined = not probed this load

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

function diagramTitle(code) {
  const first = code.split("\n")[0].trim();
  const m = /^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram-v?\d*|erDiagram|journey|gantt|pie|mindmap|timeline|gitGraph|quadrantChart|xychart|sankey)/i.exec(first);
  return m ? m[1] : "diagram";
}

let modeMemo; // undefined = not loaded this load; render path must stay sync-fast

async function getMode($) {
  if (modeMemo !== undefined) return modeMemo;
  try {
    const remembered = await $.store.get("mode"); // durable across sessions
    if (remembered === "image" || remembered === "ascii") {
      modeMemo = remembered;
      return remembered;
    }
  } catch {
    // fall through to session state
  }
  try {
    const { value } = await $.state.get(MODE);
    modeMemo = value === "image" ? "image" : "ascii";
    return modeMemo;
  } catch {
    modeMemo = "ascii";
    return modeMemo;
  }
}

async function run($, cmd) {
  const r = await $.process.run(["/bin/sh", "-c", cmd]);
  return r?.value ?? r ?? {};
}

async function probeTool($) {
  if (probedTool !== undefined) return probedTool;
  try {
    const { exitCode, stdout } = await run($, "command -v mermaid-ascii || true");
    probedTool = (exitCode ?? 1) === 0 && stdout?.trim() ? stdout.trim() : null;
  } catch {
    probedTool = null;
  }
  return probedTool;
}

// --- tier 1: mermaid-ascii ---------------------------------------------------

function artWidth(art) {
  return Math.max(0, ...art.split("\n").map((l) => l.length));
}

async function asciiFor($, code, budget) {
  code = normalize(code);
  const cacheKey = `${budget}|${code}`;
  if (artCache.has(cacheKey)) return artCache.get(cacheKey);
  const tool = await probeTool($);
  let art = null;
  if (tool) {
    // Tiered spacing: default → compact → tightest; first render that fits wins.
    const tiers = [[], ["-x", "2", "-y", "2", "-p", "1"], ["-x", "1", "-y", "1", "-p", "0"]];
    for (const flags of tiers) {
      const sh = `printf '%s' ${shellQuote(code)} | ${tool} -f - ${flags.join(" ")} 2>/dev/null`;
      try {
        const { exitCode, stdout } = await run($, sh);
        if ((exitCode ?? 1) === 0 && stdout?.trim()) {
          art = stdout.replace(/\n+$/, "");
          if (artWidth(art) <= budget) break;
        }
      } catch {
        // next tier
      }
      art = null;
    }
  }
  const result = art ?? edgeArt(code) ?? code; // full code, wrapped — never cut
  artCache.set(cacheKey, result);
  return result;
}

// --- tier 2: built-in edge-list art (always fits; lines wrap, never cut) -----

// Normalize: the header ("flowchart LR") must open its own line for
// mermaid-ascii and for line-based edge parsing; replies often inline it.
function normalize(code) {
  return code.replace(/^(flowchart|graph)\s+(TD|TB|LR|RL|BT)\b[: ]*/i, "$1 $2\n").trim();
}

function edgeArt(code) {
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

// --- image mode: local mmdc render (no network) → mermaid.ink fallback ------

let probedMmdc; // undefined = not probed this load

async function mmdcPath($) {
  if (probedMmdc !== undefined) return probedMmdc;
  try {
    const { exitCode, stdout } = await run($, "command -v mmdc || true");
    probedMmdc = (exitCode ?? 1) === 0 && stdout?.trim() ? stdout.trim() : null;
  } catch {
    probedMmdc = null;
  }
  return probedMmdc;
}

async function ensurePng($, code) {
  code = normalize(code);
  const base = `d${hash(code)}`;
  if (pngCache.has(base)) return pngCache.get(base);
  // Transient failures retry after a minute — never cached permanently, so
  // missed charts upgrade on a later draw. No clock, no throttle (hosts
  // without $.clock.now always allow the attempt).
  let now = 0;
  try {
    now = (await $.clock.now()) || 0;
  } catch {
    now = 0;
  }
  const failedAt = pngFailedAt.get(base);
  if (now && failedAt !== undefined && now - failedAt < 60000) return null;
  if (now) pngFailedAt.set(base, now);
  let result = null;
  const png = `${PNG_DIR}/${base}.png`;
  const mmdc = await mmdcPath($);
  if (mmdc) {
    // Tier 0: local render via mermaid-cli + the system browser — no network.
    // -s 2 doubles the pixels; the terminal downsamples the crisp source.
    try {
      const sh =
        `NB=$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | tail -1); [ -n "$NB" ] && export PATH="$NB:$PATH"; command -v node >/dev/null 2>&1 || exit 0; ` +
        `mkdir -p '${PNG_DIR}' && printf '%s' ${shellQuote(code)} > '${PNG_DIR}/${base}.mmd' && ` +
        `P=""; [ -f '${PNG_DIR}/puppeteer.json' ] && P="-p ${PNG_DIR}/puppeteer.json"; ` +
        `[ -f '${PNG_DIR}/puppeteer.json' ] || for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" "/Applications/Chromium.app/Contents/MacOS/Chromium" "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"; do [ -x "$c" ] && printf '{"executablePath":"%s"}' "$c" > '${PNG_DIR}/puppeteer.json' && P="-p ${PNG_DIR}/puppeteer.json" && break; done; ` +
        `'${mmdc}' $P -i '${PNG_DIR}/${base}.mmd' -o '${png}' -b white -s 2 >/dev/null 2>&1 && ` +
        `sips -g pixelWidth -g pixelHeight '${png}'`;
      const { exitCode, stdout } = await run($, sh);
      const w = /pixelWidth: (\d+)/.exec(stdout ?? "")?.[1];
      const h = /pixelHeight: (\d+)/.exec(stdout ?? "")?.[1];
      if ((exitCode ?? 1) === 0 && w && h) {
        // -s 2: the PNG is the natural layout at 2x — native cell width = w/2/16.
        const native = Math.max(24, Math.min(100, Math.round(parseInt(w, 10) / 32)));
        result = { file: png, w: parseInt(w, 10), h: parseInt(h, 10), native };
      }
    } catch {
      result = null;
    }
  }
  if (!result) {
    // Tier 1 fallback: mermaid.ink (network) → sips → PNG.
    try {
      const jpg = `${PNG_DIR}/${base}.jpg`;
      const targetPx = 2400;
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
      }
    } catch {
      result = null;
    }
  }
  const wasCached = pngCache.has(base);
  if (result) pngFailedAt.delete(base);
  else if (now) pngFailedAt.set(base, now);
  if (!wasCached && result) pngsDirty = true; // a row may have drawn without this PNG
  pngCache.set(base, result);
  return result;
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

// --- scroll profiling: per-hook render cost + transcript cache stats --------

const profile = {
  assistant: { n: 0, total: 0, max: 0 },
  pane: { n: 0, total: 0, max: 0 },
  msgFetch: 0,
  msgCache: 0,
};

function nowMs() {
  try {
    return typeof Date !== "undefined" ? Date.now() : 0;
  } catch {
    return 0;
  }
}

function record(stat, dt) {
  stat.n += 1;
  stat.total += dt;
  if (dt > stat.max) stat.max = dt;
}

function profileText() {
  const f = (s) => (s.n === 0 ? "0 renders" : `${s.n} renders, avg ${Math.round(s.total / s.n)}ms, max ${Math.round(s.max)}ms`);
  return [
    `assistant rows: ${f(profile.assistant)}`,
    `pane: ${f(profile.pane)}`,
    `transcript: ${profile.msgFetch} fetches, ${profile.msgCache} cache hits`,
  ].join("\n");
}

function resetProfile() {
  for (const s of [profile.assistant, profile.pane]) {
    s.n = 0;
    s.total = 0;
    s.max = 0;
  }
  profile.msgFetch = 0;
  profile.msgCache = 0;
}

// --- collection (defensive: message rows are { role, text, toolUses }) ------

// Scroll renders call collect() many times a second; serializing the whole
// conversation each time is the lag. 1s TTL cache; persist bypasses it.
let msgsCache = { at: -Infinity, rows: [] };

async function loadMessages($, fresh) {
  if (!fresh) {
    try {
      const now = await $.clock.now();
      if (now && now - msgsCache.at < 1000) {
        profile.msgCache += 1;
        return msgsCache.rows;
      }
    } catch {
      // no clock: fetch every time
    }
  }
  let rows = msgsCache.rows;
  try {
    rows = (await $.session.messages()) ?? [];
    profile.msgFetch += 1;
  } catch {
    rows = msgsCache.rows; // keep the last good transcript
  }
  try {
    const now = await $.clock.now();
    if (now) {
      msgsCache.at = now;
      msgsCache.rows = rows;
    }
  } catch {
    // no clock: skip caching
  }
  return rows;
}

async function collect($, persist = false) {
  let msgs;
  try {
    msgs = (await loadMessages($, persist)) ?? [];
  } catch {
    return { diagrams: [] };
  }
  const found = [];
  for (const t of Array.isArray(msgs) ? msgs : []) {
    const text = typeof t?.text === "string" ? t.text : "";
    const role = t?.role;
    if (!text || (role && !/assistant|model/i.test(String(role)))) continue;
    for (const m of text.matchAll(/```mermaid[^\n]*\n([\s\S]*?)```/g)) {
      const code = m[1].trim();
      if (code && !found.some((d) => d.code === code)) {
        found.push({ id: "", title: diagramTitle(code), code });
      }
    }
  }
  if (!found.length) return { diagrams: [] };
  const { value: prev = [] } = await $.state.get(NS);
  const merged = [...prev];
  for (const d of found) if (!merged.some((x) => x.code === d.code)) merged.push(d);
  const added = merged.length !== prev.length;
  const capped = merged.slice(-MAX_DIAGRAMS).map((d, i) => ({ ...d, id: d.id || `m${i + 1}` }));
  if (persist && added) await $.state.set(NS, capped);
  return { diagrams: capped };
}

async function openInBrowser($, d) {
  try {
    await $.process.run(["open", inkUrl(d.code, "svg")]);
    await $.ui.toast("Mermaid preview opened in browser");
  } catch (err) {
    await $.ui.toast("mermaid-pane: " + (err?.message ?? String(err)));
  }
}

// Transcript budget: replies draw full width less the bullet indent, the
// code-block frame's padding, and a margin so charts don't touch the edges.
function budgetOf(e) {
  const columns = e?.viewport?.columns ?? 120;
  return Math.max(24, Math.min(160, columns - 14));
}

// Pane budget: the pane docks beside the transcript (roughly half the screen),
// less a margin inside its padded frame.
function paneBudgetOf(e) {
  const columns = e?.viewport?.columns ?? 120;
  return Math.max(24, Math.min(140, Math.floor(columns * 0.45) - 4));
}

// Native cell width of a diagram, from the SVG's own viewBox (like a font's
// point size: fixed, independent of the pane). Fallback when unreadable.
const FALLBACK_NATIVE_COLS = 60;
const svgCache = new Map(); // base -> native columns

async function naturalCols($, code) {
  const base = `d${hash(normalize(code))}`;
  if (svgCache.has(base)) return svgCache.get(base);
  let cols = FALLBACK_NATIVE_COLS;
  try {
    const { exitCode, stdout } = await run($, `curl -sfL --max-time 20 '${inkUrl(code, "svg")}' | head -c 3000`);
    if ((exitCode ?? 1) === 0) {
      const vb = /viewBox="([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+)"/.exec(stdout ?? "");
      const mw = /max-width:\s*(\d+)px/.exec(stdout ?? "");
      const naturalPx = vb ? parseFloat(vb[3]) : mw ? parseFloat(mw[1]) : NaN;
      if (Number.isFinite(naturalPx) && naturalPx > 0) cols = Math.max(24, Math.min(100, Math.round(naturalPx / 16)));
    }
  } catch {
    // fallback stands
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
  const { Box, Text } = $.ui.resolve(e);
  if ((await getMode($)) === "image") {
    const blocks = [];
    for (const part of splitByFences(text)) {
      if (part.kind === "text") {
        const t = part.text.replace(/^\n+|\n+$/g, "");
        if (t) blocks.push(Text({ wrap: "wrap", children: t }));
      } else {
        const png = await ensurePng($, part.code);
        if (png) {
          const sized = sizePng(png, budget, maxRows);
          blocks.push(centered($.ui.resolve(e), { source: { file: sized.file, format: "png" }, columns: sized.columns, rows: sized.rows, alt: await asciiFor($, part.code, budget) }));
        } else {
          blocks.push(Text({ wrap: "wrap", children: await asciiFor($, part.code, budget) }));
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

async function renderPane($, e, next) {
  const { diagrams } = await collect($); // read-only: render hooks may not write state
  if (!diagrams.length) return next(e);
  const mode = await getMode($);
  const resolved = $.ui.resolve(e);
  const { Box, Text, Button } = resolved;
  const shown = diagrams.slice(-3);
  const budget = paneBudgetOf(e);
  const blocks = [];
  for (let i = 0; i < shown.length; i++) {
    const d = shown[i];
    blocks.push(Text({ bold: true, children: `▤ mermaid ${i + 1}/${shown.length} · ${d.title}` }));
    if (mode === "image") {
      const png = await ensurePng($, d.code);
      if (png) {
        const bodyRows = e?.props?.scroll?.bodyRows ?? 30;
        const sized = sizePng(png, budget - 2, bodyRows - 2);
        blocks.push(centered(resolved, { source: { file: sized.file, format: "png" }, columns: sized.columns, rows: sized.rows, alt: await asciiFor($, d.code, budget) }, `mermaid-${d.id}`));
      } else {
        blocks.push(Text({ key: `mermaid-${d.id}`, wrap: "wrap", children: await asciiFor($, d.code, budget) }));
      }
    } else {
      blocks.push(Text({ key: `mermaid-${d.id}`, wrap: "wrap", children: await asciiFor($, d.code, budget) }));
    }
    if (i < shown.length - 1) blocks.push(Text({ children: "" }));
  }
  blocks.push(Text({ dimColor: true, children: `${mode} mode · /mermaid ${mode === "image" ? "ascii" : "image"} to switch · /mermaid close` }));
  blocks.push(Button({ label: "Open ↗", onPress: () => openInBrowser($, shown[shown.length - 1]) }));
  return Box({ flexDirection: "column", gap: 1, padding: 1, children: blocks });
}

// --- registration ------------------------------------------------------------
export function register(on) {

  on("session.start", async ($, e, next) => {
    const r = await next(e);
    await $.command.register({
      name: "mermaid",
      description: "Mermaid charts: session gallery pane",
      argumentHint: "[ascii|image|close|profile]",
    });
    return r;
  });

  on("turn.complete", async ($, e, next) => {
    const r = await next(e);
    if (e?.agentId) return r; // skip subagent loops
    try {
      const { diagrams } = await collect($, true); // retain for the /mermaid pane
      const tool = await probeTool($);
      const { value: known } = await $.state.get(TOOL);
      if (known === undefined || known !== tool) await $.state.set(TOOL, tool);
      if ((await getMode($)) === "image") {
        for (const d of diagrams.slice(-3)) await ensurePng($, d.code); // pre-warm
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
    const t0 = await nowMs($);
    const out = await renderAssistant($, e, next);
    record(profile.assistant, (await nowMs($)) - t0);
    return out;
  });

  on("ui.render", { component: "Pane" }, async ($, e, next) => {
    const t0 = await nowMs($);
    const out = await renderPane($, e, next);
    record(profile.pane, (await nowMs($)) - t0);
    return out;
  });

  on("command.run", async ($, e, next) => {
    if (e?.command === "mermaid") {
      const arg = (e?.args ?? "").trim().toLowerCase();
      if (/^(close|hide)/.test(arg)) {
        await $.ui.close({ id: PANE_ID });
        return { text: "Mermaid pane closed." };
      }
      if (/^profile/.test(arg)) {
        const text = `profile since last reset:\n${profileText()}`;
        resetProfile();
        return { text };
      }
      if (/^(image|ascii)/.test(arg)) {
        const mode = arg.startsWith("image") ? "image" : "ascii";
        modeMemo = mode;
        await $.state.set(MODE, mode);
        return {
          text:
            mode === "image"
              ? "Image mode: charts draw as pictures in the /mermaid pane; replies keep their source. /mermaid ascii to switch back."
              : "ASCII mode: charts draw as art inside each reply (and in the pane). /mermaid image to switch.",
        };
      }
      const r = await $.ui.open({ id: PANE_ID, title: "Mermaid", focus: true });
      const placed = r?.value?.isPlaced ?? r?.isPlaced;
      return {
        text:
          placed === false
            ? "Terminal too narrow for a docked pane — mermaid diagrams draw inline above the prompt."
            : `Mermaid pane opened (${await getMode($)} mode).`,
      };
    }
    return next(e);
  });
}
