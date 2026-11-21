"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { plugins_load } = require("./harness.js");

const pp = plugins_load(["runtime-records", "runtime-profiles"]);

const state_build = (blocks, extra = {}) => ({
  schemas: { settings: [{ key: "chats.profile", default: "p1" }], collections: {} },
  config: { settings: {}, profiles: [{ id: "p1", name: "Story", plugin_settings: {} }], blocks, groups: [], provider_choices: {} },
  prompts: [{ id: "lp1", name: "Library one", text: "From the library." }],
  plugins: [{ id: "base64", manifest: { name: "Base64", tags: [] } }, { id: "memory", manifest: { name: "Memory", tags: [] } }],
  pages: [],
  ...extra,
});
const block = (id, fields) => ({ id, profile: "p1", on: true, ...fields });

test("System prompts follow their rule; empty ones are skipped (UC23)", async () => {
  const s = state_build([
    block("a", { type: "prompt", text: "Always.", send: "every" }),
    block("b", { type: "prompt", text: "First only.", send: "first" }),
    block("c", { type: "prompt", text: "Every third.", send: "every_n", number: 3 }),
    block("d", { type: "prompt", text: "  ", send: "every" }),
    block("e", { type: "prompt", link: "lp1", send: "every" }),
    block("f", { type: "prompt", text: "Off.", send: "every", on: false }),
    block("m", { type: "message" }),
  ]);
  const later = await pp.message_build(s, { chat: null, message: "Hi", count: 2, first: false }, () => null);
  assert.equal(later.text, "Always.\n\nFrom the library.\n\nHi");
  const third = await pp.message_build(s, { chat: null, message: "Hi", count: 3, first: false }, () => null);
  assert.equal(third.text, "Always.\n\nEvery third.\n\nFrom the library.\n\nHi");
  const first = await pp.message_build(s, { chat: null, message: "Hi", count: 1, first: true }, () => null);
  assert.match(first.text, /First only\./);
  assert.deepEqual(later.notes, ["Story: Always., Library one"]);
});

test("plugins change what's above them, only the message, or picked blocks", async () => {
  const upper = async (t) => t.toUpperCase();
  const hooks = { base64: { send_before: upper } };
  const hook_get = (id, name) => (hooks[id] || {})[name];
  const above = state_build([
    block("a", { type: "prompt", text: "rules", send: "every" }),
    block("p", { type: "plugin", plugin: "base64", scope: "above" }),
    block("m", { type: "message" }),
  ]);
  assert.equal((await pp.message_build(above, { message: "hi", count: 1, first: true }, hook_get)).text, "RULES\n\nhi");
  const only = state_build([
    block("a", { type: "prompt", text: "rules", send: "every" }),
    block("m", { type: "message" }),
    block("p", { type: "plugin", plugin: "base64", scope: "message" }),
  ]);
  assert.equal((await pp.message_build(only, { message: "hi", count: 1, first: true }, hook_get)).text, "rules\n\nHI");
  const marks = [];
  const picked = state_build([
    block("a", { type: "prompt", text: "one", send: "every" }),
    block("b", { type: "prompt", text: "two", send: "every" }),
    block("m", { type: "message" }),
    block("p", { type: "plugin", plugin: "base64", scope: "picked", picked: ["a", "message"] }),
  ]);
  const mark = { base64: { send_before: async (t, c) => (marks.push(c.pick), `[${t}]`) } };
  const r = await pp.message_build(picked, { message: "hi", count: 1, first: true }, (id, n) => (mark[id] || {})[n]);
  assert.equal(r.text, "[one]\n\ntwo\n\n[hi]");
  assert.deepEqual(marks, [{ i: 0, n: 2 }, { i: 1, n: 2 }]);
});

test("a plugin's text goes where its block is; depth prompts go before the message", async () => {
  const s = state_build([
    block("x", { type: "plugin", plugin: "memory" }),
    block("d", { type: "prompt", text: "Stay in character.", send: "depth", number: 0 }),
    block("m", { type: "message" }),
  ]);
  const plain = { memory: { block_text: async () => "[memory]" } };
  const r = await pp.message_build(s, { message: "hi", count: 4, first: false }, (id, n) => (plain[id] || {})[n]);
  assert.equal(r.text, "[memory]\n\nStay in character.\n\nhi");
  const used = { memory: { block_text: async (c) => ({ text: `[memory + ${c.depth[0].text}]`, depth_used: true }) } };
  const r2 = await pp.message_build(s, { message: "hi", count: 4, first: false }, (id, n) => (used[id] || {})[n]);
  assert.equal(r2.text, "[memory + Stay in character.]\n\nhi");
});

test("templates carry their texts word for word, and a profile is made from one (X6)", () => {
  const s = state_build([]);
  const story = pp.template_list(s).find((t) => t.id === "story");
  assert.match(story.blocks.find((b) => b.name === "Co-writer").text, /^We're writing a story together\./);
  const made = pp.profile_create(s, { template: "dialogue", name: "Mine", id: "p9" });
  const mine = made.state.config.blocks.filter((b) => b.profile === "p9");
  assert.equal(mine.length, 9);
  assert.equal(mine.find((b) => b.name === "Reminder").send, "every_n");
  assert.ok(mine.every((b) => !("text_file" in b)));
  assert.match(pp.preview_build(made.state, { id: "p9" }, true), /⟨your message⟩/);
});
