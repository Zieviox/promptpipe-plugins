"use strict";
// The screen in a real browser page (Chromium) with the real loader and every runtime plugin, a
// stand-in core answering from memory, and no platform (a desktop browser, B5): it starts, draws
// the chat, opens the chats list, Settings and Find, sends a first message into a new chat, and
// reports no page errors.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const LOADER =
  process.env.PP_LOADER || path.join(ROOT, "..", "app", "app", "src", "main", "assets", "ui");
const SHOT = process.env.PP_SHOT || "";

// The core's calls, from memory: files by "root/path", and the runtime plugins as built in.
const core_build = () => {
  const files = {};
  let n = 0;
  const plugins = fs
    .readdirSync(ROOT)
    .filter((id) => id.startsWith("runtime-") && fs.existsSync(path.join(ROOT, id, "plugin.json")))
    .map((id) => ({
      id,
      copy: "built_in",
      other_copies: [],
      manifest: JSON.parse(fs.readFileSync(path.join(ROOT, id, "plugin.json"), "utf8")),
    }));
  return {
    files,
    plugin_list: () => plugins,
    file_read: ({ root, path: p, pattern }) => {
      if (pattern) {
        const re = new RegExp(`^${pattern.replace(/[.]/g, "\\.").replace(/\*/g, "[^/]*")}$`);
        return Object.keys(files)
          .filter((k) => k.startsWith(`${root}/`) && re.test(k.slice(root.length + 1)))
          .map((k) => ({ path: k, data: files[k], revision: "r" }));
      }
      return files[`${root}/${p}`] === undefined
        ? []
        : [{ path: p, data: files[`${root}/${p}`], revision: "r" }];
    },
    file_write: ({ root, path: p, data }) => (
      (files[`${root}/${p}`] = data), { revision: `r${(n += 1)}` }
    ),
    file_delete: ({ root, path: p }) => (delete files[`${root}/${p}`], {}),
    chats_folder_get: () => ({ folder: "/phone/chats", default: "/phone/chats" }),
  };
};

const server_start = (core) =>
  new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://x");
      const send = (type, body) => (res.writeHead(200, { "content-type": type }), res.end(body));
      if (url.pathname === "/")
        return send("text/html", fs.readFileSync(path.join(LOADER, "index.html")));
      if (url.pathname.startsWith("/ui/"))
        return send("text/javascript", fs.readFileSync(path.join(LOADER, url.pathname.slice(4))));
      if (url.pathname.startsWith("/plugins/")) {
        const file = path.join(ROOT, url.pathname.slice(9));
        const type = file.endsWith(".css")
          ? "text/css"
          : file.endsWith(".js")
            ? "text/javascript"
            : "text/plain";
        return fs.existsSync(file)
          ? send(type, fs.readFileSync(file))
          : (res.writeHead(404), res.end());
      }
      if (url.pathname === "/events")
        return res.writeHead(200, { "content-type": "text/event-stream" });
      if (url.pathname === "/call") {
        let body = "";
        req.on("data", (c) => (body += c));
        return req.on("end", () => {
          const e = JSON.parse(body);
          const answer = core[e.name];
          const reply = answer
            ? { type: "reply", id: e.id, data: answer(e.data) }
            : { type: "reply", id: e.id, error: { code: "unimplemented", message: e.name } };
          send("application/json", JSON.stringify(reply));
        });
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });

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
      assert.equal(await page.$(".drawer"), null);

      await page.keyboard.press("Control+,");
      await page.waitForSelector("text=Prompt library");
      await page.click("text=Look");
      await page.waitForSelector("text=UI scale", { timeout: 3000 }).catch(() => null);
      await page.click("[aria-label='Back']");
      await page.click("text=Plugins");
      await page.waitForSelector("text=Sending");
      await page.click("[aria-label='Close']");

      await page.keyboard.press("Control+k");
      await page.fill("input[aria-label='Find chats and functions']", "prof");
      await page.waitForSelector("text=Next profile");
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
