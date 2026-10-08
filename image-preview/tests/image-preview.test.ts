import { describe, expect, test } from "claude-code/testing";

type AnyHook = (...args: any[]) => unknown;

// In-memory $.state so the mod's single `state` key can be read and written.
const mem: Record<string, unknown> = {};
const WORK = "/work";
const HOME = "/Users/u";
// Every command name the mod registered.
const registered: string[] = [];
// Every shell command the mod ran, so a test can see which file sips read.
const commands: string[] = [];
// What $.session.messages({ as: "api" }) answers: the transcript as the model
// reads it, pasted images inline as base64 image blocks.
let apiMessages: unknown[] = [];
let apiReads = 0; // how many times the mod read the transcript

// Build a world where any `*.png`/`*.jpg` path is a real file and `sips`
// converts it to 400x300.
function stubWorld(on: (event: string, hook: AnyHook) => void, envFlag = "1", home: string | null = HOME) {
  for (const k of Object.keys(mem)) delete mem[k]; // fresh state per test
  commands.length = 0;
  apiMessages = [];
  apiReads = 0;
  registered.length = 0;
  on("session.start", () => ({ cwd: WORK }));
  on("session.messages", (_$: unknown, e: any) => {
    if (e?.as === "api") apiReads++;
    return { value: e?.as === "api" ? apiMessages : [] };
  });
  on("session.cwd", () => ({ value: WORK }));

  on("state.get", (_$: unknown, e: { plugin: string; key: string }) => {
    const k = `${e.plugin}:${e.key}`;
    if (!(k in mem)) mem[k] = { state: { render: true } };
    // Envelope { value: ... } + real result { value, version }: $.state.get
    // resolves to the inner object, whose .value is the stored state.
    return { value: { value: mem[k], version: 0 } };
  });
  on("state.set", (_$: unknown, e: { plugin: string; key: string; value: unknown }) => {
    mem[`${e.plugin}:${e.key}`] = e.value;
    return { value: { isSet: true, version: 0 } };
  });

  on("command.register", (_$: unknown, e: any) => { registered.push(e?.name); return { value: { command: e?.name } }; });
  on("ui.invalidate", () => ({ value: {} }));

  // Rendering is opted in via the env flag (the same one the engine's
  // kitty-graphics gate honors); the tests run with it on.
  on("env.get", (_$: unknown, e: { name: string }) => {
    if (e?.name === "CLAUDE_CODE_FORCE_TERMINAL_IMAGES") return { value: envFlag };
    if (e?.name === "HOME") return { value: home ?? undefined };
    return { value: undefined };
  });

  on("process.run", (_$: unknown, cmd: unknown) => {
    const s = JSON.stringify(cmd);
    commands.push(s);
    if (s.indexOf("missing") >= 0) return { value: { exitCode: 1, stdout: "", stderr: "not found" } };
    if (s.indexOf("sips") >= 0) {
      return { value: { exitCode: 0, stdout: "pixelWidth: 400\npixelHeight: 300" } };
    }
    return { value: { exitCode: 1, stdout: "", stderr: "no such tool" } };
  });
}

function runToggle($: any, args: string) {
  return $.command.run({
    command: "image-preview",
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

    await runToggle($, "off");
    const ui = await mount($, "UserMessage", { text: `look at ${WORK}/pic.png`, origin: { kind: "composer" }, isExpanded: true }, { columns: 120, rows: 40 });
    expect(await ui.find({ type: "Image" })).not.toBeDefined();

    await runToggle($, "on");
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

  test("a ~/ path resolves against HOME, not the cwd", async ($, on) => {
    stubWorld(on);
    on("ui.render", (_$: unknown, e: any) => ({ type: "Text", props: {}, children: [String(e?.props?.text ?? "")] }));
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: WORK });

    const ui = await mount($, "UserMessage", { text: "Tell me about this image ~/Desktop/image.png", origin: { kind: "composer" }, isExpanded: true }, { columns: 120, rows: 40 });
    expect(await ui.find({ type: "Image" })).toBeDefined();
    const sips = commands.filter((c) => c.includes("sips"));
    expect(sips.some((c) => c.includes("'/Users/u/Desktop/image.png'"))).toBe(true);
    expect(sips.some((c) => c.includes("/work/~"))).toBe(false);
  });

  // How models and people actually write paths: in code spans, bold, markdown
  // links, and right before sentence punctuation. Each must decode the bare
  // file, nothing more.
  for (const text of [
    "see `/work/pic.png`",
    "Saved to /work/pic.png.",
    "file /work/pic.png: done",
    "/work/pic.png, and more",
    "wrote /work/pic.png; next",
    "**/work/pic.png**",
    "the [chart](/work/pic.png) here",
    "![chart](/work/pic.png)",
  ]) {
    test(`a path written as ${JSON.stringify(text)} renders`, async ($, on) => {
      stubWorld(on);
      on("ui.render", (_$: unknown, e: any) => ({ type: "Text", props: {}, children: [String(e?.props?.text ?? "")] }));
      await $.session.start({ surface: "terminal", isInteractive: true, cwd: WORK });

      const ui = await mount($, "AssistantMessage", { text, isFirstOfReply: true }, { columns: 120, rows: 40 });
      expect(await ui.find({ type: "Image" })).toBeDefined();
      const sips = commands.filter((c) => c.includes("sips"));
      expect(sips.length).toBeGreaterThan(0);
      expect(sips.every((c) => c.includes("sips '/work/pic.png' -Z"))).toBe(true);
    });
  }

  test("a path with [brackets] in it still renders", async ($, on) => {
    stubWorld(on);
    on("ui.render", (_$: unknown, e: any) => ({ type: "Text", props: {}, children: [String(e?.props?.text ?? "")] }));
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: WORK });

    const ui = await mount($, "AssistantMessage", { text: "see app/[id]/hero.png and /work/b[1].png", isFirstOfReply: true }, { columns: 120, rows: 40 });
    expect(await ui.find({ type: "Image" })).toBeDefined();
    const sips = commands.filter((c) => c.includes("sips"));
    expect(sips.some((c) => c.includes("sips '/work/app/[id]/hero.png' -Z"))).toBe(true);
    expect(sips.some((c) => c.includes("sips '/work/b[1].png' -Z"))).toBe(true);
  });

  test("a ~/ path with HOME unset draws nothing rather than a cwd guess", async ($, on) => {
    stubWorld(on, "1", null);
    on("ui.render", (_$: unknown, e: any) => ({ type: "Text", props: {}, children: [String(e?.props?.text ?? "")] }));
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: WORK });

    const ui = await mount($, "UserMessage", { text: "look at ~/pic.png", origin: { kind: "composer" }, isExpanded: true }, { columns: 120, rows: 40 });
    expect(await ui.find({ type: "Image" })).not.toBeDefined();
    expect(commands.some((c) => c.includes("/work/~"))).toBe(false);
  });

  // A pasted image is no file: the prompt holds an [Image #N] token and the
  // transcript holds the picture, one image block per token in order. N is
  // numbered across the session, so #3 can be a message's first picture.
  test("a pasted [Image #N] draws the picture from the transcript", async ($, on) => {
    stubWorld(on);
    on("ui.render", (_$: unknown, e: any) => ({ type: "Text", props: {}, children: [String(e?.props?.text ?? "")] }));
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: WORK });
    apiMessages = [
      { role: "user", content: [
        { type: "text", text: "compare [Image #3] with [Image #4]" },
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "FIRSTPIC" } },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "SECONDPIC" } },
      ] },
    ];

    const ui = await mount($, "UserMessage", { text: "compare [Image #3] with [Image #4]", origin: { kind: "composer" }, isExpanded: true }, { columns: 120, rows: 40 });
    const tree = JSON.stringify(await ui.drawn());
    expect((tree.match(/"type":"Image"/g) ?? []).length).toBe(2);
    expect(tree).toContain("[Image #3]");
    const decodes = commands.filter((c) => c.includes("base64"));
    expect(decodes.some((c) => c.includes("FIRSTPIC"))).toBe(true);
    expect(decodes.some((c) => c.includes("SECONDPIC"))).toBe(true);
  });

  test("an [Image #N] with no pasted picture behind it draws nothing", async ($, on) => {
    stubWorld(on);
    on("ui.render", (_$: unknown, e: any) => ({ type: "Text", props: {}, children: [String(e?.props?.text ?? "")] }));
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: WORK });
    // Typed by hand: the token is text, the message carries no image block.
    apiMessages = [{ role: "user", content: [{ type: "text", text: "what is [Image #1]?" }] }];

    const ui = await mount($, "UserMessage", { text: "what is [Image #1]?", origin: { kind: "composer" }, isExpanded: true }, { columns: 120, rows: 40 });
    expect(await ui.find({ type: "Image" })).not.toBeDefined();
  });

  test("the toggle lives in /image-preview; /image is gone", async ($, on) => {
    stubWorld(on);
    on("ui.render", (_$: unknown, _e: any) => ({ type: "Text", props: {}, children: [] }));
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: WORK });

    expect(registered).toEqual(["image-preview"]);
    const r = await runToggle($, "off");
    expect((r as any).text).toMatch(/off/);
    expect((mem["image-preview:state"] as any).state.render).toBe(false);
  });

  test("a path with escaped spaces renders", async ($, on) => {
    stubWorld(on);
    on("ui.render", (_$: unknown, e: any) => ({ type: "Text", props: {}, children: [String(e?.props?.text ?? "")] }));
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: WORK });

    const ui = await mount($, "UserMessage", { text: "what is ~/Desktop/Screen\\ Shot\\ (2).png here", origin: { kind: "composer" }, isExpanded: true }, { columns: 120, rows: 40 });
    expect(await ui.find({ type: "Image" })).toBeDefined();
    const sips = commands.filter((c) => c.includes("sips"));
    expect(sips.some((c) => c.includes("sips '/Users/u/Desktop/Screen Shot (2).png' -Z"))).toBe(true);
  });

  for (const text of [
    'open "/work/My Pics/a b.png" now',
    "open '~/My Pics/a b.png' now",
    "saved to `./My Pics/a b.png`.",
  ]) {
    test(`a quoted path with spaces renders: ${JSON.stringify(text)}`, async ($, on) => {
      stubWorld(on);
      on("ui.render", (_$: unknown, e: any) => ({ type: "Text", props: {}, children: [String(e?.props?.text ?? "")] }));
      await $.session.start({ surface: "terminal", isInteractive: true, cwd: WORK });

      const ui = await mount($, "AssistantMessage", { text, isFirstOfReply: true }, { columns: 120, rows: 40 });
      expect(await ui.find({ type: "Image" })).toBeDefined();
      const sips = commands.filter((c) => c.includes("sips"));
      expect(sips.length).toBeGreaterThan(0);
      expect(sips.every((c) => /sips '\/(work|Users\/u)\/My Pics\/a b\.png' -Z/.test(c))).toBe(true);
    });
  }

  test("a path that fails to decode is skipped; the others still draw", async ($, on) => {
    stubWorld(on);
    on("ui.render", (_$: unknown, e: any) => ({ type: "Text", props: {}, children: [String(e?.props?.text ?? "")] }));
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: WORK });

    const ui = await mount($, "UserMessage", { text: "see /work/missing.png and /work/pic.png", origin: { kind: "composer" }, isExpanded: true }, { columns: 120, rows: 40 });
    const tree = JSON.stringify(await ui.drawn());
    expect((tree.match(/"type":"Image"/g) ?? []).length).toBe(1);
    expect(tree).toContain('"alt":"pic.png"');
  });

  test("a quoted span holding several paths draws each of them", async ($, on) => {
    stubWorld(on);
    on("ui.render", (_$: unknown, e: any) => ({ type: "Text", props: {}, children: [String(e?.props?.text ?? "")] }));
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: WORK });

    const ui = await mount($, "AssistantMessage", { text: "compare '/work/a.png and /work/b.png'", isFirstOfReply: true }, { columns: 120, rows: 40 });
    const tree = JSON.stringify(await ui.drawn());
    expect((tree.match(/"type":"Image"/g) ?? []).length).toBe(2);
  });

  test("a dropped file's escaped parentheses are unescaped too", async ($, on) => {
    stubWorld(on);
    on("ui.render", (_$: unknown, e: any) => ({ type: "Text", props: {}, children: [String(e?.props?.text ?? "")] }));
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: WORK });

    const ui = await mount($, "UserMessage", { text: "see /work/Screen\\ Shot\\ \\(2\\).png", origin: { kind: "composer" }, isExpanded: true }, { columns: 120, rows: 40 });
    expect(await ui.find({ type: "Image" })).toBeDefined();
    expect(commands.some((c) => c.includes("sips '/work/Screen Shot (2).png' -Z"))).toBe(true);
  });

  test("a long run of escaped spaces scans in linear time", async ($, on) => {
    stubWorld(on);
    on("ui.render", (_$: unknown, e: any) => ({ type: "Text", props: {}, children: [String(e?.props?.text ?? "")] }));
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: WORK });

    const t0 = Date.now();
    await mount($, "AssistantMessage", { text: "/a\\ b".repeat(20000), isFirstOfReply: true }, { columns: 120, rows: 40 });
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  test("a paste missing from the transcript is not looked up on every redraw", async ($, on) => {
    stubWorld(on);
    on("ui.render", (_$: unknown, e: any) => ({ type: "Text", props: {}, children: [String(e?.props?.text ?? "")] }));
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: WORK });

    for (let i = 0; i < 5; i++) {
      await mount($, "UserMessage", { text: "typed [Image #7] by hand", origin: { kind: "composer" }, isExpanded: true }, { columns: 120, rows: 40 });
    }
    expect(apiReads).toBeLessThanOrEqual(1);
  });

});
