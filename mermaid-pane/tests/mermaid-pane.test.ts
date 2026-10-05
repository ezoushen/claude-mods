import { describe, expect, test } from "claude-code/testing";

const MESSAGES = [
  { role: "user", text: "draw a flow", toolUses: [] },
  {
    role: "assistant",
    text: "Here you go:\n```mermaid\nflowchart LR\n  A[Start] --> B[End]\n  B --> C[Middle]\n```",
    toolUses: [],
  },
];

// In-memory $.state stub so collection can be asserted across hooks.
const mem: Record<string, unknown> = {};
const stateKey = (e: { plugin: string; key: string }) => `${e.plugin}:${e.key}`;
const defaults: Record<string, unknown> = {
  "mermaid-pane:diagrams": [],
  "mermaid-pane:asciiTool": null,
  "mermaid-pane:mode": "ascii",
};

type AnyHook = (...args: any[]) => unknown;
function stubWorld(on: (event: string, hook: AnyHook) => void, opts: { png?: boolean } = {}) {
  on("session.start", () => ({ cwd: "/work" }));
  on("session.messages", () => ({ value: MESSAGES }));
  on("state.get", (_$: unknown, e: { plugin: string; key: string }) => {
    const k = stateKey(e);
    if (!(k in mem) && !(k in defaults)) throw new Error("DBG state.get " + JSON.stringify(e));
    return { value: { value: mem[k] ?? defaults[k], version: 0 } };
  });
  on("state.set", (_$: unknown, e: { plugin: string; key: string; value: unknown }) => {
    mem[stateKey(e)] = e.value;
    return { value: { isSet: true, version: 0 } };
  });
  on("command.register", () => ({ value: { command: "mermaid" } }));
  on("ui.open", () => ({ value: { isPlaced: true } }));
  on("ui.close", () => ({ value: {} }));
  on("clock.now", () => ({ value: 1700000000000 }));
  on("process.run", (_$: unknown, cmd: unknown) => {
    const s = JSON.stringify(cmd);
    if (opts.png && s.includes("sips")) {
      return { value: { exitCode: 0, stdout: "pixelWidth: 876\npixelHeight: 196" } };
    }
    if (opts.png && s.includes("curl")) return { value: { exitCode: 0, stdout: "" } };
    return { value: { exitCode: 1, stdout: "", stderr: "" } }; // no mermaid-ascii/png in tests
  });
}

const PANE = {
  surface: "terminal" as const,
  component: "Pane" as const,
  props: {
    title: "Mermaid",
    isFocused: true,
    bodyColumns: 60,
    placement: "dock" as const,
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
  viewport: { columns: 140, rows: 44 },
};

describe("mermaid-pane", () => {
  test("collects mermaid blocks and draws full, uncut ASCII art in the pane", async ($, on) => {
    stubWorld(on);
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });
    const ui = await $.ui.mount({ plugin: "mermaid-pane", ...PANE });

    const title = await ui.find({ type: "Text", text: /mermaid 1\/1 · flowchart/ });
    expect(title).toBeDefined();
    // edge-list art: every node and edge present with full labels, nothing cut
    expect(await ui.find({ type: "Text", text: /A\[Start\] ──▶ B\[End\]/ })).toBeDefined();
    expect(await ui.find({ type: "Text", text: /B\[End\] ──▶ C\[Middle\]/ })).toBeDefined();
    expect(await ui.find({ type: "Button", text: "Open ↗" })).toBeDefined();
  });

  test("draws nothing when the session has no mermaid blocks", async ($, on) => {
    on("session.start", () => ({ cwd: "/work" }));
    on("session.messages", () => ({ value: [{ role: "assistant", text: "plain answer", toolUses: [] }] }));
    on("state.get", () => ({ value: { value: [], version: 0 } }));
    on("command.register", () => ({ value: { command: "mermaid" } }));
    on("ui.render", () => ({ type: "Text", props: {}, children: [] }));

    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });
    const ui = await $.ui.mount({ plugin: "mermaid-pane", ...PANE });
    expect(await ui.find({ type: "Text", text: /mermaid/ })).not.toBeDefined();
  });

  test("/mermaid switches between ascii and image modes", async ($, on) => {
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
    expect((await call("ascii")).text).toMatch(/ascii mode/i);
    expect(mem["mermaid-pane:mode"]).toBe("ascii");
    expect((await call("close")).text).toMatch(/closed/i);
    expect((await call("")).text).toMatch(/opened \(ascii mode\)/i);
  });

  test("image mode embeds the chart image in the response row", async ($, on) => {
    // Beneath-hooks register before the first $ call; the echo only answers
    // when the mod passes the row through (it shouldn't in image mode).
    on("ui.render", (_$: unknown, e: any) => ({
      type: "Text",
      props: {},
      children: [String(e?.props?.text ?? "")],
    }));
    stubWorld(on, { png: true });
    mem["mermaid-pane:mode"] = "image";
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });

    const ui = await $.ui.mount({
      plugin: "mermaid-pane",
      surface: "terminal",
      component: "AssistantMessage" as const,
      props: { text: "intro line\n```mermaid\nflowchart LR\n  A[Start] --> B[End]\n```", isFirstOfReply: true },
      viewport: { columns: 140, rows: 44 },
    });
    // intro text and the image element, no raw fence anywhere
    expect(await ui.find({ type: "Text", text: /intro line/ })).toBeDefined();
    expect(await ui.find({ type: "Image" })).toBeDefined();
    expect(await ui.find({ type: "Text", text: /```mermaid/ })).not.toBeDefined();
  });

  test("image mode falls back to ascii art when the PNG cannot be produced", async ($, on) => {
    on("ui.render", (_$: unknown, e: any) => ({
      type: "Text",
      props: {},
      children: [String(e?.props?.text ?? "")],
    }));
    stubWorld(on); // png: false → curl/sips fail
    mem["mermaid-pane:mode"] = "image";
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });

    const ui = await $.ui.mount({
      plugin: "mermaid-pane",
      surface: "terminal",
      component: "AssistantMessage" as const,
      props: { text: "intro\n```mermaid\nflowchart LR\n  A[Start] --> B[End]\n```", isFirstOfReply: true },
      viewport: { columns: 140, rows: 44 },
    });
    // art is embedded as text (rewritten props echo), nothing cut
    expect(await ui.find({ type: "Text", text: /A\[Start\] ──▶ B\[End\]/ })).toBeDefined();
  });

  test("edge art keeps every edge of a single-line chain", async ($, on) => {
    on("ui.render", (_$: unknown, e: any) => ({
      type: "Text",
      props: {},
      children: [String(e?.props?.text ?? "")],
    }));
    stubWorld(on); // no mermaid-ascii → edge art
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });
    const ui = await $.ui.mount({
      plugin: "mermaid-pane",
      surface: "terminal",
      component: "AssistantMessage" as const,
      props: { text: "```mermaid\nflowchart LR\n  P[Phone] --> W[WiFi Router] --> N[Internet]\n```", isFirstOfReply: true },
      viewport: { columns: 140, rows: 44 },
    });
    expect(await ui.find({ type: "Text", text: /P\[Phone\] ──▶ W\[WiFi Router\]/ })).toBeDefined();
    expect(await ui.find({ type: "Text", text: /W\[WiFi Router\] ──▶ N\[Internet\]/ })).toBeDefined();
  });
});
