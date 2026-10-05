// image-preview — preview image paths inline, like the desktop GUI app.
//
// Two things, keyed on the same scan of text:
//   1. Chat rows (UserMessage): every image reference in the prompt draws an
//      inline thumbnail, aspect-fit, never taller than 10 rows.
//   2. Above the prompt editor (AbovePrompt band): the current draft's image
//      references draw a small strip, square (1:1) and aspect-filled, no taller
//      than 4 rows — updated as the person types.
//
// An "image reference" is either a real file path ending in a supported image
// extension (.png .jpg .jpeg .gif .webp .bmp .tif .tiff .heic .heif .ico .svg),
// or an [Image #N] token, N resolved against the gallery the /image command
// stores. Both are decoded once (sips -> PNG -> base64, or a file the terminal
// reads) and memoised by path + size + mtime; pixels never cross $.

const NS = { plugin: "image-preview", key: "state" };
const TMP_DIR = "/tmp/image-preview";

// A terminal char is ~2.125x taller than wide (16px x 34px). A square (1:1) box
// of `rows` rows is `rows * 34/16` columns wide; a picture scaled to that box
// aspect-fills (crops) without distortion.
const CELL_H_OVER_CELL_W = 34 / 16;

const MAX_CHAT_ROWS = 10; // chat thumbnail height cap
const MAX_BAND_ROWS = 4; // prompt-editor thumbnail height cap

// A whitespace-delimited token ending in a supported image extension.
const PATH_RE =
  /(?:^|[\s"'([,{])([^\s"'<>]+?\.(?:png|jpg|jpeg|gif|webp|bmp|tif(f)?|heic|heif|ico|svg))(?=[\s"')\]}]|$)/gi;
// An [Image #N] reference token; group 1 is its number.
const REF_RE = /\[Image\s*#(\d+)\s*\]/gi;

// A prompt carries images only if either form is present.
const HAS_IMAGE = /\.(png|jpg|jpeg|gif|webp|bmp|tif(t)?|heic|heif|ico|svg)|\[Image\s*#\d+\]/i;

// Module-level memo: survive redraws, reset on hot reload. Key = resolved path
// + size + mtime -> { source, w, h } or the string "fail".
const imgCache = new Map();

// --- tiny helpers (sandbox: no Node, no DOM) --------------------------------

function run($, cmd) {
  return $.process.run(["/bin/sh", "-c", cmd]);
}

function quote(p) {
  return `'${String(p).replace(/'/g, `'\\''`)}'`;
}

function basename(path) {
  const clean = String(path).replace(/^["']|["']$/g, "").split(/[?#]/)[0];
  const m = /([^\\/]+)$/.exec(clean);
  return m ? m[1] : clean;
}

function join(cwd, t) {
  const c = String(cwd ?? "").replace(/\/+$/, "");
  const r = String(t).replace(/^\/+/, "");
  const base = r.startsWith("/") ? r : `${c}/${r}`;
  const parts = base.split("/");
  const out = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else out.push("..");
    } else out.push(p);
  }
  return `/${out.join("/")}`;
}

function resolvePath(token, cwd) {
  const t = token.trim();
  if (/^[A-Za-z]:[\\/]/.test(t)) return t.replace(/\\/g, "/"); // Windows absolute
  if (t.startsWith("/")) return t;
  if (t === "." || t === "..") return t;
  return join(cwd, t); // relative / bare name
}

function hash(s) {
  let h = 5381;
  for (const c of s) h = ((h << 5) + h + c.charCodeAt(0)) | 0;
  return (h >>> 0).toString(36);
}


// Decode `absPath` (via a sips->PNG conversion for non-PNG input). Returns
// { source, w, h } or null. Memoised by path + size + mtime.
async function decode($, absPath) {
  const key = absPath;
  if (imgCache.has(key)) return imgCache.get(key);

  let result = null;
  try {
    // sips reformats any raster to PNG and shrinks to fit 800px, keeping the
    // file small and decodable by every surface. A missing or non-image file
    // makes sips fail, so we never render a broken box. The terminal reads the
    // PNG by name — the same way the mermaid pane hands it diagram PNGs.
    const png = `${TMP_DIR}/${hash(key)}.png`;
    const sh =
      `mkdir -p ${quote(TMP_DIR)} && sips ${quote(absPath)} -z 800 800 --out ${quote(png)} 2>/dev/null && ` +
      `sips -g pixelWidth -g pixelHeight ${quote(png)}`;
    const r = await run($, sh);
    const stdout = r ? r.stdout : "";
    const w = /pixelWidth:\s*(\d+)/.exec(stdout);
    const h = /pixelHeight:\s*(\d+)/.exec(stdout);
    // sips wrote pixels -> the file is a decodable image; size it ourselves.
    if ((r?.exitCode ?? 1) === 0 && w && h) {
      result = { file: png, w: parseInt(w[1], 10), h: parseInt(h[1], 10) };
    }
  } catch {
    result = null;
  }
  imgCache.set(key, result || "fail");
  return result || "fail";
}

// --- drawing one thumbnail ---------------------------------------------------

// One image reference → one node: the real PNG drawn as an Image element and
// centered in the row, exactly how the mermaid pane presents its diagrams.
// `alt` keeps the label so the picture is never silent where paint is absent.
async function drawThumb($, absPath, label, maxColumns, mode, C) {
  const { Box, Image, Text } = C;
  const decoded = await decode($, absPath);
  if (!decoded || typeof decoded !== "object" || !decoded.file) {
    return Text({ children: label });
  }
  const sized = sizeFor(decoded.w, decoded.h, maxColumns, mode === "square" ? MAX_BAND_ROWS : MAX_CHAT_ROWS, mode);
  return Box({
    width: "100%",
    alignItems: "center",
    paddingY: 1,
    children: [
      Image({
        key: hash(absPath),
        source: { file: decoded.file, format: "png" },
        columns: sized.columns,
        rows: sized.rows,
        alt: label,
      }),
    ],
  });
}

// --- sizing -----------------------------------------------------------------

// Aspect-fit: the picture fits inside maxColumns x maxRows, unchanged aspect.
function fit(W, H, maxColumns, maxRows) {
  if (!W || !H || W <= 0 || H <= 0) return { columns: 1, rows: 1 };
  // columns/rows == (W/H) * (CELL_H/CELL_W)
  const ratio = (W / H) * CELL_H_OVER_CELL_W;
  let columns = Math.max(1, Math.floor(maxColumns));
  let rows = Math.max(1, Math.round(columns * ratio));
  if (rows > maxRows) {
    rows = maxRows;
    columns = Math.max(1, Math.floor(rows / ratio));
  }
  if (columns > maxColumns) {
    columns = maxColumns;
    rows = Math.max(1, Math.round(columns * ratio));
  }
  return { columns, rows };
}

// Square box (1:1) filled by aspect-fill, <= maxRows tall.
function squareBox(maxColumns, maxRows) {
  let rows = Math.min(maxRows, 4);
  let columns = Math.round(rows * CELL_H_OVER_CELL_W);
  while (columns > maxColumns && rows > 1) {
    rows -= 1;
    columns = Math.round(rows * CELL_H_OVER_CELL_W);
  }
  return { rows, columns: Math.min(columns, maxColumns) };
}

function sizeFor(w, h, maxColumns, maxRows, mode) {
  return mode === "square" ? squareBox(maxColumns, maxRows) : fit(w, h, maxColumns, maxRows);
}

// --- scanning a prompt for image references --------------------------------

// Ordered parts: text runs and image references interleaved as they appear.
// Each image reference carries an absolute path (possibly null, resolved later
// against the gallery) and a short label (basename, or [Image #N]) as alt, so
// the sentence is never lost.
function scan(text, cwd) {
  if (!text || typeof text !== "string") return [];
  const hits = [];

  let m;
  PATH_RE.lastIndex = 0;
  while ((m = PATH_RE.exec(text))) {
    hits.push({ index: m.index, end: m.index + m[0].length, abs: resolvePath(m[1], cwd), label: basename(m[1]) });
  }
  REF_RE.lastIndex = 0;
  while ((m = REF_RE.exec(text))) {
    hits.push({ index: m.index, end: m.index + m[0].length, abs: null, label: `[Image #${m[1]}]`, num: parseInt(m[1], 10) });
  }
  hits.sort((a, b) => a.index - b.index);

  const parts = [];
  let last = 0;
  for (const hit of hits) {
    const runText = text.slice(last, hit.index).trimEnd();
    if (runText) parts.push({ kind: "text", text: runText });
    parts.push({
      kind: "img",
      abs: hit.abs,
      label: hit.abs ? hit.label : `[Image #${hit.num}]`,
      key: hash(hit.abs || `[Image #${hit.num}]`),
    });
    last = hit.end;
  }
  const tail = text.slice(last).trimEnd();
  if (tail) parts.push({ kind: "text", text: tail });
  return parts;
}

// --- building render nodes --------------------------------------------------

// Turn scanned parts into element nodes (Text / Image) in document order, using
// the given element constructors and sizing mode.
async function buildNodes($, parts, gallery, mode, C) {
  const { Text } = C;
  const nodes = [];

  for (const part of parts) {
    if (part.kind === "text") {
      nodes.push(Text({ wrap: "wrap", children: part.text }));
      continue;
    }
    const path = part.abs ?? galleryPath(gallery, part.label);
    if (!path) {
      // The gallery doesn't hold that index: keep the label so the reference
      // is never lost.
      nodes.push(Text({ children: part.label }));
      continue;
    }
    nodes.push(await drawThumb($, path, part.label, C.maxColumns, mode, C));
  }
  return nodes;
}

// Resolve an [Image #N] label against the gallery; returns its path or null.
function galleryPath(gallery, label) {
  const m = /\[Image #(\d+)\]/.exec(label);
  if (!m) return null;
  return gallery?.[parseInt(m[1], 10) - 1] ?? null;
}

// --- state ------------------------------------------------------------------

async function loadState($) {
  try {
    const { value } = await $.state.get(NS);
    return value?.state ?? {};
  } catch {
    return {};
  }
}

async function loadGallery($) {
  const s = await loadState($);
  return Array.isArray(s.gallery) ? s.gallery : [];
}

// Persist the draft's decoded thumbnails so the AbovePrompt band (which never
// receives the draft text in its props) can draw them. Called from prompt.edit.
async function rememberAbove($, draft, thumbs) {
  const s = await loadState($);
  const gallery = Array.isArray(s.gallery) ? s.gallery : [];
  await $.state.set(NS, { state: { gallery, band: { draft, images: thumbs } } });
}

// --- registration ------------------------------------------------------------

// Recompute the editor-band thumbnails from a draft and persist them.
async function updateBand($, text) {
  if (!HAS_IMAGE.test(text)) {
    await rememberAbove($, "", []);
    return;
  }
  const cwd = (await $.session.cwd().catch(() => "/")).trim();
  const gallery = await loadGallery($);
  const parts = scan(text, cwd);
  const imgParts = parts.filter((p) => p.kind === "img");
  if (!imgParts.length) {
    await rememberAbove($, "", []);
    return;
  }
  const thumbs = [];
  for (const part of imgParts) {
    const path = part.abs ?? galleryPath(gallery, part.label);
    const decoded = path ? await decode($, path) : null;
    if (decoded && typeof decoded === "object" && decoded.file) {
      thumbs.push({ key: part.key, label: part.label, path });
    }
  }
  await rememberAbove($, text, thumbs);
}

// One handler for both ways a draft changes: prompt.edit (each keystroke) and
// prompt.fill (a plugin or the engine writing the box). Both results carry the
// resulting draft in `.text` — the edit input's own `text` is the pre-edit
// draft, so reading it there would lag the band a keystroke behind.
async function bandHook($, e, next) {
  const r = await next(e);
  const text = typeof r?.text === "string" ? r.text : String(e?.text ?? "");
  await updateBand($, text);
  try {
    await $.ui.invalidate("ui.render");
  } catch {
    // no ui.render subscription yet; the next edit redraws
  }
  return r;
}

export function register(on) {
  // Live prompt-box editing: recompute the editor-band thumbnails and re-run
  // ui.render so the AbovePrompt band redraws with fresh previews.
  on("prompt.edit", bandHook);
  on("prompt.fill", bandHook);

  // Chat row with image references: redraw the row as a column of text +
  // images (aspect-fit, <= 10 rows).
  on("ui.render", { component: "UserMessage" }, async ($, e, next) => {
    const props = e?.props ?? {};
    if (props.origin?.kind !== "composer") return next(e);
    const text = props.text;
    if (typeof text !== "string" || !HAS_IMAGE.test(text)) return next(e);

    const cwd = (await $.session.cwd().catch(() => "/")).trim();
    const gallery = await loadGallery($);
    const parts = scan(text, cwd);
    if (!parts.some((p) => p.kind === "img")) return next(e);

    const maxColumns = e?.viewport?.columns ?? props.bodyColumns ?? 60;
    const C = { ...$.ui.resolve(e), maxColumns };
    const nodes = await buildNodes($, parts, gallery, "fit", C);
    const { Box } = C;
    return Box({ flexDirection: "column", gap: 1, children: nodes });
  });

  // Agent reply rows: an image path the model mentions draws its thumbnail
  // after the reply's own block (the engine's drawing is kept via next(e)).
  on("ui.render", { component: "AssistantMessage" }, async ($, e, next) => {
    const props = e?.props ?? {};
    const text = props.text;
    if (typeof text !== "string" || !HAS_IMAGE.test(text)) return next(e);

    const cwd = (await $.session.cwd().catch(() => "/")).trim();
    const gallery = await loadGallery($);
    const parts = scan(text, cwd);
    if (!parts.some((p) => p.kind === "img")) return next(e);

    const maxColumns = e?.viewport?.columns ?? props.bodyColumns ?? 60;
    const C = { ...$.ui.resolve(e), maxColumns };
    const nodes = [];
    for (const part of parts) {
      if (part.kind !== "img") continue;
      const path = part.abs ?? galleryPath(gallery, part.label);
      if (!path) continue;
      nodes.push(await drawThumb($, path, part.label, maxColumns, "fit", C));
    }
    if (!nodes.length) return next(e);

    const body = await next(e);
    const bodyNode = typeof body === "string" ? C.Text({ children: body }) : body;
    return C.Box({ flexDirection: "column", gap: 1, children: [bodyNode, ...nodes] });
  });

  // Above the prompt editor: draw the stored thumbnails (square, aspect-fill,
  // <= 4 rows) above the band's own content.
  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    const resolved = $.ui.resolve(e);
    const { Box, Text } = resolved;
    const state = await loadState($);
    const bodyColumns = e?.props?.bodyColumns ?? e?.viewport?.columns ?? 80;
    const thumbs = state?.band?.images ?? [];

    let drawn = false;
    const children = [];
    if (thumbs.length) {
      drawn = true;
      for (const th of thumbs) {
        children.push(await drawThumb($, th.path, th.label, bodyColumns, "square", resolved));
      }
    }

    if (!drawn) return next(e);

    const body = await next(e);
    const bodyNode = typeof body === "string" ? Text({ children: body }) : body;
    return Box({ flexDirection: "column", gap: 1, children: [bodyNode, ...children] });
  });

  // Store image paths so they can be referenced as [Image #N].
  on("session.start", async ($, e, next) => {
    const r = await next(e);
    try {
      await $.command.register({
        name: "image",
        description: "Store image paths; reference them in prompts as [Image #N] with an inline preview.",
        argumentHint: "<path... | list | clear>",
      });
    } catch {
      // already registered after a hot reload
    }
    return r;
  });

  on("command.run", async ($, e, next) => {
    if (e?.command !== "image") return next(e);
    const arg = (e?.args ?? "").trim();
    if (!arg) {
      return {
        text: "image: stores image paths for inline preview. /image <path...> to add, /image list, /image clear.",
      };
    }
    if (/^(list)$/.test(arg)) {
      const gallery = await loadGallery($);
      return { text: gallery.length ? gallery.map((p, i) => `[Image #${i + 1}]  ${p}`).join("\n") : "Gallery empty." };
    }
    if (/^(clear|reset)$/.test(arg)) {
      await $.state.set(NS, { state: { gallery: [], band: { draft: "", images: [] } } });
      return { text: "image-preview gallery cleared." };
    }

    const cwd = (await $.session.cwd().catch(() => "/")).trim();
    const gallery = await loadGallery($);
    const existing = new Set(gallery);
    const added = [];
    for (const raw of arg.split(/\s+/)) {
      if (!raw) continue;
      const abs = resolvePath(raw, cwd);
      if (existing.has(abs)) continue;
      existing.add(abs);
      gallery.push(abs);
      added.push(abs);
    }
    if (added.length) {
      // Reset the editor-band cache so a fresh edit recomputes from the gallery.
      await $.state.set(NS, { state: { gallery, band: { draft: "", images: [] } } });
      const tokens = added.map((p) => `[Image #${gallery.indexOf(p) + 1}]`);
      return { text: `Stored ${added.length} image${added.length === 1 ? "" : "s"}:` + tokens.map((t) => `\n${t}`).join("") };
    }
    return { text: "Nothing new to store." };
  });
}
