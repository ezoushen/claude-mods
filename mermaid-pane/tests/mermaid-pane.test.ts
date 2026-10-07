import { describe, expect, test } from "claude-code/testing";

const REPLY = "intro line\n```mermaid\nflowchart LR\n  A[Start] --> B[End]\n```";
const REPLY_EDGES = "```mermaid\nflowchart LR\n  P[Phone] --> W[WiFi Router] --> N[Internet]\n```";
const SECRET = "SECRET_DIAGRAM_PAYLOAD_XYZ";
// beautiful-mermaid art for REPLY_EDGES that shows every node it names.
const BM_ART = "[BM ART] Phone ──▶ WiFi Router ──▶ Internet";
const REPLY_SECRET = "```mermaid\nflowchart LR\n  A[" + SECRET + "] --> B[End]\n```";

// In-memory $.state backing (mode is the session value).
const mem: Record<string, unknown> = {};
// In-memory $.store backing (mode + external persist here, durable).
const store: Record<string, unknown> = {};
const stateKey = (e: { plugin: string; key: string }) => `${e.plugin}:${e.key}`;
const defaults: Record<string, unknown> = {
  "mermaid-pane:mode": "ascii",
};

const ROW = {
  surface: "terminal" as const,
  component: "AssistantMessage" as const,
  viewport: { columns: 140, rows: 44 },
};

type AnyHook = (...args: any[]) => unknown;
// Commands the setup path detached (asserted per test).
let setupRuns: string[] = [];
// Every process.run payload, for asserting zero mermaid.ink traffic.
let processRuns: string[] = [];
// Local mmdc render payloads (not probes), for counting renders.
let renderRuns: string[] = [];
// termaid render payloads.
let termaidRuns: string[] = [];
// Toasts the mod raised.
let toasts: string[] = [];
// beautiful-mermaid render payloads.
let bmRuns: string[] = [];

type StubOpts = {
  png?: boolean;
  present?: string[];
  /** Simulate local mmdc success (sips metadata without mermaid.ink). */
  localPng?: boolean;
  /** Local mmdc present but exits nonzero. */
  localFail?: boolean;
  /** Local mmdc present but returns exit 124 (timeout). */
  localTimeout?: boolean;
  /** Local mmdc present, exit 0, but no pixel metadata. */
  localBadMeta?: boolean;
  /** Remote curl/sips fails even when external is on. */
  remoteFail?: boolean;
  /** The first N local renders are cut mid-run, as a superseded draw's are. */
  abortRenders?: number;
  /** The first `times` commands matching `match` are cut mid-run. */
  cut?: { match: (s: string) => boolean; times: number };
  /** beautiful-mermaid is installed (runtime + package + runner); what it prints. */
  bmArt?: string;
  /** The beautiful-mermaid run exits nonzero (a parse error). */
  bmFails?: boolean;
  /** The system `open` exits nonzero (no viewer, not macOS). */
  openFails?: boolean;
  /** The mmdc probe and each local render take this long (real time). */
  slowRenderMs?: number;
  /** Local renders are killed by $.process.run's own timeout. */
  runTimeout?: boolean;
  /** Local renders of a chart holding this text exit nonzero. */
  failMarker?: string;
  /** What termaid prints for every chart (it must be present). */
  termaidArt?: string;
};

function isInkRequest(s: string) {
  return s.includes("mermaid.ink");
}

function stubWorld(on: (event: string, hook: AnyHook) => void, opts: StubOpts = {}) {
  setupRuns = [];
  processRuns = [];
  renderRuns = [];
  termaidRuns = [];
  toasts = [];
  bmRuns = [];
  on("ui.toast", (_$: unknown, e: { text: string }) => {
    toasts.push(e.text);
    return { value: undefined };
  });
  on("session.start", () => ({ cwd: "/work" }));
  on("session.messages", () => ({ value: [] }));
  on("state.get", (_$: unknown, e: { plugin: string; key: string }) => {
    const k = stateKey(e);
    if (!(k in mem) && !(k in defaults)) throw new Error("DBG state.get " + JSON.stringify(e));
    return { value: { value: mem[k] ?? defaults[k], version: 0 } };
  });
  on("state.set", (_$: unknown, e: { plugin: string; key: string; value: unknown }) => {
    mem[stateKey(e)] = e.value;
    return { value: { isSet: true, version: 0 } };
  });
  on("store.get", (_$: unknown, e: { key: string }) => ({ value: store[e.key] }));
  on("store.set", (_$: unknown, e: { key: string; value: unknown }) => {
    store[e.key] = e.value;
    return { value: undefined };
  });
  on("command.register", () => ({ value: { command: "mermaid" } }));
  on("ui.invalidate", (_$: unknown, e: unknown, next: (e: unknown) => unknown) => next(e));
  // real-time sleep: a draw waiting on a shared render bounds its wait with it
  on("clock.sleep", (_$: unknown, e: { ms: number }) => new Promise((resolve) => setTimeout(() => resolve({ value: undefined }), e.ms)));
  on("process.run", (_$: unknown, cmd: unknown) => {
    const s = JSON.stringify(cmd);
    processRuns.push(s);
    if (s.includes("beautiful-mermaid") && s.includes("render.mjs") && !s.includes("printf") && !s.includes("nohup")) {
      // probe: the runtime that runs the installed renderer
      const ok = opts.bmArt !== undefined;
      return { value: { exitCode: ok ? 0 : 1, stdout: ok ? "/usr/bin/bun" : "" } };
    }
    if (s.includes("render.mjs") && s.includes("printf") && !s.includes("nohup")) {
      bmRuns.push(s);
      return { value: { exitCode: opts.bmFails ? 1 : 0, stdout: opts.bmFails ? "" : opts.bmArt ?? "" } };
    }
    if (s.includes('"argv":["open"')) return { value: { exitCode: opts.openFails ? 1 : 0, stdout: "", stderr: "" } };
    if (opts.cut && opts.cut.times > 0 && opts.cut.match(s)) {
      opts.cut.times--;
      return { deny: "aborted" };
    }
    if (s.includes("mmdc") && s.includes("-i ")) {
      renderRuns.push(s);
      if (renderRuns.length <= (opts.abortRenders ?? 0)) {
        // rejects the call as the host cuts a superseded draw's command
        return { deny: "aborted" };
      }
      if (opts.slowRenderMs) {
        const done = { value: { exitCode: 0, stdout: "pixelWidth: 876\npixelHeight: 196" } };
        return new Promise((resolve) => setTimeout(() => resolve(done), opts.slowRenderMs));
      }
      if (opts.runTimeout) {
        // the host's wording when timeoutMs runs out
        return { deny: "aborted: still running after 60000ms" };
      }
      if (opts.failMarker && s.includes(opts.failMarker)) {
        return { value: { exitCode: 1, stdout: "", stderr: "boom" } };
      }
    }
    if (opts.termaidArt !== undefined && s.includes("termaid") && s.includes("--width")) {
      termaidRuns.push(s);
      return { value: { exitCode: 0, stdout: opts.termaidArt } };
    }
    if (s.includes("home:$HOME")) return { value: { exitCode: 0, stdout: "home:/Users/u\n" } };
    if (s.includes("command -v bun") && s.includes("command -v npm")) {
      const p = opts.present ?? [];
      const ok = p.includes("bun") || p.includes("npm");
      return { value: { exitCode: ok ? 0 : 1, stdout: ok ? "/usr/bin/runtime" : "" } };
    }
    if (s.includes("nohup")) {
      setupRuns.push(s);
      return { value: { exitCode: 0, stdout: "started" } };
    }
    // which-style probes (command -v …)
    const which = /command -v ([a-z0-9-]+)/.exec(s);
    if (which && which[1] && !s.includes("mmdc") && !s.includes("timeout") && !s.includes("printf")) {
      const bin = which[1];
      const present = opts.present ?? [];
      return {
        value: {
          exitCode: present.includes(bin) ? 0 : 1,
          stdout: present.includes(bin) ? `/usr/bin/${bin}` : "",
        },
      };
    }
    // mmdc / local render path (probe or render). Detect probe vs render carefully.
    if (s.includes("mmdc") && !s.includes("-i ") && !s.includes("timeout")) {
      // whichSh("mmdc") probe
      const present = (opts.present ?? []).includes("mmdc") || opts.localPng || opts.localFail || opts.localTimeout || opts.localBadMeta;
      const probe = {
        value: {
          exitCode: present ? 0 : 1,
          stdout: present ? "/usr/bin/mmdc" : "",
        },
      };
      if (opts.slowRenderMs) return new Promise((resolve) => setTimeout(() => resolve(probe), opts.slowRenderMs));
      return probe;
    }
    if (s.includes("mermaid.ink") || (s.includes("curl") && s.includes("mermaid"))) {
      if (opts.remoteFail) return { value: { exitCode: 1, stdout: "", stderr: "fail" } };
      if ((opts.png || store["external"] === "on") && !opts.remoteFail) {
        // SVG sizing or image fetch — image path still needs sips metadata afterward
        if (s.includes("sips")) {
          return { value: { exitCode: 0, stdout: "pixelWidth: 876\npixelHeight: 196" } };
        }
        return { value: { exitCode: 0, stdout: 'viewBox="0 0 800 200" max-width: 800px' } };
      }
      return { value: { exitCode: 1, stdout: "", stderr: "" } };
    }
    if (opts.localPng && s.includes("sips") && (s.includes("mmdc") || s.includes(".png"))) {
      return { value: { exitCode: 0, stdout: "pixelWidth: 876\npixelHeight: 196" } };
    }
    if (opts.localTimeout && s.includes("mmdc")) {
      return { value: { exitCode: 124, stdout: "", stderr: "" } };
    }
    if (opts.localFail && s.includes("mmdc")) {
      return { value: { exitCode: 1, stdout: "", stderr: "boom" } };
    }
    if (opts.localBadMeta && s.includes("mmdc")) {
      return { value: { exitCode: 0, stdout: "no-dimensions-here" } };
    }
    if (opts.png && s.includes("sips")) {
      return { value: { exitCode: 0, stdout: "pixelWidth: 876\npixelHeight: 196" } };
    }
    if (opts.png && s.includes("curl")) return { value: { exitCode: 0, stdout: "" } };
    // Generic which for termaid / npm / timeout
    const m = /command -v ([a-z0-9-]+)/.exec(s);
    if (m && m[1]) {
      const present = opts.present ?? [];
      // Always pretend timeout exists so the local bound path is exercised when mmdc runs
      if (m[1] === "timeout") return { value: { exitCode: 0, stdout: "/usr/bin/timeout" } };
      return {
        value: {
          exitCode: present.includes(m[1]) ? 0 : 1,
          stdout: present.includes(m[1]) ? `/usr/bin/${m[1]}` : "",
        },
      };
    }
    return { value: { exitCode: 1, stdout: "", stderr: "" } };
  });
}

function inkRequestCount() {
  return processRuns.filter(isInkRequest).length;
}

function callMermaid($: any, args: string) {
  return $.command.run({
    command: "mermaid",
    args,
    origin: { kind: "composer" },
    presentation: { isFullscreen: false, columns: 120 },
  });
}

// Beneath-hooks register before the first $ call; the echo only answers when
// the mod passes the row through (it shouldn't in image mode).
function echoRow(on: (event: string, hook: AnyHook) => void) {
  on("ui.render", (_$: unknown, e: any) => ({
    type: "Text",
    props: {},
    children: [String(e?.props?.text ?? "")],
  }));
}

async function mountRow($: any, text: string) {
  return $.ui.mount({ plugin: "mermaid-pane", ...ROW, props: { text, isFirstOfReply: true } });
}

function resetMem() {
  for (const k of Object.keys(mem)) delete mem[k];
  for (const k of Object.keys(store)) delete store[k];
}

describe("mermaid-pane", () => {
  test("/mermaid sets the mode in state and store", async ($, on) => {
    resetMem();
    stubWorld(on);
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });

    expect((await callMermaid($, "image")).text).toMatch(/image mode/i);
    expect(mem["mermaid-pane:mode"]).toBe("image");
    expect(store["mode"]).toBe("image");
    expect((await callMermaid($, "ascii")).text).toMatch(/ascii mode/i);
    expect(mem["mermaid-pane:mode"]).toBe("ascii");
    expect(store["mode"]).toBe("ascii");
    // bare /mermaid reports the current mode and that external defaults OFF
    const bare = (await callMermaid($, "")).text;
    expect(bare).toMatch(/ascii mode/);
    expect(bare).toMatch(/external OFF/i);
  });

  test("ascii mode rewrites each mermaid fence into uncut edge art", async ($, on) => {
    resetMem();
    echoRow(on);
    stubWorld(on); // no termaid → built-in edge art
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });

    const ui = await mountRow($, REPLY_EDGES);
    // every edge of a single-line chain, full labels, nothing cut
    expect(await ui.find({ type: "Text", text: /P\[Phone\] ──▶ W\[WiFi Router\]/ })).toBeDefined();
    expect(await ui.find({ type: "Text", text: /W\[WiFi Router\] ──▶ N\[Internet\]/ })).toBeDefined();
    // the source fence is gone — rewritten in place
    expect(await ui.find({ type: "Text", text: /```mermaid/ })).not.toBeDefined();
    expect(inkRequestCount()).toBe(0);
  });

  test("termaid art wider than the reply falls back to edge art after one try", async ($, on) => {
    resetMem();
    echoRow(on);
    // termaid already compacts to --width; what still overflows cannot be fixed by retrying
    stubWorld(on, { present: ["termaid"], termaidArt: "─".repeat(400) });
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });

    const ui = await mountRow($, REPLY_EDGES);
    expect(await ui.find({ type: "Text", text: /P\[Phone\] ──▶ W\[WiFi Router\]/ })).toBeDefined();
    expect(termaidRuns.length).toBe(1);
  });

  test("edge art shows <br/> line breaks in labels as spaces", async ($, on) => {
    resetMem();
    echoRow(on);
    stubWorld(on); // no termaid → built-in edge art
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });

    const ui = await mountRow($, "```mermaid\nflowchart LR\n  A[Hot Patch feed<br/>per locale] -->|that locale,<br>then refresh| B[End]\n```");
    expect(await ui.find({ type: "Text", text: /A\[Hot Patch feed per locale\] ──▶ B\[End\] \|that locale, then refresh\|/ })).toBeDefined();
    expect(await ui.find({ type: "Text", text: /<br/ })).not.toBeDefined();
  });

  for (const [what, match] of [
    ["probe", (s: string) => s.includes("command -v termaid")],
    ["run", (s: string) => s.includes("termaid") && s.includes("--width")],
  ] as const) {
    test(`a cut termaid ${what} does not pin a chart to edge art`, async ($, on) => {
      resetMem();
      echoRow(on);
      stubWorld(on, { present: ["termaid"], termaidArt: "[TERMAID ART]", cut: { match, times: 1 } });
      await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });

      const ui = await mountRow($, REPLY_EDGES);
      await ui.redraw();
      expect(await ui.find({ type: "Text", text: /\[TERMAID ART\]/ })).toBeDefined();
    });
  }

  test("ascii mode prefers beautiful-mermaid art for the types it draws", async ($, on) => {
    resetMem();
    echoRow(on);
    stubWorld(on, { present: ["termaid"], termaidArt: "[TERMAID ART]", bmArt: BM_ART });
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });

    const ui = await mountRow($, REPLY_EDGES);
    expect(await ui.find({ type: "Text", text: /\[BM ART\]/ })).toBeDefined();
    expect(termaidRuns.length).toBe(0);
  });

  for (const [why, opts] of [
    ["is wider than the reply", { bmArt: "─".repeat(400) }],
    ["fails", { bmArt: "[BM ART]", bmFails: true }],
  ] as const) {
    test(`beautiful-mermaid art that ${why} falls to termaid`, async ($, on) => {
      resetMem();
      echoRow(on);
      stubWorld(on, { present: ["termaid"], termaidArt: "[TERMAID ART]", ...opts });
      await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });

      const ui = await mountRow($, REPLY_EDGES);
      expect(await ui.find({ type: "Text", text: /\[TERMAID ART\]/ })).toBeDefined();
      expect(bmRuns.length).toBe(1);
    });
  }

  test("a renderer /mermaid setup finds is used without a reload", async ($, on) => {
    resetMem();
    echoRow(on);
    const opts: StubOpts = { present: ["termaid"], termaidArt: "[TERMAID ART]" };
    stubWorld(on, opts);
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });

    const ui = await mountRow($, REPLY_EDGES); // beautiful-mermaid not installed yet
    expect(await ui.find({ type: "Text", text: /\[TERMAID ART\]/ })).toBeDefined();
    opts.bmArt = BM_ART; // the background install finished
    await callMermaid($, "setup"); // the re-run that reports it
    await ui.redraw();
    expect(await ui.find({ type: "Text", text: /\[BM ART\]/ })).toBeDefined();
  });

  test("beautiful-mermaid art that drops a node falls to termaid", async ($, on) => {
    resetMem();
    echoRow(on);
    // 1.1.3 reads `A-->B` (no spaces) as one box "A--" and still exits 0
    stubWorld(on, { present: ["termaid"], termaidArt: "[TERMAID ART]", bmArt: "┌─────┐\n│ A-- │\n└─────┘" });
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });

    const ui = await mountRow($, "```mermaid\ngraph TD\nA-->B\n```");
    expect(await ui.find({ type: "Text", text: /\[TERMAID ART\]/ })).toBeDefined();
    expect(bmRuns.length).toBe(1);
  });

  test("types beautiful-mermaid does not draw go straight to termaid", async ($, on) => {
    resetMem();
    echoRow(on);
    stubWorld(on, { present: ["termaid"], termaidArt: "[TERMAID ART]", bmArt: "[BM ART]" });
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });

    const ui = await mountRow($, "```mermaid\ngantt\n  title Release\n  Design :a1, 2026-01-01, 5d\n```");
    expect(await ui.find({ type: "Text", text: /\[TERMAID ART\]/ })).toBeDefined();
    expect(bmRuns.length).toBe(0);
  });

  test("rows without mermaid blocks pass through untouched", async ($, on) => {
    resetMem();
    echoRow(on);
    stubWorld(on);
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });

    const ui = await mountRow($, "just a plain answer");
    expect(await ui.find({ type: "Text", text: /just a plain answer/ })).toBeDefined();
  });

  test("saved image mode does not enable external; missing mmdc makes zero ink requests", async ($, on) => {
    resetMem();
    echoRow(on);
    stubWorld(on);
    // Upgrade path: prior install had image mode saved, never opted into external
    mem["mermaid-pane:mode"] = "image";
    store["mode"] = "image";
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });

    const ui = await mountRow($, REPLY_SECRET);
    expect(await ui.find({ type: "Image" })).not.toBeDefined();
    // ASCII art may show node labels; the diagnostic parenthesis must not leak source/URLs
    const diagNode = await ui.find({ type: "Text", text: /Remote mermaid\.ink is off/ });
    expect(diagNode).toBeDefined();
    const full = String((diagNode as any)?.text ?? (diagNode as any)?.children?.[0] ?? "");
    const diagOnly = full.includes("(") ? full.slice(full.lastIndexOf("(")) : full;
    expect(diagOnly).not.toMatch(new RegExp(SECRET));
    expect(diagOnly).not.toMatch(/mermaid\.ink\/(img|svg)/);
    expect(inkRequestCount()).toBe(0);
    expect(store["external"]).not.toBe("on");
    for (const s of processRuns) {
      expect(s).not.toMatch(/mermaid\.ink/);
    }
  });

  test("local mmdc nonzero exit: zero external requests when OFF", async ($, on) => {
    resetMem();
    echoRow(on);
    stubWorld(on, { localFail: true, present: ["mmdc"] });
    mem["mermaid-pane:mode"] = "image";
    store["mode"] = "image";
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });
    const ui = await mountRow($, REPLY);
    expect(await ui.find({ type: "Image" })).not.toBeDefined();
    expect(inkRequestCount()).toBe(0);
    expect(await ui.find({ type: "Text", text: /Local PNG render failed/ })).toBeDefined();
  });

  test("local mmdc timeout: zero external requests when OFF", async ($, on) => {
    resetMem();
    echoRow(on);
    stubWorld(on, { localTimeout: true, present: ["mmdc"] });
    mem["mermaid-pane:mode"] = "image";
    store["mode"] = "image";
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });
    const ui = await mountRow($, REPLY);
    expect(await ui.find({ type: "Image" })).not.toBeDefined();
    expect(inkRequestCount()).toBe(0);
    expect(await ui.find({ type: "Text", text: /timed out/ })).toBeDefined();
  });

  test("local mmdc bad PNG metadata: zero external requests when OFF", async ($, on) => {
    resetMem();
    echoRow(on);
    stubWorld(on, { localBadMeta: true, present: ["mmdc"] });
    mem["mermaid-pane:mode"] = "image";
    store["mode"] = "image";
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });
    const ui = await mountRow($, REPLY);
    expect(await ui.find({ type: "Image" })).not.toBeDefined();
    expect(inkRequestCount()).toBe(0);
    expect(await ui.find({ type: "Text", text: /bad image metadata/ })).toBeDefined();
  });

  test("successful local PNG: zero external requests regardless of external setting", async ($, on) => {
    resetMem();
    echoRow(on);
    stubWorld(on, { localPng: true, present: ["mmdc"] });
    mem["mermaid-pane:mode"] = "image";
    store["mode"] = "image";
    store["external"] = "on"; // even when opted in, local success must stay offline
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });

    const ui = await mountRow($, REPLY);
    expect(await ui.find({ type: "Markdown", text: /intro line/ })).toBeDefined();
    expect(await ui.find({ type: "Image" })).toBeDefined();
    expect(inkRequestCount()).toBe(0);
  });

  test("a local render cut by a superseded draw does not poison later draws", async ($, on) => {
    resetMem();
    echoRow(on);
    stubWorld(on, { localPng: true, present: ["mmdc"], abortRenders: 1 });
    mem["mermaid-pane:mode"] = "image";
    store["mode"] = "image";
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });

    const ui = await mountRow($, REPLY);
    // the cut draw is not a failure: no failure note
    expect(await ui.find({ type: "Text", text: /render failed/ })).not.toBeDefined();
    await ui.redraw();
    expect(await ui.find({ type: "Image" })).toBeDefined();
    expect(renderRuns.length).toBe(2);
  });

  test("overlapping draws of one chart share a single local render", async ($, on) => {
    resetMem();
    echoRow(on);
    stubWorld(on, { localPng: true, present: ["mmdc"] });
    mem["mermaid-pane:mode"] = "image";
    store["mode"] = "image";
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });

    const [a, b] = await Promise.all([mountRow($, REPLY), mountRow($, REPLY)]);
    expect(await a.find({ type: "Image" })).toBeDefined();
    expect(await b.find({ type: "Image" })).toBeDefined();
    expect(renderRuns.length).toBe(1);
  });

  test("a draw waiting on a render that gets cut renders for itself", async ($, on) => {
    resetMem();
    echoRow(on);
    stubWorld(on, { localPng: true, present: ["mmdc"], abortRenders: 1 });
    mem["mermaid-pane:mode"] = "image";
    store["mode"] = "image";
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });

    const [cut, waiting] = await Promise.all([mountRow($, REPLY), mountRow($, REPLY)]);
    expect(await waiting.find({ type: "Image" })).toBeDefined();
    expect(await cut.find({ type: "Text", text: /render failed/ })).not.toBeDefined();
    expect(renderRuns.length).toBe(2);
  });

  test("without a clock a failed chart stays failed instead of re-rendering every draw", async ($, on) => {
    resetMem();
    echoRow(on);
    on("clock.now", () => ({ value: 0 }));
    const opts: StubOpts = { localFail: true, present: ["mmdc"] };
    stubWorld(on, opts);
    mem["mermaid-pane:mode"] = "image";
    store["mode"] = "image";
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });

    const ui = await mountRow($, REPLY);
    opts.localFail = false;
    opts.localPng = true;
    await ui.redraw();
    await ui.redraw();
    expect(await ui.find({ type: "Text", text: /Local PNG render failed/ })).toBeDefined();
    expect(renderRuns.length).toBe(1);
  });

  test("a draw waiting on a slow shared render falls back within its budget, then upgrades", { timeoutMs: 30_000 }, async ($, on) => {
    resetMem();
    echoRow(on);
    // probe + render: 12 s, longer than a waiting draw's 10 s hook budget
    stubWorld(on, { localPng: true, present: ["mmdc"], slowRenderMs: 6_000 });
    mem["mermaid-pane:mode"] = "image";
    store["mode"] = "image";
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });

    const [owner, waiter] = await Promise.all([mountRow($, REPLY), mountRow($, REPLY)]);
    expect(await owner.find({ type: "Image" })).toBeDefined();
    // the waiter's hook ran to completion: never the raw fence of a skipped hook
    expect(await waiter.find({ type: "Text", text: /```mermaid/ })).not.toBeDefined();
    // once the shared render landed, the waiter's row redrew with it
    expect(await waiter.find({ type: "Image" })).toBeDefined();
    expect(renderRuns.length).toBe(1);
  });

  test("a local render killed by the process timeout counts as timed out", async ($, on) => {
    resetMem();
    echoRow(on);
    stubWorld(on, { runTimeout: true, present: ["mmdc"] });
    mem["mermaid-pane:mode"] = "image";
    store["mode"] = "image";
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });

    const ui = await mountRow($, REPLY);
    expect(await ui.find({ type: "Text", text: /Local PNG render timed out/ })).toBeDefined();
    await ui.redraw(); // inside the retry window: no second 60 s render
    expect(renderRuns.length).toBe(1);
  });

  test("a cut mermaid-cli probe is not remembered as mermaid-cli missing", async ($, on) => {
    resetMem();
    echoRow(on);
    const isProbe = (s: string) => s.includes("command -v mmdc") && !s.includes("-i ");
    stubWorld(on, { localPng: true, present: ["mmdc"], cut: { match: isProbe, times: 1 } });
    mem["mermaid-pane:mode"] = "image";
    store["mode"] = "image";
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });

    const ui = await mountRow($, REPLY);
    expect(await ui.find({ type: "Text", text: /not found/ })).not.toBeDefined();
    await ui.redraw();
    expect(await ui.find({ type: "Image" })).toBeDefined();
  });

  test("a failed local render retries once the retry window passes", async ($, on) => {
    resetMem();
    echoRow(on);
    let nowMs = 1_000_000;
    on("clock.now", () => ({ value: nowMs }));
    const opts: StubOpts = { localFail: true, present: ["mmdc"] };
    stubWorld(on, opts);
    mem["mermaid-pane:mode"] = "image";
    store["mode"] = "image";
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });

    const ui = await mountRow($, REPLY);
    expect(await ui.find({ type: "Text", text: /Local PNG render failed/ })).toBeDefined();
    opts.localFail = false;
    opts.localPng = true; // the cause went away (e.g. Chromium finished installing)

    await ui.redraw(); // inside the window: no new render, the note stays
    expect(await ui.find({ type: "Image" })).not.toBeDefined();
    expect(await ui.find({ type: "Text", text: /Local PNG render failed/ })).toBeDefined();
    expect(renderRuns.length).toBe(1);

    nowMs += 61_000;
    await ui.redraw();
    expect(await ui.find({ type: "Image" })).toBeDefined();
    expect(renderRuns.length).toBe(2);
  });

  test("a failed chart keeps its own note after another chart renders", async ($, on) => {
    resetMem();
    echoRow(on);
    stubWorld(on, { localPng: true, present: ["mmdc"], failMarker: "Broken" });
    mem["mermaid-pane:mode"] = "image";
    store["mode"] = "image";
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });

    const bad = await mountRow($, "```mermaid\nflowchart LR\n  A[Broken] --> B[End]\n```");
    expect(await bad.find({ type: "Text", text: /Local PNG render failed/ })).toBeDefined();
    const good = await mountRow($, REPLY);
    expect(await good.find({ type: "Image" })).toBeDefined();
    await bad.redraw();
    expect(await bad.find({ type: "Text", text: /Local PNG render failed/ })).toBeDefined();
  });

  test("the local render's process timeout outlasts its own 45 s bound", async ($, on) => {
    resetMem();
    echoRow(on);
    stubWorld(on, { localPng: true, present: ["mmdc"] });
    mem["mermaid-pane:mode"] = "image";
    store["mode"] = "image";
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });

    await mountRow($, REPLY);
    expect(renderRuns.length).toBe(1);
    // the default 30 s would kill mmdc before `timeout 45` can report it
    const ms = Number(/"timeoutMs":(\d+)/.exec(renderRuns[0] ?? "")?.[1]);
    expect(ms).toBeGreaterThan(45_000);
  });

  test("image mode draws the reply's prose as markdown (tables, code spans)", async ($, on) => {
    resetMem();
    echoRow(on);
    stubWorld(on, { localPng: true, present: ["mmdc"] });
    mem["mermaid-pane:mode"] = "image";
    store["mode"] = "image";
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });

    const table = "| Caller | Hot Patch |\n| --- | --- |\n| `L10n.*` | ✅ |";
    const ui = await mountRow($, `${table}\n\n${REPLY}\n\nafter the chart`);
    expect(await ui.find({ type: "Markdown", text: /\| Caller \| Hot Patch \|/ })).toBeDefined();
    expect(await ui.find({ type: "Markdown", text: /after the chart/ })).toBeDefined();
    expect(await ui.find({ type: "Text", text: /\| Caller/ })).not.toBeDefined();
    expect(await ui.find({ type: "Image" })).toBeDefined();
  });

  test("each chart image has a button that opens the full-size PNG", async ($, on) => {
    resetMem();
    echoRow(on);
    stubWorld(on, { localPng: true, present: ["mmdc"] });
    mem["mermaid-pane:mode"] = "image";
    store["mode"] = "image";
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });

    const ui = await mountRow($, REPLY);
    const button = (await ui.find({ type: "Button", text: /open full size/ })) as any;
    expect(button).toBeDefined();
    processRuns = [];
    await ui.press({ key: button.key });
    // the PNG mmdc rendered, by argv — no shell, nothing of the source
    expect(processRuns.some((s) => /"argv":\["open","\/Users\/u\/\.cache\/mermaid-pane\/d[0-9a-z]+\.png"\]/.test(s))).toBe(true);
    expect(toasts).toEqual([]);
  });

  test("a full-size open that fails says so", async ($, on) => {
    resetMem();
    echoRow(on);
    stubWorld(on, { localPng: true, present: ["mmdc"], openFails: true });
    mem["mermaid-pane:mode"] = "image";
    store["mode"] = "image";
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });

    const ui = await mountRow($, REPLY);
    const button = (await ui.find({ type: "Button", text: /open full size/ })) as any;
    await ui.press({ key: button.key });
    expect(toasts.some((t) => /could not open/.test(t))).toBe(true);
  });

  test("every command the mod runs starts in / — never the session's (maybe untrusted) repo", async ($, on) => {
    resetMem();
    echoRow(on);
    // a repo's bunfig.toml `preload` or .puppeteerrc.cjs would run when bun/mmdc start there
    stubWorld(on, { localPng: true, present: ["mmdc", "termaid"], termaidArt: "[TERMAID ART]", bmArt: BM_ART });
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });

    await mountRow($, REPLY_EDGES); // ascii: beautiful-mermaid
    await mountRow($, "```mermaid\ngantt\n  Design :a1, 2026-01-01, 5d\n```"); // ascii: termaid
    await callMermaid($, "image");
    const ui = await mountRow($, REPLY); // image: mmdc
    const button = (await ui.find({ type: "Button", text: /open full size/ })) as any;
    await ui.press({ key: button.key });
    await callMermaid($, "setup");
    expect(processRuns.length).toBeGreaterThan(5);
    for (const s of processRuns) expect(s).toContain('"cwd":"/"');
  });

  test("rendered files and install scripts live in a private per-user dir, never shared /tmp", async ($, on) => {
    resetMem();
    echoRow(on);
    // missing mmdc + external on: the mermaid.ink path writes too; setup starts installs
    stubWorld(on, { png: true, present: ["npm", "python3"] });
    mem["mermaid-pane:mode"] = "image";
    store["mode"] = "image";
    store["external"] = "on";
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });

    await mountRow($, REPLY);
    await callMermaid($, "setup");
    expect(setupRuns.length).toBeGreaterThan(0);
    // /tmp is shared: another local user could pre-create a dir there (plant files or block it)
    for (const s of processRuns) expect(s).not.toContain("/tmp/mermaid-pane");
    const dir = "/Users/u/.cache/mermaid-pane";
    const touching = processRuns.filter((s) => s.includes(`${dir}/`));
    expect(touching.some((s) => s.includes("mermaid.ink"))).toBe(true);
    expect(touching.some((s) => s.includes("nohup"))).toBe(true);
    for (const s of touching) {
      // defence in depth: verified ours, not a symlink, private — before first use
      const guard = s.indexOf(`[ -O '${dir}' ]`);
      expect(guard).toBeGreaterThan(-1);
      expect(s.indexOf(`! -L '${dir}'`)).toBeGreaterThan(-1);
      expect(guard).toBeLessThan(s.indexOf(`${dir}/`));
    }
  });

  test("explicit opt-in enables mermaid.ink fallback", async ($, on) => {
    resetMem();
    echoRow(on);
    stubWorld(on, { png: true });
    mem["mermaid-pane:mode"] = "image";
    store["mode"] = "image";
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });

    const opt = await callMermaid($, "external on");
    expect(opt.text).toMatch(/External rendering ON/i);
    expect(opt.text).toMatch(/full diagram source/i);
    expect(opt.text).toMatch(/persists/i);
    expect(store["external"]).toBe("on");

    processRuns = [];
    const ui = await mountRow($, REPLY);
    expect(await ui.find({ type: "Image" })).toBeDefined();
    expect(inkRequestCount()).toBeGreaterThan(0);
  });

  test("a cut mermaid.ink sizing request is retried, not cached", async ($, on) => {
    resetMem();
    echoRow(on);
    const isSizing = (s: string) => s.includes("mermaid.ink/svg/");
    stubWorld(on, { png: true, cut: { match: isSizing, times: 1 } });
    mem["mermaid-pane:mode"] = "image";
    store["mode"] = "image";
    store["external"] = "on";
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });

    const ui = await mountRow($, REPLY);
    await ui.redraw();
    expect(await ui.find({ type: "Image" })).toBeDefined();
    // the cut request, then a real one: the cut left nothing cached
    expect(processRuns.filter(isSizing).length).toBe(2);
  });

  test("remote failure with external ON degrades safely without leaking source in diagnostics", async ($, on) => {
    resetMem();
    echoRow(on);
    stubWorld(on, { remoteFail: true });
    mem["mermaid-pane:mode"] = "image";
    store["mode"] = "image";
    store["external"] = "on";
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });
    const ui = await mountRow($, REPLY_SECRET);
    expect(await ui.find({ type: "Image" })).not.toBeDefined();
    const diagNode = await ui.find({ type: "Text", text: /Remote PNG unavailable|ASCII fallback/ });
    expect(diagNode).toBeDefined();
    const full = String((diagNode as any)?.text ?? (diagNode as any)?.children?.[0] ?? "");
    const diagOnly = full.includes("(") ? full.slice(full.lastIndexOf("(")) : full;
    expect(diagOnly).not.toMatch(new RegExp(SECRET));
    expect(diagOnly).not.toMatch(/mermaid\.ink\/(img|svg)/);
  });

  test("revocation blocks subsequent image/SVG requests after reload", async ($, on) => {
    resetMem();
    echoRow(on);
    stubWorld(on, { png: true });
    mem["mermaid-pane:mode"] = "image";
    store["mode"] = "image";
    store["external"] = "on";
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });

    const off = await callMermaid($, "external off");
    expect(off.text).toMatch(/External rendering OFF/i);
    expect(store["external"]).toBe("off");

    processRuns = [];
    const ui = await mountRow($, REPLY);
    expect(await ui.find({ type: "Image" })).not.toBeDefined();
    expect(inkRequestCount()).toBe(0);
  });

  test("ASCII stays local; diagnostics contain no source/payload", async ($, on) => {
    resetMem();
    echoRow(on);
    stubWorld(on);
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });
    await mountRow($, REPLY_SECRET);
    expect(inkRequestCount()).toBe(0);
    for (const s of processRuns) {
      expect(s).not.toMatch(/mermaid\.ink/);
    }
  });

  test("/mermaid setup starts installs for missing renderers and skips present ones", async ($, on) => {
    resetMem();
    stubWorld(on, { present: ["npm", "python3"] }); // renderers missing, toolchains present
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });

    const out = (await callMermaid($, "setup")).text;
    expect(out).toMatch(/installing termaid, mermaid-cli \(mmdc\), beautiful-mermaid in the background/i);
    expect(setupRuns.length).toBe(3);
    // termaid: pip --user install, console script linked into ~/.local/bin
    expect(setupRuns[0]).toContain("pip install --user");
    expect(setupRuns[0]).toContain("termaid");
    expect(setupRuns[0]).toContain("$HOME/.local/bin/termaid");
    // mermaid-cli: correct scoped npm package, pinned to the Node major found
    expect(setupRuns[1]).toContain("@mermaid-js/mermaid-cli");
    expect(setupRuns[1]).not.toContain("@mermaid-cli@latest");
    expect(setupRuns[1]).toContain("npm install -g");
    // beautiful-mermaid: pinned, into the mod's own folder, with its runner; npm without bun
    expect(setupRuns[2]).toContain("beautiful-mermaid@1.1.3");
    expect(setupRuns[2]).toContain("npm install --save-exact");
    expect(setupRuns[2]).toContain("render.mjs");
    expect(out).toMatch(/external on/i);
  });

  test("/mermaid setup reports missing python3 instead of starting a doomed termaid install", async ($, on) => {
    resetMem();
    stubWorld(on, { present: ["npm"] }); // python missing; npm present so mmdc can start
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });
    const out = await callMermaid($, "setup");
    expect(out.text).toMatch(/termaid — install it manually \(needs Python 3\.9\+ and pip\)/);
    expect(setupRuns.length).toBe(2); // mermaid-cli and beautiful-mermaid start
    expect(setupRuns[0]).toContain("@mermaid-js/mermaid-cli");
  });

  test("/mermaid setup reports missing npm instead of starting a doomed mmdc install", async ($, on) => {
    resetMem();
    stubWorld(on, { present: ["python3"] }); // npm missing; python present so termaid can start
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });
    const out = await callMermaid($, "setup");
    expect(out.text).toMatch(/mermaid-cli \(mmdc\) — install it manually \(needs Node \+ npm\)/);
    expect(out.text).toMatch(/beautiful-mermaid — install it manually \(needs Bun, or Node \+ npm\)/);
    expect(setupRuns.length).toBe(1); // only the termaid install starts
    expect(setupRuns[0]).toContain("pip install --user");
    expect(setupRuns[0]).toContain("termaid");
  });

  test("/mermaid setup's beautiful-mermaid install tries bun before npm", async ($, on) => {
    resetMem();
    stubWorld(on, { present: ["termaid", "mmdc", "bun"] });
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });
    const out = await callMermaid($, "setup");
    expect(out.text).toMatch(/installing beautiful-mermaid in the background/i);
    expect(setupRuns.length).toBe(1);
    // the shell picks at install time: bun on PATH or in ~/.bun/bin, else npm
    const sh = setupRuns[0] ?? "";
    expect(sh).toContain(".bun/bin/bun");
    expect(sh.indexOf("add --exact beautiful-mermaid@1.1.3")).toBeGreaterThan(-1);
    expect(sh.indexOf("add --exact")).toBeLessThan(sh.indexOf("npm install --save-exact"));
  });

  test("/mermaid setup stays quiet when everything is installed", async ($, on) => {
    resetMem();
    stubWorld(on, { present: ["termaid", "mmdc"], bmArt: "[BM ART]" });
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });
    const out = await callMermaid($, "setup");
    expect(out.text).toMatch(/everything is installed/i);
    expect(out.text).toMatch(/termaid/i);
    expect(out.text).toMatch(/opt-in/i);
    expect(setupRuns.length).toBe(0);
  });

  test("bare /mermaid shows renderer status when renderers are missing", async ($, on) => {
    resetMem();
    stubWorld(on); // nothing present
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });
    const out = await callMermaid($, "");
    expect(out.text).toMatch(/mode — external OFF — \/mermaid (ascii|image) to switch\./);
    expect(out.text).toMatch(/renderers: beautiful-mermaid ✗ · termaid ✗ · mermaid-cli ✗ — \/mermaid setup/);
    expect(out.text).toMatch(/remote: OFF/);
  });
});
