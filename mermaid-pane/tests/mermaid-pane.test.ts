import { describe, expect, test } from "claude-code/testing";

const REPLY = "intro line\n```mermaid\nflowchart LR\n  A[Start] --> B[End]\n```";
const REPLY_EDGES = "```mermaid\nflowchart LR\n  P[Phone] --> W[WiFi Router] --> N[Internet]\n```";

// In-memory $.state backing (mode is the session value).
const mem: Record<string, unknown> = {};
// In-memory $.store backing (mode persists here, durable).
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
function stubWorld(
  on: (event: string, hook: AnyHook) => void,
  opts: { png?: boolean; present?: string[] } = {}
) {
  setupRuns = [];
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
  on("ui.invalidate", () => ({ value: {} }));
  on("process.run", (_$: unknown, cmd: unknown) => {
    const s = JSON.stringify(cmd);
    if (s.includes("nohup")) {
      setupRuns.push(s);
      return { value: { exitCode: 0, stdout: "started" } };
    }
    if (opts.png && s.includes("sips")) {
      return { value: { exitCode: 0, stdout: "pixelWidth: 876\npixelHeight: 196" } };
    }
    if (opts.png && s.includes("curl")) return { value: { exitCode: 0, stdout: "" } };
    const m = /command -v ([a-z0-9-]+)/.exec(s);
    if (m && m[1])
      return {
        value: { exitCode: (opts.present ?? []).includes(m[1]) ? 0 : 1, stdout: (opts.present ?? []).includes(m[1]) ? `/usr/bin/${m[1]}` : "" },
      };
    return { value: { exitCode: 1, stdout: "", stderr: "" } }; // no mermaid-ascii/png in tests
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

describe("mermaid-pane", () => {
  test("/mermaid sets the mode in state and store", async ($, on) => {
    stubWorld(on);
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });
    const call = (args: string) =>
      $.command.run({
        command: "mermaid",
        args,
        origin: { kind: "composer" },
        presentation: { isFullscreen: false, columns: 120 },
      });

    expect((await call("image")).text).toMatch(/image mode/i);
    expect(mem["mermaid-pane:mode"]).toBe("image");
    expect(store["mode"]).toBe("image");
    expect((await call("ascii")).text).toMatch(/ascii mode/i);
    expect(mem["mermaid-pane:mode"]).toBe("ascii");
    expect(store["mode"]).toBe("ascii");
    // bare /mermaid reports the current mode
    expect((await call("")).text).toMatch(/ascii mode/);
  });

  test("ascii mode rewrites each mermaid fence into uncut edge art", async ($, on) => {
    echoRow(on);
    stubWorld(on); // no mermaid-ascii → built-in edge art
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });

    const ui = await mountRow($, REPLY_EDGES);
    // every edge of a single-line chain, full labels, nothing cut
    expect(await ui.find({ type: "Text", text: /P\[Phone\] ──▶ W\[WiFi Router\]/ })).toBeDefined();
    expect(await ui.find({ type: "Text", text: /W\[WiFi Router\] ──▶ N\[Internet\]/ })).toBeDefined();
    // the source fence is gone — rewritten in place
    expect(await ui.find({ type: "Text", text: /```mermaid/ })).not.toBeDefined();
  });

  test("rows without mermaid blocks pass through untouched", async ($, on) => {
    echoRow(on);
    stubWorld(on);
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });

    const ui = await mountRow($, "just a plain answer");
    expect(await ui.find({ type: "Text", text: /just a plain answer/ })).toBeDefined();
  });

  test("image mode embeds the chart image in the response row", async ($, on) => {
    echoRow(on);
    stubWorld(on, { png: true });
    mem["mermaid-pane:mode"] = "image";
    store["mode"] = "image";
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });

    const ui = await mountRow($, REPLY);
    // intro text and the image element, no raw fence anywhere
    expect(await ui.find({ type: "Text", text: /intro line/ })).toBeDefined();
    expect(await ui.find({ type: "Image" })).toBeDefined();
    expect(await ui.find({ type: "Text", text: /```mermaid/ })).not.toBeDefined();
  });

  test("/mermaid setup starts installs for missing renderers and skips present ones", async ($, on) => {
    stubWorld(on, { present: ["uv", "npm"] }); // renderers missing, managers present
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });
    const call = (args: string) =>
      $.command.run({
        command: "mermaid",
        args,
        origin: { kind: "composer" },
        presentation: { isFullscreen: false, columns: 120 },
      });

    const out = (await call("setup")).text;
    expect(out).toMatch(/installing mermaid-ascii, mermaid-cli \(mmdc\) in the background/i);
    expect(setupRuns.length).toBe(2);
    expect(setupRuns[0]).toContain("uv tool install mermaid-ascii");
    expect(setupRuns[1]).toContain("npm install -g @mermaid-cli");
  });

  test("/mermaid setup stays quiet when everything is installed", async ($, on) => {
    stubWorld(on, { present: ["mermaid-ascii", "mmdc"] });
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });
    const out = await $.command.run({
      command: "mermaid",
      args: "setup",
      origin: { kind: "composer" },
      presentation: { isFullscreen: false, columns: 120 },
    });
    expect(out.text).toMatch(/everything is installed/i);
    expect(setupRuns.length).toBe(0);
  });

  test("bare /mermaid shows renderer status when renderers are missing", async ($, on) => {
    stubWorld(on); // nothing present
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });
    const out = await $.command.run({
      command: "mermaid",
      args: "",
      origin: { kind: "composer" },
      presentation: { isFullscreen: false, columns: 120 },
    });
    expect(out.text).toMatch(/mode — \/mermaid (ascii|image) to switch\./);
    expect(out.text).toMatch(/renderers: mermaid-ascii ✗ · mermaid-cli ✗ — \/mermaid setup/);
  });
});
