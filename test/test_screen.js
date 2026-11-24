"use strict";
// The screen in a real browser page (Chromium) with the real loader and every runtime plugin, a
// stand-in core answering from memory, and no platform (a desktop browser, B5): it starts, draws
// the chat, opens the chats list, Settings and Find, sends a first message into a new chat, and
// reports no page errors.
const test = require("node:test");
const assert = require("node:assert/strict");
const { chromium } = require("playwright");

const SHOT = process.env.PP_SHOT || "";

const { core_build, server_start } = require("./standin.js");

test(
  "the screen starts, opens its sheets and sends a first message (UC1, UC16, UC18, R8)",
  { timeout: 60000 },
  async () => {
    const core = core_build();
    const server = await server_start(core);
    const browser = await chromium.launch();
    const errors = [];
    try {
      const page = await browser.newPage({ viewport: { width: 400, height: 800 } });
      page.on("pageerror", (e) => errors.push(e.message));
      page.on(
        "console",
        (m) =>
          m.type() === "error" &&
          !/Failed to load resource/.test(m.text()) &&
          errors.push(m.text()),
      );
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      await page.waitForSelector("#message", { timeout: 15000 });
      assert.ok(await page.isVisible("text=Say hello"));

      // The welcome guide comes up on a first start; Skip closes it.
      await page.click("text=Skip");

      await page.click("[aria-label='Chats']");
      await page.waitForSelector(".drawer");
      await page.keyboard.press("Escape");
      await page.waitForSelector(".drawer", { state: "detached", timeout: 3000 });

      await page.keyboard.press("Control+,");
      await page.waitForSelector("text=Prompt library");
      await page.click("text=Look");
      await page.waitForSelector("text=UI scale", { timeout: 3000 }).catch(() => null);
      await page.click("[aria-label='Back']");
      await page.click("text=Plugins");
      await page.waitForSelector("text=Sent top to bottom");
      await page.click(".tabs button:has-text('Library')");
      await page.waitForSelector("text=Install from a file");
      await page.click("[aria-label='Close']");

      await page.keyboard.press("Control+k");
      await page.fill("input[aria-label='Find chats and functions']", "prof");
      await page.waitForSelector("text=Next profile");
      await page.keyboard.press("Escape");

      // Help mode: a tap explains instead of doing; Do it leaves help mode and does it.
      await page.click("[aria-label^='Help:']");
      await page.waitForSelector("text=Help mode. Tap anything to see what it does.");
      await page.click("[aria-label='Chats']");
      await page.waitForSelector(".helpcard >> text=Your chats");
      await page.waitForTimeout(300);
      assert.equal(await page.locator(".drawer").count(), 0, "help mode didn't open the drawer");
      await page.click(".helpcard >> text=Do it");
      await page.waitForSelector(".drawer");
      await page.waitForSelector(".help-bar", { state: "detached", timeout: 3000 });
      await page.keyboard.press("Escape");

      await page.fill("#message", "Hello there\nsecond line");
      await page.click("[aria-label='Send']");
      await page.waitForFunction(() =>
        document.querySelector(".top .title").textContent.includes("Hello there"),
      );
      assert.ok(
        Object.keys(core.files).some((k) => k.endsWith("/meta.json")),
        "the new chat's meta was saved",
      );
      assert.ok(
        core.files["app/outbox.json"],
        "the message was kept in the outbox before the box cleared",
      );
      await page.waitForTimeout(500);
      if (SHOT) await page.screenshot({ path: SHOT });
      const unexpected = errors.filter(
        (e) => !/not supported on this platform|unimplemented/.test(e),
      );
      assert.deepEqual(unexpected, []);
    } finally {
      await browser.close();
      server.close();
    }
  },
);

// The message box is the browser engine's own (selection, the keyboard's word choice): typing
// isn't written back and redraws the screen only when the box goes empty or not; a redraw leaves
// the selection alone; tapping it doesn't resize it; it grows with its lines without ever being
// collapsed to measure; a change from elsewhere (Edit, a quote) goes in.
test("the message box keeps what you type and select (UC7)", { timeout: 60000 }, async () => {
  const core = core_build();
  const server = await server_start(core);
  const browser = await chromium.launch();
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 400, height: 800 } });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForSelector("#message", { timeout: 15000 });
    await page.click("text=Skip");
    const height = () => page.$eval("#message", (el) => el.getBoundingClientRect().height);
    const empty = await height();
    const place = () =>
      page.$eval("#message", (el) => [el.getBoundingClientRect().left, el.offsetWidth]);
    const [left, width] = await place();
    await page.click("#message");
    await page.waitForTimeout(300);
    assert.equal(await height(), empty, "tapping the box doesn't change its height");
    assert.deepEqual(await place(), [left, width], "tapping the box doesn't move or widen it");
    // Presses inside the message area (its edge, a button) keep the cursor, so the keyboard stays.
    const focused = () => page.evaluate(() => document.activeElement.id);
    const composer = await page.$eval(".composer", (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, h: r.height };
    });
    await page.mouse.click(composer.x + 4, composer.y + composer.h / 2);
    assert.equal(await focused(), "message", "a press on the area's edge keeps the cursor");
    await page.click("[aria-label='Bigger message box']");
    assert.equal(await focused(), "message", "the expand button keeps the cursor");
    await page.click("[aria-label='Smaller message box']");
    await page.waitForFunction(() => !document.querySelector(".composer.big"));
    assert.equal(await focused(), "message", "and back");

    // One line: the buttons beside it. A second line: the buttons under it, the text the whole
    // width with its left edge kept; measured beside the buttons, so it doesn't flip back.
    const stacked = () => page.$eval(".composer", (el) => "stacked" in el.dataset);
    await page.keyboard.type("short");
    assert.equal(await stacked(), false, "one line keeps the buttons beside it");
    const [measured, real] = await page.$eval(".composer", (c) => [
      Math.round(PP.box_side_width(c)),
      Math.round(c.querySelector(".boxscroll").offsetWidth),
    ]);
    assert.equal(measured, real, "the width measured beside the buttons is the real one");
    await page.keyboard.type(" and then a good deal more text, enough to need a second line");
    await page.waitForFunction(
      () => "stacked" in document.querySelector(".composer").dataset,
      null,
      { timeout: 3000 },
    );
    const [left_long, width_long] = await place();
    assert.equal(left_long, left, "the text keeps its left edge");
    assert.ok(
      width_long > width + 60,
      `the buttons went under the text (${width} → ${width_long})`,
    );
    await page.$eval("#message", (el) => el.setSelectionRange(0, el.value.length));
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(100);
    assert.equal(await stacked(), false, "emptied, the buttons are beside the text again");
    assert.deepEqual(await place(), [left, width], "and the box is as it was");

    await page.evaluate(() => {
      window.loud = 0;
      window.heights = [];
      const real = PP.state_set;
      PP.state_set = (change, quiet) => (quiet || window.loud++, real(change, quiet));
      const box = document.getElementById("message");
      new MutationObserver(() => window.heights.push(box.style.height)).observe(box, {
        attributes: true,
        attributeFilter: ["style"],
      });
    });
    await page.keyboard.type("hello world");
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => window.loud), 1, "only going non-empty redrew");
    assert.equal(
      await page.evaluate(() => PP.draft_get(PP.state_get()).text),
      "hello world",
      "the draft has what was typed",
    );

    await page.$eval("#message", (el) => el.setSelectionRange(6, 11));
    await page.evaluate(() => PP.ui_set(() => ({})));
    await page.waitForTimeout(100);
    assert.deepEqual(
      await page.$eval("#message", (el) => [el.selectionStart, el.selectionEnd]),
      [6, 11],
      "a redraw left the selection alone",
    );
    await page.keyboard.type("there");
    assert.equal(await page.inputValue("#message"), "hello there", "typing replaced the selection");

    for (let i = 0; i < 3; i++)
      await page.keyboard.press("Shift+Enter"), await page.keyboard.type("x");
    const grown = await height();
    assert.ok(grown > empty * 2, `the box grew with its lines (${empty} → ${grown})`);
    assert.ok(
      !(await page.evaluate(() => window.heights)).some((h) => h === "auto" || h === "0px"),
      "the box was never collapsed to measure",
    );

    // Many lines: the box is as tall as its text and the container around it scrolls (GeckoView
    // hides selection handles scrolled out of a container, not out of a self-scrolling text box),
    // keeping the line you type on in view.
    for (let i = 0; i < 30; i++) await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("last line");
    await page.waitForTimeout(100);
    const scroll = await page.$eval(".boxscroll", (el) => ({
      box: document.getElementById("message").offsetHeight,
      shown: el.clientHeight,
      bottom: el.scrollTop + el.clientHeight,
      all: el.scrollHeight,
      self:
        document.getElementById("message").scrollHeight -
        document.getElementById("message").clientHeight,
    }));
    assert.ok(scroll.box > scroll.shown, "the box is taller than the part shown");
    assert.ok(scroll.self <= 1, "the box doesn't scroll itself");
    assert.ok(scroll.bottom >= scroll.all - 2, "the line being typed is in view");

    await page.evaluate(() => PP.draft_set("from elsewhere"));
    await page.waitForFunction(
      () => document.getElementById("message").value === "from elsewhere",
      null,
      { timeout: 3000 },
    );
    await page.waitForTimeout(100);
    assert.equal(await height(), empty, "a one-line draft put in sizes the box back down");
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    server.close();
  }
});

// The thinking is one block before and after the reply is in: "Thinking · N s" while it thinks,
// "Thought for N s" once the reply is written, open while the reply streams (UC1.3); folded once
// it's saved; a tap folds or unfolds it, and the saved reply keeps that choice, above the reply.
test(
  "the thinking is one foldable block, while it streams and after (UC1.3)",
  { timeout: 60000 },
  async () => {
    const core = core_build();
    const server = await server_start(core);
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 400, height: 800 } });
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      await page.waitForSelector("#message", { timeout: 15000 });
      await page.click("text=Skip");
      await page.evaluate(async () => {
        const chat = PP.id_create();
        await PP.apply_try((s) =>
          PP.chat_create(s, { id: chat, message: "Hi", folder: "", own: {} }),
        );
        PP.state_set((s) => ({
          ...s,
          ui: { ...s.ui, chat },
          sends: [
            ...s.sends,
            {
              id: "s1",
              turn: "t1",
              chat,
              message: "Why?",
              status: "sending",
              at: new Date().toISOString(),
              thinking: "Because of scattering.",
              thinking_at: Date.now() - 7000,
            },
          ],
        }));
      });
      const row = async () => {
        await page.waitForTimeout(100);
        return page.$eval(".thin[aria-expanded]", (b) => ({
          label: b.textContent.trim(),
          open: b.getAttribute("aria-expanded") === "true",
          shown: !!document.querySelector(".thin + .thinking"),
        }));
      };
      assert.deepEqual(
        await row(),
        { label: "Thinking · 7 s", open: true, shown: true },
        "open while it thinks",
      );
      await page.evaluate(() =>
        PP.state_set((s) => ({
          ...s,
          sends: s.sends.map((x) => ({
            ...x,
            reply: "The answer.",
            writing_at: x.thinking_at + 7000,
          })),
        })),
      );
      assert.deepEqual(
        await row(),
        { label: "Thought for 7 s", open: true, shown: true },
        "open while the reply streams",
      );
      await page.click(".thin[aria-expanded]");
      assert.equal((await row()).open, false, "a tap folds it");
      await page.click(".thin[aria-expanded]");
      assert.equal((await row()).open, true, "and opens it again");
      // Saved: the same block, above the reply, with the choice kept (the turn's id is the send's).
      await page.evaluate(() => {
        const send = PP.state_get().sends[0];
        PP.state_set((s) => ({
          ...s,
          sends: [],
          turns: [
            ...s.turns,
            {
              id: "t1",
              chat: send.chat,
              at: send.at,
              message: "Why?",
              reply: "The answer.",
              thinking: "Because of scattering.",
              thought_ms: 7000,
            },
          ],
        }));
      });
      assert.deepEqual(
        await row(),
        { label: "Thought for 7 s", open: true, shown: true },
        "the saved reply keeps it",
      );
      await page.evaluate(() => {
        const t = PP.state_get().turns[0];
        PP.state_set((s) => ({
          ...s,
          turns: [...s.turns, { ...t, id: "t2", thinking: "Another.", thought_ms: 3000 }],
        }));
      });
      await page.waitForTimeout(100);
      assert.equal(
        await page.$eval("#turn-t2 .thin[aria-expanded]", (b) => b.getAttribute("aria-expanded")),
        "false",
        "a saved reply's thinking is folded unless you opened it",
      );
      assert.ok(
        await page.$eval(
          "#turn-t1 .thin[aria-expanded]",
          (b) =>
            !!(
              b.compareDocumentPosition(document.querySelector("#turn-t1 .ai .md:not(.thought)")) &
              Node.DOCUMENT_POSITION_FOLLOWING
            ),
        ),
        "the thinking is above the reply",
      );
    } finally {
      await browser.close();
      server.close();
    }
  },
);
