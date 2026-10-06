import { describe, expect, test } from "claude-code/testing";

type AnyHook = (...args: any[]) => unknown;

// In-memory $.state so the mod's single `state` key can be read and written.
const mem: Record<string, unknown> = {};
const WORK = "/work";

// Build a world where any `*.png`/`*.jpg` path is a real file and `sips`
// converts it to 400x300.
function stubWorld(on: (event: string, hook: AnyHook) => void, envFlag = "1") {
  for (const k of Object.keys(mem)) delete mem[k]; // fresh state per test
  on("session.start", () => ({ cwd: WORK }));
  on("session.messages", () => ({ value: [] }));
  on("session.cwd", () => ({ value: WORK }));

  on("state.get", (_$: unknown, e: { plugin: string; key: string }) => {
    const k = `${e.plugin}:${e.key}`;
    if (!(k in mem)) mem[k] = { state: { gallery: [] } };
    // Envelope { value: ... } + real result { value, version }: $.state.get
    // resolves to the inner object, whose .value is the stored state.
    return { value: { value: mem[k], version: 0 } };
  });
  on("state.set", (_$: unknown, e: { plugin: string; key: string; value: unknown }) => {
    mem[`${e.plugin}:${e.key}`] = e.value;
    return { value: { isSet: true, version: 0 } };
  });

  on("command.register", () => ({ value: { command: "image" } }));
  on("ui.invalidate", () => ({ value: {} }));

  // Rendering is opted in via the env flag (the same one the engine's
  // kitty-graphics gate honors); the tests run with it on.
  on("env.get", (_$: unknown, e: { name: string }) => {
    if (e?.name === "CLAUDE_CODE_FORCE_TERMINAL_IMAGES") return { value: envFlag };
    return { value: undefined };
  });

  on("process.run", (_$: unknown, cmd: unknown) => {
    const s = JSON.stringify(cmd);
    if (s.indexOf("sips") >= 0) {
      return { value: { exitCode: 0, stdout: "pixelWidth: 400\npixelHeight: 300" } };
    }
    return { value: { exitCode: 1, stdout: "", stderr: "no such tool" } };
  });
}

function runImage($: any, args: string) {
  return $.command.run({
    command: "image",
    args,
    origin: { kind: "composer" },
    presentation: { isFullscreen: false, columns: 120 },
  });
}

function mount($: any, component: any, props: any, viewport?: any) {
  return $.ui.mount({ plugin: "image-preview", surface: "terminal", component, props, viewport });
}

describe("image-preview", () => {
  test("an image path in a user prompt draws an inline Image in the chat row", async ($, on) => {
    stubWorld(on);
    on("ui.render", (_$: unknown, e: any) => ({ type: "Text", props: {}, children: [String(e?.props?.text ?? "")] }));
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: WORK });

    const ui = await mount($, "UserMessage", { text: `look at ${WORK}/pic.png then continue`, origin: { kind: "composer" }, isExpanded: true }, { columns: 120, rows: 40 });
    expect(await ui.find({ type: "Image" })).toBeDefined();
    expect(await ui.find({ type: "Text", text: /look at/ })).toBeDefined();
  });

  test("an image path in an agent reply draws an inline Image in the reply row", async ($, on) => {
    stubWorld(on);
    on("ui.render", (_$: unknown, e: any) => ({ type: "Text", props: {}, children: [String(e?.props?.text ?? "")] }));
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: WORK });

    const ui = await mount($, "AssistantMessage", { text: `done — see ${WORK}/pic.png`, isFirstOfReply: true }, { columns: 120, rows: 40 });
    expect(await ui.find({ type: "Image" })).toBeDefined();
    expect(await ui.find({ type: "Text", text: /done — see/ })).toBeDefined();
  });

  test("the thumbnail sources a real PNG file, mermaid-style", async ($, on) => {
    stubWorld(on);
    on("ui.render", (_$: unknown, e: any) => ({ type: "Text", props: {}, children: [String(e?.props?.text ?? "")] }));
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: WORK });

    const ui = await mount($, "UserMessage", { text: `look at ${WORK}/pic.png`, origin: { kind: "composer" }, isExpanded: true }, { columns: 120, rows: 40 });
    const tree = JSON.stringify(await ui.drawn());
    expect(tree).toContain('"format":"png"');
    expect(tree).toContain(".png");
    expect(await ui.find({ type: "Image" })).toBeDefined();
    // Identical to a no-image block: the engine's own Text carries the whole
    // prompt verbatim, with the Image block added below it — nothing rewritten.
    expect(tree).toContain('"children":["look at /work/pic.png"]');
    // Aspect-fill, never stretched: the block's cell aspect matches the
    // picture's pixel aspect through the 16x34px cell (400x300 -> 2.833 c/r).
    const drawn = JSON.parse(tree);
    const findImg = (n: any): any => {
      if (n?.type === "Image") return n;
      for (const c of n?.children ?? []) { const f = findImg(c); if (f) return f; }
      return null;
    };
    const node = findImg(drawn);
    expect(node).toBeDefined();
    const want = (400 / 300) * (34 / 16); // 2.833 columns per row
    expect(Math.abs(node.props.columns / node.props.rows - want)).toBeLessThan(0.5);
  });

  test("a path with a query or fragment suffix still renders", async ($, on) => {
    stubWorld(on);
    on("ui.render", (_$: unknown, e: any) => ({ type: "Text", props: {}, children: [String(e?.props?.text ?? "")] }));
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: WORK });

    const ui = await mount($, "UserMessage", { text: `see ${WORK}/pic.png?w=100#top`, origin: { kind: "composer" }, isExpanded: true }, { columns: 120, rows: 40 });
    expect(await ui.find({ type: "Image" })).toBeDefined();
    // The suffix is stripped from what the decoder reads: the Image sources
    // the clean pic.png copy (hash 78ek45), while the prompt text — suffix
    // and all — stays verbatim in the engine's own block.
    const tree = JSON.stringify(await ui.drawn());
    expect(tree).toContain('"file":"/tmp/image-preview/78ek45.png"');
    expect(tree).toContain("see /work/pic.png?w=100#top");
  });

  test("with rendering toggled off the mod is a complete no-op", async ($, on) => {
    stubWorld(on);
    on("ui.render", (_$: unknown, e: any) => ({ type: "Text", props: {}, children: [String(e?.props?.text ?? "")] }));
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: WORK });

    await runImage($, "off");
    const ui = await mount($, "UserMessage", { text: `look at ${WORK}/pic.png`, origin: { kind: "composer" }, isExpanded: true }, { columns: 120, rows: 40 });
    expect(await ui.find({ type: "Image" })).not.toBeDefined();

    await runImage($, "on");
    const ui2 = await mount($, "UserMessage", { text: `look at ${WORK}/pic.png`, origin: { kind: "composer" }, isExpanded: true }, { columns: 120, rows: 40 });
    expect(await ui2.find({ type: "Image" })).toBeDefined();
  });

  test("a prompt with no image draws nothing extra (falls through)", async ($, on) => {
    stubWorld(on);
    on("ui.render", (_$: unknown, e: any) => ({ type: "Text", props: {}, children: [String(e?.props?.text ?? "")] }));
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: WORK });

    const ui = await mount($, "UserMessage", { text: "just words, no picture", origin: { kind: "composer" }, isExpanded: true }, { columns: 120, rows: 40 });
    expect(await ui.find({ type: "Image" })).not.toBeDefined();
  });

  test("[Image #N] resolves against the /image gallery", async ($, on) => {
    stubWorld(on);
    on("ui.render", (_$: unknown, _e: any) => ({ type: "Text", props: {}, children: [] }));
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: WORK });

    const r = await runImage($, `${WORK}/photo.jpg`);
    expect((r as any).text).toMatch(/\[Image #1\]/);
    expect((mem["image-preview:state"] as any).state.gallery).toEqual([`${WORK}/photo.jpg`]);

    const ui = await mount($, "UserMessage", { text: "show me [Image #1]", origin: { kind: "composer" }, isExpanded: true }, { columns: 120, rows: 40 });
    expect(await ui.find({ type: "Image" })).toBeDefined();
  });

  test("/image clear empties the gallery", async ($, on) => {
    stubWorld(on);
    on("ui.render", (_$: unknown, _e: any) => ({ type: "Text", props: {}, children: [] }));
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: WORK });

    await runImage($, `${WORK}/a.png ${WORK}/b.png`);
    expect((mem["image-preview:state"] as any).state.gallery).toHaveLength(2);

    const r = await runImage($, "clear");
    expect((r as any).text).toMatch(/cleared/);
    expect((mem["image-preview:state"] as any).state.gallery).toHaveLength(0);
  });

});
