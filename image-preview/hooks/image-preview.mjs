// image-preview — render image paths inline, like the desktop GUI app.
//
// Two render paths, keyed on the same scan of text:
//   1. UserMessage rows: an image reference in the prompt draws a thumbnail
//      below the prompt's own block, aspect-correct, never taller than 10 rows.
//   2. AssistantMessage rows: an image path the model mentions draws the same
//      thumbnail in the reply row.
//
// Both hooks keep the engine's own block verbatim via next(e) and only append,
// so a prompt with a picture renders exactly like one without.
//
// An image reference is a path ending in a supported extension (.png .jpg
// .jpeg .gif .webp .bmp .tif .tiff .heic .heif .ico .svg), optionally with a
// ?query/#fragment, or an [Image #N] token resolved against the gallery the
// /image command stores. Each picture is decoded once (sips -> a bounded PNG
// the terminal reads, as the mermaid pane hands its diagrams over) and
// memoised by path.
const NS = { plugin: "image-preview", key: "state" };
const TMP_DIR = "/tmp/image-preview";

// A terminal cell is ~2.125x taller than wide (16px x 34px); a block whose cell
// aspect matches the picture's pixel aspect shows it undistorted.
const CELL_H_OVER_CELL_W = 34 / 16;
const MAX_ROWS = 10;

// A whitespace-delimited token ending in a supported image extension. The
// capture is the bare path: an optional ?query/#fragment suffix (as in
// /a/pic.png?w=100) is matched but left out of group 1, so the file the
// decoder reads stays clean.
const PATH_RE =
  /(?:^|[\s"'([,{])([^\s"'<>]+?\.(?:png|jpg|jpeg|gif|webp|bmp|tif(?:f)?|heic|heif|ico|svg))(?:\?[^#\s"')]*)?(?:#[^\s"')]*)?(?=[\s"')\]}]|$)/gi;
// An [Image #N] reference token; group 1 is its number.
const REF_RE = /\[Image\s*#(\d+)\s*\]/gi;
const imgCache = new Map(); // resolved path -> { file, w, h } | "fail"

function run($, cmd) {
  return $.process.run(["/bin/sh", "-c", cmd]);
}

function quote(p) {
  return `'${String(p).replace(/'/g, `'\\''`)}'`;
}

// The file name an alt/label shows: last path segment, query/fragment dropped.
function basename(p) {
  const clean = String(p).replace(/[?#].*/, "");
  const m = /([^/\\]+)$/.exec(clean);
  return m ? m[1] : clean;
}

// Absolute, or cwd-joined for relative references (.. stays intact).
function resolvePath(token, cwd) {
  const t = token.trim();
  if (t.startsWith("/")) return t;
  const parts = `${String(cwd ?? "").replace(/\/+$/, "")}/${t.replace(/^\/+/, "")}`.split("/");
  const out = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === ".." && out.length && out[out.length - 1] !== "..") out.pop();
    else out.push(p);
  }
  return `/${out.join("/")}`;
}

function hash(s) {
  let h = 5381;
  for (const c of s) h = ((h << 5) + h + c.charCodeAt(0)) | 0;
  return (h >>> 0).toString(36);
}

// Decode absPath to a bounded PNG the terminal reads by name. A missing or
// non-image file fails sips, so we never render a broken box.
async function decode($, absPath) {
  if (imgCache.has(absPath)) return imgCache.get(absPath);
  let result = null;
  try {
    const png = `${TMP_DIR}/${hash(absPath)}.png`;
    // -Z bounds the longest side and preserves aspect (-z would resample to an
    // exact WxH box and distort every picture into a square).
    const sh =
      `mkdir -p ${quote(TMP_DIR)} && sips ${quote(absPath)} -Z 800 --out ${quote(png)} 2>/dev/null && ` +
      `sips -g pixelWidth -g pixelHeight ${quote(png)}`;
    const r = await run($, sh);
    const w = /pixelWidth:\s*(\d+)/.exec(r?.stdout ?? "");
    const h = /pixelHeight:\s*(\d+)/.exec(r?.stdout ?? "");
    if ((r?.exitCode ?? 1) === 0 && w && h) {
      result = { file: png, w: parseInt(w[1], 10), h: parseInt(h[1], 10) };
    }
  } catch {
    result = null;
  }
  imgCache.set(absPath, result || "fail");
  return result || "fail";
}

// Aspect-fill: the block's cell aspect matches the picture's pixel aspect, so
// it is never stretched. A block of c x r cells is (c*16)px wide by (r*34)px
// tall, so undistorted means c/r == (W/H) * 34/16 — `ratio` columns per row.
// Thumbnails are height-bound: start from the row cap.
function fit(W, H, maxColumns, maxRows) {
  if (!W || !H || W <= 0 || H <= 0) return { columns: 1, rows: 1 };
  const ratio = (W / H) * CELL_H_OVER_CELL_W;
  let rows = Math.max(1, Math.floor(maxRows));
  let columns = Math.round(rows * ratio);
  if (columns > maxColumns) {
    columns = Math.max(1, Math.floor(maxColumns));
    rows = Math.max(1, Math.round(columns / ratio));
  }
  return { columns, rows };
}

// The image references in text, in document order: real paths and gallery
// tokens alike. The row's text is never rewritten, so nothing here carries the
// surrounding prose.
function imageRefs(text, cwd) {
  if (!text || typeof text !== "string") return [];
  const refs = [];
  let m;
  PATH_RE.lastIndex = 0;
  while ((m = PATH_RE.exec(text))) {
    refs.push({ abs: resolvePath(m[1], cwd), label: basename(m[1]) });
  }
  REF_RE.lastIndex = 0;
  while ((m = REF_RE.exec(text))) {
    refs.push({ abs: null, num: parseInt(m[1], 10), label: `[Image #${m[1]}]` });
  }
  return refs;
}

// One thumbnail per resolvable reference, in document order.
async function collectThumbs($, text, C) {
  const cwd = (await $.session.cwd().catch(() => "/")).trim();
  const gallery = await loadGallery($);
  const nodes = [];
  for (const ref of imageRefs(text, cwd)) {
    const path = ref.abs ?? gallery[ref.num - 1] ?? null;
    if (!path) continue;
    const decoded = await decode($, path);
    if (!decoded) continue;
    const sized = fit(decoded.w, decoded.h, C.maxColumns, MAX_ROWS);
    nodes.push(
      C.Box({
        width: "100%",
        alignItems: "center",
        paddingY: 1,
        children: [
          C.Image({
            key: hash(path),
            source: { file: decoded.file, format: "png" },
            columns: sized.columns,
            rows: sized.rows,
            alt: ref.label,
          }),
        ],
      }),
    );
  }
  return nodes;
}

// Some render passes read state before it is available (the raw answer comes
// back { version } with no value), which would make gallery thumbnails flicker
// out on redraws. Remember the last non-empty gallery and fall back to it.
let lastGallery = [];

async function loadGallery($) {
  try {
    const { value } = await $.state.get(NS);
    const gallery = value?.state?.gallery;
    if (Array.isArray(gallery) && gallery.length) lastGallery = gallery;
    return Array.isArray(gallery) && gallery.length ? gallery : lastGallery;
  } catch {
    return lastGallery;
  }
}

// Opt-in and capability gate in one: CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1 is
// the same switch the engine's own kitty-graphics gate honors — set it where
// the terminal paints (the README shows a herdr-scoped zshrc guard). Unset,
// the mod is a complete no-op: no state reads, no sips, no scans.
async function paints($) {
  try {
    return (await $.env.get("CLAUDE_CODE_FORCE_TERMINAL_IMAGES")) === "1";
  } catch {
    return false;
  }
}

// Shared render body for both row types: the engine's own block, untouched —
// identical to a no-image row — with the thumbnails appended below it.
async function renderRow($, e, next) {
  if (!(await paints($))) return next(e);

  const props = e?.props ?? {};
  const text = props.text;
  if (typeof text !== "string") return next(e);

  const maxColumns = e?.viewport?.columns ?? props.bodyColumns ?? 60;
  const C = { ...$.ui.resolve(e), maxColumns };
  const nodes = await collectThumbs($, text, C);
  if (!nodes.length) return next(e);

  const body = await next(e);
  const bodyNode = typeof body === "string" ? C.Text({ children: body }) : body;
  return C.Box({ flexDirection: "column", children: [bodyNode, ...nodes] });
}

export function register(on) {
  on("ui.render", { component: "UserMessage" }, async ($, e, next) => {
    if (e?.props?.origin?.kind !== "composer") return next(e);
    return renderRow($, e, next);
  });

  on("ui.render", { component: "AssistantMessage" }, ($, e, next) => renderRow($, e, next));

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
      return { text: "image: stores image paths for inline preview. /image <path...> to add, /image list, /image clear." };
    }
    if (/^(list)$/.test(arg)) {
      const gallery = await loadGallery($);
      return { text: gallery.length ? gallery.map((p, i) => `[Image #${i + 1}]  ${p}`).join("\n") : "Gallery empty." };
    }
    if (/^(clear|reset)$/.test(arg)) {
      await $.state.set(NS, { state: { gallery: [] } });
      return { text: "image-preview gallery cleared." };
    }

    const cwd = (await $.session.cwd().catch(() => "/")).trim();
    const gallery = await loadGallery($);
    const added = [];
    for (const raw of arg.split(/\s+/)) {
      if (!raw) continue;
      const abs = resolvePath(raw, cwd);
      if (!gallery.includes(abs)) gallery.push(abs);
      if (!added.includes(abs)) added.push(abs);
    }
    if (!added.length) return { text: "Nothing new to store." };
    await $.state.set(NS, { state: { gallery } });
    const tokens = added.map((p) => `[Image #${gallery.indexOf(p) + 1}]`);
    return { text: `Stored ${added.length} image${added.length === 1 ? "" : "s"}:` + tokens.map((t) => `\n${t}`).join("") };
  });
}
