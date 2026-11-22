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
