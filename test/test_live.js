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
      // Like Qwen: the answer element holds a markdown element, and the provider names all three;
      // the first user selector finds only the newest message (older ones lack its wrapper).
      await page.setContent(`<div class="umc">first</div>
      <div class="resp"><div class="answer"><div class="md">one</div></div></div>
      <div class="u"><div class="umc">hi</div></div>
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
        [
          ["first", "one"],
          ["hi", "hello there"],
        ],
      );
    } finally {
      await browser.close();
    }
  },
);

test(
  "attached files go into the site's upload input before the message is sent",
  { timeout: 30000 },
  async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.setContent(`<input type="file" id="up" multiple style="display:none">
      <textarea id="in"></textarea><button id="send" disabled>Send</button><div id="log"></div>
      <script>
        window.got = [];
        document.getElementById("up").addEventListener("change", async (e) => {
          for (const f of e.target.files) got.push({ name: f.name, type: f.type, text: await f.text() });
          setTimeout(() => (document.getElementById("send").disabled = false), 400); // "uploaded"
        });
        document.getElementById("send").onclick = () => {
          const a = document.createElement("div"); a.className = "answer"; a.textContent = "Got your file."; log.append(a);
        };
      </script>`);
      const out = await page.evaluate(async (code) => {
        const PP = {
          event_send: () => {},
          pause: (ms) => new Promise((r) => setTimeout(r, ms)),
          cancelled: () => false,
          stages: {},
          defaults: {},
        };
        const provider = {
          id: "x",
          settle_ms: 500,
          selectors: { input: ["#in"], send: ["#send"], reply: [".answer"], upload: ["#up"] },
        };
        const stages = new Function("PP", "provider", code)(PP, provider);
        const result = await stages.site_send(
          {
            text: "see the file",
            limits: {},
            attachments: [{ name: "note.txt", mime_type: "text/plain", data: btoa("hello file") }],
          },
          provider,
        );
        return { got: window.got, reply: result.reply };
      }, CODE);
      assert.deepEqual(out.got, [{ name: "note.txt", type: "text/plain", text: "hello file" }]);
      assert.equal(out.reply, "Got your file.");
    } finally {
      await browser.close();
    }
  },
);

test(
  "live thinking follows the shown step title, not an earlier reply's thinking left hidden",
  { timeout: 30000 },
  async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.setContent(`<div class="drawer-think" style="display:none">an earlier reply's thinking</div>
      <textarea id="in"></textarea><button id="send">Send</button><div id="log"></div>
      <script>
        document.getElementById("send").onclick = () => {
          const box = document.getElementById("in"); box.value = "";
          const u = document.createElement("div"); u.className = "user"; u.textContent = "hi"; log.append(u);
          const stop = document.createElement("button"); stop.id = "stop"; document.body.appendChild(stop);
          const title = document.createElement("div"); title.className = "step"; log.append(title);
          const answer = document.createElement("div"); answer.className = "answer"; log.append(answer);
          const steps = ["Reading the question", "Weighing it up", "Writing"];
          let i = 0;
          const t = setInterval(() => {
            if (i < steps.length) title.textContent = steps[i];
            else answer.textContent += " word";
            if (++i >= 8) clearInterval(t), stop.remove();
          }, 250);
        };
      </script>`);
      const events = await page.evaluate(async (code) => {
        const events = [];
        const PP = {
          event_send: (n, d) => events.push(d),
          pause: (ms) => new Promise((r) => setTimeout(r, ms)),
          cancelled: () => false,
          stages: {},
          defaults: {},
        };
        const provider = {
          id: "x",
          settle_ms: 600,
          selectors: {
            input: ["#in"],
            send: ["#send"],
            stop: ["#stop"],
            reply: [".answer"],
            user: [".user"],
            thinking: [".drawer-think", ".step"],
          },
        };
        const stages = new Function("PP", "provider", code)(PP, provider);
        await stages.site_send({ text: "hi", limits: {} }, provider);
        return events;
      }, CODE);
      const thoughts = [...new Set(events.map((e) => e.thinking).filter(Boolean))];
      assert.deepEqual(thoughts.slice(0, 3), ["Reading the question", "Weighing it up", "Writing"]);
    } finally {
      await browser.close();
    }
  },
);
