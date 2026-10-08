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
// ?query/#fragment, or an [Image #N] token for a picture pasted into the
// prompt, read back from the transcript. Each picture is decoded once (sips ->
// a bounded PNG the terminal reads, as the mermaid pane hands its diagrams
// over) and memoised by path, or by content for a paste.
const NS = { plugin: "image-preview", key: "state" };
const TMP_DIR = "/tmp/image-preview";

// A terminal cell is ~2.125x taller than wide (16px x 34px); a block whose cell
// aspect matches the picture's pixel aspect shows it undistorted.
const CELL_H_OVER_CELL_W = 34 / 16;
const MAX_ROWS = 10;

// A whitespace-delimited token ending in a supported image extension. The
// capture is the bare path: an optional ?query/#fragment suffix (as in
// /a/pic.png?w=100) is matched but left out of group 1, so the file the
// decoder reads stays clean. The path may sit in a code span, bold, or a
// markdown link target, and may be followed by sentence punctuation; a path
// never starts with the [, ( or * of that markup nor holds a link's "](", so
// `[a](/b.png)` reads /b.png while app/[id]/hero.png stays whole. A
// backslash-escaped space (as a file dropped on the terminal arrives) is part
// of the path, never the start of one.
const PATH_RE =
  /(?:^|(?<!\\)[\s"'`([,{*])([^\s"'<>`*([\]](?:\\ |(?!\]\()[^\s"'<>`])*?\.(?:png|jpg|jpeg|gif|webp|bmp|tif(?:f)?|heic|heif|ico|svg))(?:\?[^#\s"')]*)?(?:#[^\s"')]*)?(?=[\s"'`*)\]}]|[.,:;!?](?:[\s"'`*)\]}]|$)|$)/gi;
// A quoted path with a space in it ("…", '…' or a code span) starting at /,
// ~/, ./ or ../; group 2 is the path. Unquoted, a space ends a path.
const QUOTED_RE =
  /(["'`])((?:\/|~\/|\.\.?\/)(?=[^"'`\n<>]* )[^"'`\n<>]*?\.(?:png|jpg|jpeg|gif|webp|bmp|tif(?:f)?|heic|heif|ico|svg))\1/gi;
// An [Image #N] token the engine puts in a prompt for a pasted picture; group
// 1 is its number, counted across the session.
const REF_RE = /\[Image\s*#(\d+)\s*\]/gi;
const imgCache = new Map(); // resolved path or paste key -> { file, w, h } | "fail"
const pastes = new Map(); // [Image #N] number -> { data, key }
const pasteMisses = new Map(); // [Image #N] number -> when the transcript last lacked it
const PASTE_RETRY_MS = 2000;

function run($, cmd, stdin) {
  return $.process.run(["/bin/sh", "-c", cmd], stdin === undefined ? undefined : { stdin });
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

// Absolute, ~/ against HOME, or cwd-joined for relative references
// (.. stays intact). A ~/ path with no HOME resolves to null: no guess.
function resolvePath(token, cwd, home) {
  const t = token.trim();
  if (t.startsWith("/")) return t;
  if (t.startsWith("~/")) return home ? resolvePath(t.slice(2), home) : null;
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

// Run sh, then read the PNG's size; { file, w, h } when both worked, else null.
async function decodeWith($, sh, png, stdin) {
  try {
    const r = await run($, `${sh} && sips -g pixelWidth -g pixelHeight ${quote(png)}`, stdin);
    const w = /pixelWidth:\s*(\d+)/.exec(r?.stdout ?? "");
    const h = /pixelHeight:\s*(\d+)/.exec(r?.stdout ?? "");
    if ((r?.exitCode ?? 1) === 0 && w && h) return { file: png, w: parseInt(w[1], 10), h: parseInt(h[1], 10) };
  } catch {}
  return null;
}

// Decode absPath to a bounded PNG the terminal reads by name. A missing or
// non-image file fails sips, so we never render a broken box.
async function decode($, absPath) {
  if (imgCache.has(absPath)) return imgCache.get(absPath);
  const png = `${TMP_DIR}/${hash(absPath)}.png`;
  // -Z bounds the longest side and preserves aspect (-z would resample to an
  // exact WxH box and distort every picture into a square).
  const result = await decodeWith(
    $,
    `mkdir -p ${quote(TMP_DIR)} && sips ${quote(absPath)} -Z 800 --out ${quote(png)} 2>/dev/null`,
    png,
  );
  imgCache.set(absPath, result || "fail");
  return result || "fail";
}

// Decode a pasted picture (base64 from the transcript) the same way. A paste
// is the person's own content, so it goes to a directory only they can read
// ($HOME/.cache/image-preview, mode 700, refused if not theirs or a symlink),
// never the shared /tmp one; no HOME, no thumbnail.
async function decodePaste($, paste, home) {
  const { key } = paste;
  if (imgCache.has(key)) return imgCache.get(key);
  if (!home) return "fail";
  const dir = `${home}/.cache/image-preview`;
  const name = `${dir}/paste-${key}`;
  const png = `${name}.png`;
  const result = await decodeWith(
    $,
    `umask 077 && mkdir -p ${quote(dir)} && [ -O ${quote(dir)} ] && [ ! -L ${quote(dir)} ] && chmod 700 ${quote(dir)} && ` +
      `/usr/bin/base64 -D -o ${quote(name)}.src && ` +
      `sips ${quote(`${name}.src`)} -s format png -Z 800 --out ${quote(png)} >/dev/null 2>&1; ` +
      `s=$?; rm -f ${quote(`${name}.src`)}; [ $s -eq 0 ]`,
    png,
    paste.data,
  );
  imgCache.set(key, result || "fail");
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

// The image references in text, in document order: real paths and paste
// tokens alike. The row's text is never rewritten, so nothing here carries the
// surrounding prose.
function imageRefs(text, cwd, home) {
  if (!text || typeof text !== "string") return [];
  const refs = [];
  const quoted = []; // [start, end) of each quoted path, which PATH_RE skips
  let m;
  QUOTED_RE.lastIndex = 0;
  while ((m = QUOTED_RE.exec(text))) {
    // Several paths in one quoted span are prose, not one path: leave them
    // to PATH_RE.
    if (/\.(?:png|jpg|jpeg|gif|webp|bmp|tif(?:f)?|heic|heif|ico|svg)\s/i.test(m[2])) continue;
    quoted.push([m.index, m.index + m[0].length]);
    const abs = resolvePath(m[2], cwd, home);
    if (abs) refs.push({ at: m.index, abs, label: basename(m[2]) });
  }
  PATH_RE.lastIndex = 0;
  while ((m = PATH_RE.exec(text))) {
    const at = m.index;
    if (quoted.some(([s, e]) => at >= s && at < e)) continue;
    const path = m[1].replace(/\\(.)/g, "$1");
    const abs = resolvePath(path, cwd, home);
    if (abs) refs.push({ at, abs, label: basename(path) });
  }
  REF_RE.lastIndex = 0;
  while ((m = REF_RE.exec(text))) {
    refs.push({ at: m.index, abs: null, num: parseInt(m[1], 10), label: `[Image #${m[1]}]` });
  }
  return refs.sort((a, b) => a.at - b.at);
}

// Learn the pictures behind [Image #N] tokens from the transcript: in a user
// message the engine puts one base64 image block per token, in token order.
// A message whose tokens and images do not pair up one to one (a token typed
// by hand) teaches nothing, so a token never draws someone else's picture.
async function learnPastes($) {
  let messages;
  try {
    messages = await $.session.messages({ as: "api" });
  } catch {
    return;
  }
  if (!Array.isArray(messages)) return;
  for (const msg of messages) {
    if (msg?.role !== "user" || !Array.isArray(msg.content)) continue;
    const text = msg.content.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("\n");
    const images = msg.content.filter((b) => b?.type === "image" && b.source?.type === "base64" && b.source.data);
    const nums = [...text.matchAll(REF_RE)].map((t) => parseInt(t[1], 10));
    if (!nums.length || nums.length !== images.length) continue;
    nums.forEach((n, i) => {
      if (pastes.has(n)) return;
      const data = images[i].source.data;
      pastes.set(n, { data, key: `${hash(data)}-${data.length}` });
    });
  }
}

// One thumbnail per resolvable reference, in document order.
async function collectThumbs($, text, C) {
  const cwd = (await $.session.cwd().catch(() => "/")).trim();
  const home = await $.env.get("HOME").catch(() => undefined);
  const refs = imageRefs(text, cwd, home);
  // Read the transcript only for a paste not yet learned, and retry one it
  // lacked (a token typed by hand, a row drawn before its message is stored)
  // at most every PASTE_RETRY_MS, not on every redraw.
  const now = Date.now();
  const missing = refs.filter((r) => r.abs === null && !pastes.has(r.num));
  if (missing.some((r) => !(now - (pasteMisses.get(r.num) ?? -Infinity) < PASTE_RETRY_MS))) {
    await learnPastes($);
    for (const r of missing) if (!pastes.has(r.num)) pasteMisses.set(r.num, now);
  }
  const nodes = [];
  for (const ref of refs) {
    let decoded;
    if (ref.abs !== null) decoded = await decode($, ref.abs);
    else if (pastes.has(ref.num)) decoded = await decodePaste($, pastes.get(ref.num), home);
    if (!decoded || decoded === "fail") continue;
    const path = decoded.file;
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

// The mod's state: { render: boolean } — defaults to true. Some render passes read state before it is available (the raw
// answer comes back { version } with no value), which would flicker the
// thumbnails; remember the last successfully read state and fall back to it.
let lastState = { render: true };

async function loadState($) {
  try {
    const { value } = await $.state.get(NS);
    const st = value?.state;
    if (st && typeof st === "object") lastState = { render: st.render !== false };
  } catch {}
  return lastState;
}

function saveState($, state) {
  lastState = state; // immediate consistency; the next read re-confirms
  return $.state.set(NS, { state });
}

// Shared render body for both row types: the engine's own block, untouched —
// identical to a no-image row — with the thumbnails appended below it.
async function renderRow($, e, next) {
  const state = await loadState($);
  if (!state.render) return next(e); // off: a complete no-op

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

  // /image-preview on|off toggles thumbnails for the session.
  on("session.start", async ($, e, next) => {
    const r = await next(e);
    try {
      await $.command.register({
        name: "image-preview",
        description: "Turn inline image thumbnails on or off for this session.",
        argumentHint: "<on | off>",
      });
    } catch {
      // already registered after a hot reload
    }
    return r;
  });

  on("command.run", async ($, e, next) => {
    if (e?.command !== "image-preview") return next(e);
    const arg = (e?.args ?? "").trim();
    if (/^(on|off)$/.test(arg)) {
      const render = arg === "on";
      await saveState($, { render });
      return { text: `image-preview rendering ${render ? "on" : "off"}.` };
    }
    const { render } = await loadState($);
    return { text: `image-preview rendering is ${render ? "on" : "off"}; /image-preview on|off toggles it.` };
  });
}
