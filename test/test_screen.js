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
    const place = () => page.$eval("#message", (el) => [el.getBoundingClientRect().left, el.offsetWidth]);
    const [left, width] = await place();
    await page.click("#message");
    await page.waitForTimeout(300);
    assert.equal(await height(), empty, "tapping the box doesn't change its height");
    const [left_typing, width_typing] = await place();
    assert.equal(left_typing, left, "the text keeps its left edge");
    assert.ok(width_typing > width + 60, `the buttons went under the text (${width} → ${width_typing})`);

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

    for (let i = 0; i < 3; i++) await page.keyboard.press("Shift+Enter"), await page.keyboard.type("x");
    const grown = await height();
    assert.ok(grown > empty * 2, `the box grew with its lines (${empty} → ${grown})`);
    assert.ok(
      !(await page.evaluate(() => window.heights)).some((h) => h === "auto" || h === "0px"),
      "the box was never collapsed to measure",
    );

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
