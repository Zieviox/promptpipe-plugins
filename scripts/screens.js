"use strict";
// Screenshots of the screen with the wireframe's sample content (design/ux/wireframe.html), for
// comparing the two side by side: node scripts/screens.js <folder> [light]
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const { core_build, server_start } = require("../test/standin.js");

const OUT = process.argv[2] || ".";
const LIGHT = process.argv[3] === "light";
const at = (m) => `2026-11-21T0${m}:00:00.000Z`;

// The wireframe's chats, folders, profile and two exchanges, as the app's own files.
const sample = (core) => {
  const put = (root, file, data) => (core.files[`${root}/${file}`] = JSON.stringify(data));
  const blocks = [
    {
      id: "b1",
      profile: "p1",
      type: "prompt",
      name: "Story voice",
      text: "Write in a quiet, close voice.",
      send: "every",
      number: 5,
      on: true,
    },
    { id: "b2", profile: "p1", type: "plugin", plugin: "memory", scope: "above", on: true },
    {
      id: "b3",
      profile: "p1",
      type: "prompt",
      name: "No clichés",
      text: "Avoid clichés.",
      send: "every",
      number: 5,
      on: true,
    },
    { id: "b4", profile: "p1", type: "message" },
  ];
  put("app", "config.json", {
    version: 1,
    settings: { "chats.profile": "p1", "chats.provider": "qwen-chat", "help.seen": ["welcome"] },
    profiles: [{ id: "p1", name: "Story writing", plugin_settings: {} }],
    blocks,
    groups: [],
    templates: [],
    provider_choices: { "qwen-chat": { model: "Qwen3-Max" } },
    connections: [],
    sources: [],
  });
  put("chats", ".promptpipe/folders.json", [
    { id: "", order: [], pinned: ["c1"] },
    { id: "Worlds", order: [] },
    { id: "Drafts", order: [] },
  ]);
  const chats = [
    ["c1", "Harbour story draft", "Harbour story draft.md", ["story", "draft", "rp"]],
    ["c2", "Character sheet: Ilse", "Worlds/Character sheet Ilse.md", ["rp", "characters"]],
    ["c3", "Plot knots", "Worlds/Plot knots.md", ["story"]],
    ["c4", "Feedback on chapter 3", "Feedback on chapter 3.md", ["feedback", "draft"]],
    ["c5", "Plain test", "Plain test.md", []],
  ];
  chats.forEach(([id, name, file, tags], i) =>
    put("chats", `.promptpipe/chats/${id}/meta.json`, {
      id,
      name,
      file,
      tags,
      own: {},
      created: at(i + 1),
      updated: at(i + 1),
    }),
  );
  const turn = (id, message, reply, tags = []) => ({
    id,
    chat: "c1",
    at: at(1),
    message,
    reply,
    thinking: "Shorter, darker, keep the rock.",
    thought_ms: 14000,
    sent: message,
    received: reply,
    tags,
    profile: "Story writing",
    model: "Qwen3-Max",
    page_url: "https://chat.qwen.ai/c/1",
    blocks: ["Story voice", "Memory", "No clichés", "Your message"],
    notes: [],
  });
  put("chats", ".promptpipe/chats/c1/turns.json", [
    turn(
      "t1",
      "Make the second paragraph shorter and darker.",
      "It was low and salt-grey. Warm, which the rock never was.",
    ),
    turn("t2", "Good. Now the door.", "The door had no handle, only a hum.", [
      "draft",
      "story",
      "rp",
    ]),
  ]);
};

(async () => {
  const core = core_build(
    (id) =>
      id.startsWith("runtime-") ||
      ["qwen-chat", "deepseek", "memory", "sub-chats", "base64"].includes(id),
  );
  sample(core);
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
      "4-quick",
      async () => {
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
