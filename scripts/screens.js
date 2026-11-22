"use strict";
// Screenshots of the screen with the wireframe's sample content (design/ux/wireframe.html), for
// comparing the two side by side: node scripts/screens.js <folder> [light]
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const { core_build, server_start, sample_put } = require("../test/standin.js");

const OUT = process.argv[2] || ".";
const LIGHT = process.argv[3] === "light";
(async () => {
  const core = core_build(
    (id) =>
      id.startsWith("runtime-") ||
      ["qwen-chat", "deepseek", "memory", "sub-chats", "base64"].includes(id),
  );
  sample_put(core);
  const server = await server_start(core);
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 360, height: 740 },
    colorScheme: LIGHT ? "light" : "dark",
    deviceScaleFactor: 1,
  });
  page.on("pageerror", (e) => console.log("page error:", e.message));
  const shot = async (name) => {
    await page.waitForTimeout(350);
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  };
  const click = (sel) => page.locator(sel).first().click({ timeout: 3000 });
  const base = `http://127.0.0.1:${server.address().port}/`;
  const steps = [
    [
      "1-chat",
      async () => {
        await click("[aria-label='Chats']");
        await page.getByText("Harbour story draft").first().click();
      },
    ],
    [
      "2-drawer",
      async () => {
        await click("[aria-label='Chats']");
      },
    ],
    [
      "3-find",
      async () => {
        await page.keyboard.press("Control+k");
      },
    ],
    [
      "3b-find-typed",
      async () => {
        await page.keyboard.press("Control+k");
        await page.waitForSelector("input[aria-label='Find chats and functions']");
        await page.waitForTimeout(100);
        await page.keyboard.type("scale");
      },
    ],
    [
      "3c-find-lit",
      async () => {
        await page.keyboard.press("Control+k");
        await page.waitForSelector("input[aria-label='Find chats and functions']");
        await page.waitForTimeout(100);
        await page.keyboard.type("scale");
        await page.locator('.item[data-lit="UI scale"]').first().click();
      },
    ],
    [
      "4-quick",
      async () => {
        await click("[aria-label='Chats']");
        await page.getByText("Harbour story draft").first().click();
        await click("[aria-label='Quick edit and add']");
      },
    ],
    [
      "5-chatsheet",
      async () => {
        await click("[aria-label='Chats']");
        await page.getByText("Harbour story draft").first().click();
        await click("[aria-label='Chat title']");
      },
    ],
    [
      "6-pill",
      async () => {
        await click("[aria-label='Switch provider']");
      },
    ],
    [
      "7-settings",
      async () => {
        await page.keyboard.press("Control+,");
      },
    ],
    [
      "8-plugins",
      async () => {
        await page.keyboard.press("Control+Shift+P");
      },
    ],
    [
      "9-site",
      async () => {
        await click("[aria-label='Chats']");
        await page.getByText("Harbour story draft").first().click();
        // No platform here to open a real page: one is put into the State, as page_open would.
        await page.evaluate(() =>
          PP.state_set((s) => ({
            ...s,
            pages: [
              {
                id: "pg1",
                provider: "qwen-chat",
                url: "https://chat.qwen.ai/c/8f21",
                title: "Harbour story draft",
                status: "ready",
              },
            ],
          })),
        );
        await click("[aria-label='Switch provider']");
        await page.getByText("Show the page").first().click();
      },
    ],
    [
      "11-help",
      async () => {
        await click("[aria-label='Chats']");
        await page.getByText("Harbour story draft").first().click();
        await click("[aria-label='Help: tap, then tap anything']");
        await click("[aria-label='Quick edit and add']");
      },
    ],
  ];
  for (const [name, run] of steps) {
    try {
      await page.goto(base);
      await page.waitForSelector("#message", { timeout: 15000 });
      await run();
      await shot(name);
    } catch (e) {
      console.log(name, e.message.split("\n")[0]);
    }
  }
  await browser.close();
  server.close();
})();
