"use strict";
// The Qwen plugin against a stand-in of today's page (from Gtex's page reports, 2026-11-23): the
// reply holds a status card; tapping it opens a drawer (.ant-drawer-open) with the thinking and a
// Close button; the drawer's own step cards are never to be tapped (that made it full screen).
// While you aren't looking the drawer is kept open and read; shown, it's closed and stays closed.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const CODE = fs.readFileSync(path.join(__dirname, "..", "qwen-chat", "site.js"), "utf8");
// An earlier reply with its own card and thinking is on the page; the new reply (with its card)
// appears after sending (reply_add). Each card opens the drawer on its own reply's thinking.
const PAGE = `
<div class="chat-response-message" id="chat-response-message-old"><div class="qwen-chat-thinking-status-card-title" id="old-card">Thinking completed</div></div>
<div class="ant-drawer" id="drawer">
  <button class="ant-drawer-close" aria-label="Close">×</button>
  <div class="qwen-chat-thinking-and-sources-content-thinking-container">
    <div class="qwen-chat-thinking-status-card-title" id="step">Step one</div>
    <div class="qwen-markdown" id="thought">the earlier thinking</div>
  </div>
</div>
<script>
  window.taps = { card: 0, old: 0, step: 0 };
  const drawer = document.getElementById("drawer");
  const show = (text) => (document.getElementById("thought").textContent = text, drawer.classList.add("ant-drawer-open"));
  document.getElementById("old-card").onclick = () => (taps.old++, show("the earlier thinking"));
  document.getElementById("step").onclick = () => taps.step++;
  document.querySelector(".ant-drawer-close").onclick = () => drawer.classList.remove("ant-drawer-open");
  window.reply_add = () => {
    const reply = document.createElement("div");
    reply.className = "chat-response-message";
    reply.id = "chat-response-message-new";
    reply.innerHTML = '<div class="qwen-chat-thinking-status-card-title" id="card">Thinking</div>';
    drawer.before(reply);
    document.getElementById("card").onclick = () => (taps.card++, show("the thinking"));
  };
</script>`;

const run = (page, script) =>
  page.evaluate(
    async ({ code, script }) => {
      const view = { shown: false };
      const PP = {
        pause: (ms) => new Promise((r) => setTimeout(r, ms)),
        view_shown: () => view.shown,
        stages: {
          visible: (el) => !!el && el.isConnected,
          text_get: (el) => el.textContent,
          thinking_format: (provider, el) => el.textContent.replace(/\s+/g, " ").trim(),
        },
        defaults: {},
      };
      const provider = {
        selectors: { thinking: [".qwen-chat-thinking-and-sources-content-thinking-container"] },
      };
      const stages = new Function("PP", "provider", code)(PP, provider);
      const open = () => document.getElementById("drawer").classList.contains("ant-drawer-open");
      return new Function("PP", "stages", "view", "open", `return (async () => { ${script} })()`)(
        PP,
        stages,
        view,
        open,
      );
    },
    { code: CODE, script },
  );

test(
  "Qwen: the thinking drawer is kept open while you aren't looking, closed when the reply is in",
  { timeout: 30000 },
  async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.setContent(PAGE);
      const out = await run(
        page,
        `PP.defaults.site_send = async () => {
         reply_add();
         await PP.pause(1500);
         const during = open();
         return { reply: "done", thinking: "Thinking completed", during };
       };
       const result = await stages.site_send({}, {});
       return { result, after: open(), taps: window.taps };`,
      );
      assert.equal(out.result.during, true, "open while the reply came (you weren't looking)");
      assert.equal(
        out.result.thinking,
        "Step one the thinking",
        "the whole thinking, from the drawer",
      );
      assert.equal(out.after, false, "closed when the reply was in");
      assert.equal(out.taps.step, 0, "the drawer's step cards are never tapped");
      assert.equal(out.taps.old, 0, "the earlier reply's card is never tapped");
    } finally {
      await browser.close();
    }
  },
);

test(
  "Qwen: showing the site view closes the drawer it opened, and it's not opened while you look",
  { timeout: 30000 },
  async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.setContent(PAGE);
      const out = await run(
        page,
        `PP.defaults.site_send = async () => {
         reply_add();
         await PP.pause(1000);
         view.shown = true;            // the site view opens on this page
         await stages.site_shown({ shown: true });
         const closed = !open();
         await PP.pause(1500);          // you look a while
         return { reply: "done", thinking: "", closed, reopened: open() };
       };
       const result = await stages.site_send({}, {});
       document.getElementById("drawer").classList.add("ant-drawer-open"); // you open it yourself
       const back = await stages.site_back();
       return { result, back, after_back: open(), taps: window.taps };`,
      );
      assert.equal(out.result.closed, true, "closed before you saw the page");
      assert.equal(out.result.reopened, false, "not opened again while you looked");
      assert.deepEqual(out.back, { closed: true }, "Back closes a drawer you opened");
      assert.equal(out.after_back, false);
      assert.equal(out.taps.step, 0);
    } finally {
      await browser.close();
    }
  },
);

test(
  "Qwen: the new reply's thinking, never the earlier reply's the drawer was showing",
  { timeout: 30000 },
  async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.setContent(PAGE);
      const out = await run(
        page,
        `document.getElementById("old-card").click();   // the drawer is open on the earlier reply
         window.taps.old = 0;
         PP.defaults.site_send = async () => {
           await PP.pause(1300);                       // before the new reply shows: nothing to open
           const early = { open: open(), card: window.taps.card };
           reply_add();
           await PP.pause(1500);
           return { reply: "done", thinking: "", early, during: open() && document.getElementById("thought").textContent };
         };
         const result = await stages.site_send({}, {});
         return { result, taps: window.taps };`,
      );
      assert.equal(out.result.early.card, 0, "nothing opened before the new reply was there");
      assert.equal(out.result.during, "the thinking", "the drawer was moved to the new reply");
      assert.equal(out.result.thinking, "Step one the thinking", "the new reply's thinking");
      assert.equal(out.taps.old, 0, "the earlier reply's card is never tapped");
    } finally {
      await browser.close();
    }
  },
);
