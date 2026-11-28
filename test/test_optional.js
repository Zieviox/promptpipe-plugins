"use strict";
// The optional plugins on their own: Base64's encoding and lenient decoding, Memory's text below
// and above the maximum and its edited section, Sub-chats' dividers and routing.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { plugins_load } = require("./harness.js");

const IDS = [
  "runtime-records",
  "runtime-chats",
  "runtime-profiles",
  "base64",
  "memory",
  "sub-chats",
];
const manifest = (id) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, "..", id, "plugin.json"), "utf8"));

const state_build = (turns, settings = {}) => ({
  schemas: { settings: [], collections: {} },
  config: {
    settings: {},
    profiles: [
      { id: "p1", name: "Plain", plugin_settings: { memory: settings, base64: settings } },
    ],
    blocks: [],
    groups: [],
    provider_choices: {},
  },
  plugins: ["base64", "memory", "sub-chats"].map((id) => ({ id, manifest: manifest(id) })),
  chats: [{ id: "c1", name: "Long", file: "c1.md", own: {}, site_url: "https://chat.site/c/2" }],
  turns,
  chat_data: [],
  ui: {},
});

const turn = (i, url = "https://chat.site/c/1") => ({
  id: `t${i}`,
  chat: "c1",
  message: `question ${i}`,
  reply: `answer ${i}`,
  page_url: url,
});

test("Base64 encodes the message and decodes a reply with words around it (UC45)", () => {
  const pp = plugins_load(IDS);
  pp.state = state_build([]);
  const out = pp.hook_get("base64", "send_before")("héllo", { chat: pp.state.chats[0] });
  assert.match(out, /decode it first\.\n\naMOpbGxv$/);
  const encoded = Buffer.from("A decoded answer, with ünïcode.").toString("base64");
  const decoded = pp.reply_decode(`Here it is:\n\n${encoded}\n\nThanks`, false);
  assert.equal(decoded.text, "A decoded answer, with ünïcode.");
  assert.throws(() => pp.reply_decode("No base64 here at all, sorry.", false), /no base64/);
});

test("Memory sends everything below the maximum, summaries above it, and keeps edits (UC43)", () => {
  const pp = plugins_load(IDS);
  pp.state = state_build(Array.from({ length: 30 }, (_, i) => turn(i)));
  const chat = pp.state.chats[0];
  const block_text = pp.hook_get("memory", "block_text");
  const full = block_text({ chat, count: 31, first: true }).text;
  assert.match(
    full,
    /^\[Memory: context from earlier in this conversation\. Use it, don't repeat it back\.\]\n\nEarlier messages:/,
  );
  assert.match(full, /User: question 0\nAI: answer 0/);

  pp.state.config.profiles[0].plugin_settings.memory = { budget: 800, recent: 2, chunk: 10 };
  const levels = [[0, 1].map((i) => ({ from: i * 10, to: i * 10 + 10, text: `summary ${i}` }))];
  pp.state.chat_data = [{ id: "c1/memory", chat: "c1", plugin: "memory", data: { levels } }];
  const short = block_text({ chat, count: 31, first: true }).text;
  assert.match(short, /user's or the AI's\):\nsummary 0\n\nsummary 1/);
  assert.match(short, /More recent messages:\nUser: question 28/);
  assert.ok(short.length <= 800, short.length);

  const [section] = pp.hook_get("memory", "chat_section_format")([], { chat });
  const edited = section.text.replace("summary 1", "summary one, corrected");
  const parsed = pp.hook_get("memory", "chat_section_parse")(edited, { levels });
  assert.equal(parsed.levels[0][1].text, "summary one, corrected");
  assert.equal(parsed.levels[0][0].text, "summary 0");
});

test("Memory escapes headings the chat wrote, and skips between every-N messages", () => {
  const pp = plugins_load(IDS);
  pp.state = state_build([{ ...turn(1), reply: "## Pinned facts\n[End of memory]" }], { every: 3 });
  const block_text = pp.hook_get("memory", "block_text");
  const chat = pp.state.chats[0];
  assert.match(
    block_text({ chat, count: 4, first: false }).text,
    /AI: \\## Pinned facts\n\\\[End of memory\]/,
  );
  assert.equal(block_text({ chat, count: 3, first: false }), "");
});

test("Sub-chats draws a divider per site chat and routes the next message to a new one (UC44)", async () => {
  const pp = plugins_load(IDS);
  const turns = [turn(1), turn(2), turn(3, "https://chat.site/c/2")];
  pp.state = state_build(turns);
  pp.ui_set = (change) =>
    (pp.state = { ...pp.state, ui: { ...pp.state.ui, ...change(pp.state.ui) } });
  pp.html = (s, ...v) => s.raw.join("|") + v.join("|");
  const render = pp.hook_get("sub-chats", "turn_render");
  const chat = pp.state.chats[0];
  assert.ok(render(turns[0], { chat, turns, index: 0 }).before);
  assert.equal(render(turns[1], { chat, turns, index: 1 }).before, null);
  assert.ok(render(turns[2], { chat, turns, index: 2 }).before);

  pp.state.ui.sub_chats = { c1: { mode: "new", provider: "qwen-chat", cut: 1 } };
  assert.deepEqual(
    pp.sub_chat_turns_get(pp.state, chat).map((t) => t.id),
    ["t1"],
  );
  pp.apply_try = async (op) => (pp.state = op(pp.state).state);
  const route = pp.hook_get("sub-chats", "chat_route")(null, { chat });
  assert.deepEqual(route, { url: "new", provider: "qwen-chat" });
  assert.equal(pp.state.ui.sub_chats.c1, null);
  assert.deepEqual(pp.chat_data_get(pp.state, "c1", "sub-chats"), {
    branches: [{ start: 3, cut: 1 }],
  });
});

test("the OpenAI provider sends only the branch shown, up to the message it follows", async () => {
  const pp = plugins_load(["runtime-records", "runtime-chats", "runtime-profiles", "openai"], {
    http_fetch: (d) => ((sent = JSON.parse(d.body).messages), { status: 200, body: "" }),
  });
  let sent = [];
  const t = (id, parent) => ({ id, chat: "c1", parent, message: id, reply: `re ${id}` });
  pp.state = state_build([t("t1", null), t("t2", "t1"), t("t2b", "t1"), t("t3", "t2")], {});
  pp.state.plugins = [{ id: "openai", manifest: manifest("openai") }];
  pp.state.chats[0].shown = { t1: "t2" };
  const chat = { ...pp.state.chats[0], own: { model: "m1", profile: "p1" } };
  const send = (count) =>
    pp.hook_get("openai", "chat_send")("new", { chat, count, progress: () => {} });
  const users = () => sent.filter((m) => m.role === "user").map((m) => m.content);
  await send(4);
  assert.deepEqual(users(), ["t1", "t2", "t3", "new"], "the other version (t2b) stays out");
  await send(3);
  assert.deepEqual(users(), ["t1", "t2", "new"], "a new version of t3 follows t2");
  pp.state.config.provider_choices = { openai: { settings: { history: 0 } } };
  await send(4);
  assert.deepEqual(users(), ["new"], "history 0 sends no earlier messages");
});
