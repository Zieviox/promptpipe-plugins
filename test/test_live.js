"use strict";
// The default routine in a real browser page against a stand-in site that streams its thinking
// and its reply: progress goes to the app while they're written, not only at the end, and the
// reply's numbers-only log counts the updates sent.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const SITE = path.join(__dirname, "..", "runtime-site");
const CODE = ["vendor/turndown.js", "vendor/turndown-plugin-gfm.js", "routine.js"]
  .map((f) => fs.readFileSync(path.join(SITE, f), "utf8"))
  .join("\n;\n");

// "in turn": thinking, then the reply word by word. "together": a short reply shows at once
// while the thinking keeps growing (as Qwen did on the phone).
const page_build = (
  mode,
) => `<textarea id="in"></textarea><button id="send">Send</button><div id="log"></div>
<script>
  document.getElementById("send").onclick = () => {
    const box = document.getElementById("in");
    const you = document.createElement("div"); you.className = "user"; you.textContent = box.value;
    box.value = "";
    const stop = document.createElement("button"); stop.id = "stop"; document.body.appendChild(stop);
    const think = document.createElement("div"); think.className = "think";
    const answer = document.createElement("div"); answer.className = "answer";
    log.append(you, think, answer);
    let i = 0;
    const timer = setInterval(() => {
      i += 1;
      if ("${mode}" === "together") {
        if (i === 1) answer.textContent = "Short answer.";
        if (i <= 8) think.textContent += " thought" + i;
        if (i >= 8) clearInterval(timer), stop.remove();
        return;
      }
      if (i <= 6) think.textContent += " thought" + i; else answer.textContent += " word" + i;
      if (i >= 15) clearInterval(timer), stop.remove();
    }, 200);
  };
</script>`;

const run = async (mode, stop = true) => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(page_build(mode));
    return await page.evaluate(
      async ({ code, stop }) => {
        const events = [];
        const PP = {
          event_send: (name, data) => events.push({ name, ...data }),
          pause: (ms) => new Promise((r) => setTimeout(r, ms)),
          cancelled: () => false,
          stages: {},
          defaults: {},
        };
        const provider = {
          id: "x",
          settle_ms: 800,
          selectors: {
            input: ["#in"],
            send: ["#send"],
            stop: [stop ? "#stop" : "#no-such-stop"], // Qwen's Stop wasn't found on the phone
            reply: [".answer"],
            user: [".user"],
            thinking: [".think"],
          },
        };
        const stages = new Function("PP", "provider", code)(PP, provider);
        const result = await stages.site_send({ text: "hi", limits: {} }, provider);
        return { events, result };
      },
      { code: CODE, stop },
    );
  } finally {
    await browser.close();
  }
};

test(
  "progress goes to the app while the reply is written (live thinking and reply)",
  { timeout: 30000 },
  async () => {
    const out = await run("in turn");
    const thinking = out.events.filter((e) => e.thinking && !e.reply);
    const writing = out.events.filter((e) => e.reply);
    assert.ok(thinking.length >= 3, `thinking came in parts (${thinking.length})`);
    assert.ok(writing.length >= 3, `the reply came in parts (${writing.length})`);
    assert.ok(writing[0].reply.length < out.result.reply.length, "the first part is partial");
    assert.equal(out.result.diagnostics.sent, out.events.length, "the log counts what it sent");
  },
);

test(
  "thinking that grows after the reply shows still goes to the app, and the read waits for it",
  { timeout: 30000 },
  async () => {
    const out = await run("together", false);
    const after = out.events.filter((e) => e.reply && e.thinking);
    assert.ok(after.length >= 4, `thinking updates after the reply showed (${after.length})`);
    assert.match(out.result.thinking, /thought8$/, "the read waited for the whole thinking");
    assert.equal(out.result.reply, "Short answer.");
  },
);

test(
  "reading all of a page's messages finds each reply once, when selectors find nested parts",
  { timeout: 30000 },
  async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      // Like Qwen: the answer element holds a markdown element, and the provider names all three.
      await page.setContent(`<div class="u"><div class="umc">hi</div></div>
      <div class="resp"><div class="answer"><div class="md">hello there</div></div></div>`);
      const turns = await page.evaluate(async (code) => {
        const PP = {
          event_send: () => {},
          pause: (ms) => new Promise((r) => setTimeout(r, ms)),
          cancelled: () => false,
          stages: {},
          defaults: {},
        };
        const provider = {
          id: "x",
          selectors: {
            user: [".u .umc", ".umc"],
            reply: [".answer", ".resp .md", ".md"],
            input: ["#none"],
            send: ["#none"],
          },
        };
        const stages = new Function("PP", "provider", code)(PP, provider);
        return stages.site_read({ which: "all" }, provider);
      }, CODE);
      assert.deepEqual(
        turns.map((t) => [t.message, t.reply]),
        [["hi", "hello there"]],
      );
    } finally {
      await browser.close();
    }
  },
);
