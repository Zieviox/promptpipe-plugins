"use strict";
// The chats drawer in Chromium with the wireframe's sample chats: moving a chat into a folder moves
// its file (the old one is deleted), renaming a folder moves its chats' files, deleting asks
// first, press and hold starts selecting, and the select bar pins (UC16, UC17).
const test = require("node:test");
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { core_build, server_start, sample_put } = require("./standin.js");

const pick = (id) => id.startsWith("runtime-") || ["qwen-chat", "memory"].includes(id);

test(
  "the drawer moves, renames, deletes with a confirm, and selects (UC17)",
  { timeout: 60000 },
  async () => {
    const core = core_build(pick);
    sample_put(core);
    const server = await server_start(core);
    const browser = await chromium.launch();
    const errors = [];
    try {
      const page = await browser.newPage({ viewport: { width: 360, height: 740 } });
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      await page.waitForSelector("#message", { timeout: 15000 });
      const has = (path) => core.files[`chats/${path}`] !== undefined;

      // Into a folder: the file moves and the old one goes.
      await page.evaluate(() => PP.chats_move(["c5"], { folder: "Worlds" }, "test move"));
      await page.waitForFunction(
        () => PP.state_get().chats.find((c) => c.id === "c5").file === "Worlds/Plain test.md",
      );
      await page.waitForTimeout(200);
      assert.ok(has("Worlds/Plain test.md") && !has("Plain test.md"), "the chat's file moved");

      // Rename a folder from its sheet.
      await page.click("[aria-label='Chats']");
      await page.click("[aria-label='Rename or delete folder Worlds']");
      await page.fill(".sheet input[aria-label='Folder name']", "Places");
      await page.click(".sheet .item.prim");
      await page.waitForFunction(
        () => PP.state_get().chats.find((c) => c.id === "c3").file === "Places/Plot knots.md",
      );
      await page.waitForTimeout(200);
      assert.ok(
        has("Places/Plot knots.md") && !has("Worlds/Plot knots.md"),
        "renaming moved its chats",
      );

      // Press and hold a row: selecting; Pin from the bar.
      const row = page.locator(".row", { hasText: "Feedback on chapter 3" }).locator(".ct");
      const box = await row.boundingBox();
      await page.mouse.move(box.x + 20, box.y + box.height / 2);
      await page.mouse.down();
      await page.waitForTimeout(650);
      await page.mouse.up();
      await page.waitForSelector(".selbar");
      await page.click(".selbar .pill:has-text('Pin')");
      await page.waitForFunction(() =>
        PP.state_get()
          .folders.find((f) => f.id === "")
          .pinned.includes("c4"),
      );

      // Delete asks first; Cancel keeps the chat.
      await page.evaluate(() => PP.chats_delete_ask(["c4"]));
      await page.waitForSelector(".dialog");
      await page.click(".dialog .pill:has-text('Cancel')");
      assert.ok(
        await page.evaluate(() => PP.state_get().chats.some((c) => c.id === "c4")),
        "Cancel kept it",
      );
      await page.evaluate(() => PP.chats_delete_ask(["c4"]));
      await page.click(".dialog .pill:has-text('Delete')");
      await page.waitForFunction(() => !PP.state_get().chats.some((c) => c.id === "c4"));

      // A profile picked in a chat is the chat's own, and new chats start with it.
      await page.evaluate(() =>
        PP.apply_try((s) =>
          PP.record_create(s, {
            collection: "profiles",
            id: "p2",
            fields: { name: "Feedback", plugin_settings: {} },
          }),
        ),
      );
      await page.evaluate(() =>
        PP.profile_pick(
          PP.state_get().chats.find((c) => c.id === "c1"),
          "p2",
        ),
      );
      await page.waitForFunction(
        () => PP.state_get().chats.find((c) => c.id === "c1").own.profile === "p2",
      );
      assert.equal(
        await page.evaluate(() => PP.setting_get(PP.state_get(), "chats.profile")),
        "p2",
      );

      assert.deepEqual(
        errors.filter((e) => !/not supported on this platform|unimplemented/.test(e)),
        [],
      );
    } finally {
      await browser.close();
      server.close();
    }
  },
);

// However many chats there are, Settings and Quick start stay at the bottom of the drawer and
// only the chats scroll (the spec's Settings pill, bottom left).
test("the drawer keeps Settings in reach with many chats (UC16)", { timeout: 60000 }, async () => {
  const core = core_build(pick);
  const server = await server_start(core);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 400, height: 800 } });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForSelector("#message", { timeout: 15000 });
    await page.click("text=Skip");
    await page.evaluate(async () => {
      for (let i = 0; i < 40; i++)
        await PP.apply_try((s) =>
          PP.chat_create(s, { id: PP.id_create(), message: `Chat ${i}`, folder: "", own: {} }),
        );
    });
    await page.click("[aria-label='Chats']");
    await page.waitForSelector(".drawer");
    const bottom = await page.$eval(".drawerfoot", (e) => e.getBoundingClientRect().bottom);
    assert.ok(bottom <= 800, `the foot is on screen (bottom at ${bottom})`);
    await page.click(".drawerfoot >> text=Settings");
    await page.waitForSelector("text=Prompt library", { timeout: 3000 });
  } finally {
    await browser.close();
    server.close();
  }
});
