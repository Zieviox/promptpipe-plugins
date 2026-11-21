"use strict";
// The default routine in a real browser page (Chromium): a stand-in site that answers slowly,
// with a table and thinking, and refuses a message on demand.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const SITE = path.join(__dirname, "..", "runtime-site");
const code = ["vendor/turndown.js", "vendor/turndown-plugin-gfm.js", "routine.js"]
  .map((f) => fs.readFileSync(path.join(SITE, f), "utf8"))
  .join("\n;\n");

const PAGE = `<!doctype html><body>
<div id="chat"></div>
<textarea id="box"></textarea><button id="send">Send</button>
<script>
  const chat = document.getElementById("chat");
  document.getElementById("send").onclick = () => {
    const box = document.getElementById("box");
    const text = box.value; box.value = "";
    chat.insertAdjacentHTML("beforeend", '<div class="you">' + text + '</div>');
    if (text === "refuse") return chat.insertAdjacentHTML("beforeend", '<div class="refusal">Content too long</div>');
    const stop = document.createElement("button"); stop.className = "stop"; stop.textContent = "Stop"; document.body.append(stop);
    const reply = document.createElement("div"); reply.className = "reply"; chat.append(reply);
    const think = document.createElement("div"); think.className = "think"; think.textContent = "Let me think"; reply.before(think);
    let n = 0;
    const timer = setInterval(() => {
      n += 1;
      reply.innerHTML = n < 3 ? "<p>Part " + n + "</p>" : "<p>Done:</p><table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>";
      if (n === 3) { clearInterval(timer); stop.remove(); }
    }, 300);
  };
</script></body>`;

const provider = {
  id: "fake",
  selectors: {
    input: ["#box"],
    send: ["#send"],
    stop: [".stop"],
    reply: [".reply"],
    user: [".you"],
    thinking: [".think"],
  },
  settle_ms: 400,
};

test("the default routine sends, waits and reads the reply as Markdown (UC1, D5)", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(PAGE);
    const result = await page.evaluate(
      async ({ code, provider }) => {
        const events = [];
        const PP = {
          event_send: (n, d) => events.push(d.progress),
          pause: (ms) => new Promise((r) => setTimeout(r, ms)),
          cancelled: () => false,
          stages: {},
        };
        const own = {
          error_find: () => {
            const r = document.querySelector(".refusal");
            return r ? { text: r.textContent, el: r } : null;
          },
        };
        const stages = new Function("PP", "provider", code)(PP, provider);
        Object.assign(PP.stages, stages, own);
        const answer = await stages.site_send({ text: "hello", limits: {} }, provider);
        let refused = null;
        try {
          await stages.site_send({ text: "refuse", limits: {} }, provider);
        } catch (e) {
          refused = e.message;
        }
        const all = await stages.site_read({ which: "all" }, provider);
        return { answer, events, refused, all, ready: stages.ready_get(provider) };
      },
      { code, provider },
    );
    assert.equal(result.answer.reply, "Done:\n\n| a | b |\n| --- | --- |\n| 1 | 2 |");
    assert.ok(result.events.some((e) => /writing/.test(e)));
    assert.equal(result.refused, "Content too long");
    assert.equal(result.all[0].message, "hello");
    assert.equal(result.ready, true);
  } finally {
    await browser.close();
  }
});
