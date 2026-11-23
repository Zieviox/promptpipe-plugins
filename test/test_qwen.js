"use strict";
// The Qwen plugin in a real browser page. Its thinking card is never clicked (clicking made Qwen's
// panel full screen on a phone, without its close button); the default routine reads the thinking
// folded or not. Back's site_back closes a thinking panel open over the chat.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const CODE = fs.readFileSync(path.join(__dirname, "..", "qwen-chat", "site.js"), "utf8");

test(
  "Qwen: the thinking card is never clicked; Back closes a thinking panel you opened",
  { timeout: 30000 },
  async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.setContent(
        '<div class="qwen-chat-thinking-status-card-title" id="card">Thinking</div>' +
          '<div class="ant-drawer" id="panel" hidden><button class="ant-drawer-close" aria-label="Close">×</button>' +
          '<div class="qwen-chat-thinking-and-sources-content-thinking-container">the thinking</div></div>',
      );
      const out = await page.evaluate(async (code) => {
        let clicks = 0;
        document.getElementById("card").onclick = () => (clicks += 1);
        document.querySelector(".ant-drawer-close").onclick = () =>
          (document.getElementById("panel").hidden = true);
        const PP = {
          pause: (ms) => new Promise((r) => setTimeout(r, ms)),
          stages: {
            visible: (el) => !!el && el.isConnected && !el.closest("[hidden]"),
            text_get: (el) => el.textContent,
          },
          defaults: { site_send: async () => ({ reply: "done", thinking: "from the routine" }) },
        };
        const provider = {
          selectors: { thinking: [".qwen-chat-thinking-and-sources-content-thinking-container"] },
        };
        const stages = new Function("PP", "provider", code)(PP, provider);
        const result = await stages.site_send({}, provider);
        const no_panel = await stages.site_back();
        document.getElementById("panel").hidden = false; // you open it on the site
        const back = await stages.site_back();
        return { clicks, result, no_panel, back, closed: document.getElementById("panel").hidden };
      }, CODE);
      assert.equal(out.clicks, 0, "the card is never clicked");
      assert.equal(out.result.thinking, "from the routine");
      assert.deepEqual(
        out.no_panel,
        { closed: false },
        "no panel: Back goes on to close the site view",
      );
      assert.deepEqual(out.back, { closed: true });
      assert.equal(out.closed, true);
    } finally {
      await browser.close();
    }
  },
);
