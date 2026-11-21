"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { plugins_load } = require("./harness.js");

const pp = plugins_load(["runtime-records"]);

const state_build = () => ({
  schemas: {
    settings: [
      { key: "chats.provider", type: "choice", default: "deepseek" },
      { key: "chats.profile", type: "choice", default: "p1" },
      { key: "sites.pages", type: "number", default: 5, min: 1 },
    ],
    collections: {
      profiles: { collection: "profiles", place: "config", fields: [{ key: "name", label: "Name", required: true }] },
      blocks: { collection: "blocks", place: "profile" },
      settings: { collection: "settings", place: "settings" },
      sends: { collection: "sends", place: "state" },
      chats: { collection: "chats", place: "chats" },
      prompts: { collection: "prompts", place: "file" },
    },
  },
  config: {
    settings: {},
    profiles: [
      { id: "p1", name: "Plain", blocks: [{ id: "b1", type: "message" }], groups: [], plugin_settings: {} },
      {
        id: "p2",
        name: "Story",
        blocks: [{ id: "b2", type: "prompt", on: true, group: "g1" }],
        groups: [{ id: "g1", on: false }],
        plugin_settings: { memory: { budget: 9 } },
      },
    ],
    provider_choices: { deepseek: { model: "V3", options: { Search: true }, settings: { reply: "x" } } },
  },
  plugins: [
    { id: "memory", manifest: { tags: [], settings: [{ key: "budget", default: 50000 }, { key: "recent", default: 6 }] } },
    { id: "deepseek", manifest: { tags: ["provider", "web"], settings: [{ key: "reply", default: "" }] } },
  ],
  chats: [{ id: "c1", name: "Trip", own: { profile: "p2", options: { Search: false, DeepThink: true } } }],
  chat: { id: "c1", name: "Trip", own: { profile: "p2", options: { Search: false, DeepThink: true } }, turns: [] },
  sends: [],
  prompts: [],
});

test("linked values come from the defaults, own values from the chat (D8)", () => {
  const s = state_build();
  assert.equal(pp.provider_get(s, null), "deepseek");
  assert.equal(pp.profile_get(s, null).id, "p1");
  assert.equal(pp.profile_get(s, s.chat).id, "p2");
  assert.equal(pp.model_get(s, s.chat), "V3");
  assert.deepEqual(pp.options_get(s, s.chat), { Search: false, DeepThink: true });
  assert.equal(pp.setting_get(s, "sites.pages"), 5);
});

test("a block is off when its group is off, unless the chat says otherwise", () => {
  const s = state_build();
  const p2 = s.config.profiles[1];
  assert.equal(pp.block_on_get(p2, s.chat, p2.blocks[0]), false);
  const chat = { ...s.chat, own: { toggles: { g1: true } } };
  assert.equal(pp.block_on_get(p2, chat, p2.blocks[0]), true);
});

test("plugin settings: per profile, a provider's per provider", () => {
  const s = state_build();
  assert.equal(pp.plugin_setting_get(s, s.chat, "memory", "budget"), 9);
  assert.equal(pp.plugin_setting_get(s, s.chat, "memory", "recent"), 6);
  assert.equal(pp.plugin_setting_get(s, s.chat, "deepseek", "reply"), "x");
});

test("create validates, set merges, null goes back to linked", () => {
  const s = state_build();
  assert.ok(pp.record_create(s, { collection: "profiles", fields: {}, id: "p3" }).error);
  const made = pp.record_create(s, { collection: "profiles", fields: { name: "New" }, id: "p3" });
  assert.equal(made.state.config.profiles.length, 3);
  assert.deepEqual(made.targets, [{ file: "config" }]);
  const set = pp.record_set(s, { collection: "chats", id: "c1", fields: { own: { profile: null } } });
  assert.equal(set.record.own.profile, undefined);
  assert.equal(set.state.chat.own.profile, undefined);
  assert.deepEqual(set.state.chat.turns, []);
});

test("nested collections, moves, copies, deletes", () => {
  const s = state_build();
  const add = pp.record_create(s, { collection: "blocks", parent: "p1", fields: { type: "prompt" }, id: "b9", index: 0 });
  assert.deepEqual(add.state.config.profiles[0].blocks.map((b) => b.id), ["b9", "b1"]);
  const moved = pp.record_move(add.state, { collection: "blocks", parent: "p1", id: "b9", index: 1 });
  assert.deepEqual(moved.state.config.profiles[0].blocks.map((b) => b.id), ["b1", "b9"]);
  const copied = pp.record_copy(s, { collection: "profiles", id: "p1", new_id: "p4" });
  assert.equal(copied.state.config.profiles[1].id, "p4");
  assert.notEqual(copied.state.config.profiles[1].blocks, s.config.profiles[0].blocks);
  const gone = pp.record_delete(s, { collection: "profiles", id: "p2" });
  assert.equal(gone.state.config.profiles.length, 1);
  assert.equal(pp.record_get(s, { collection: "profiles", id: "nope" }), null);
});

test("settings keep only what you changed", () => {
  const s = state_build();
  const r = pp.record_set(s, { collection: "settings", fields: { "sites.pages": 3 } });
  assert.equal(pp.setting_get(r.state, "sites.pages"), 3);
  const back = pp.record_delete(r.state, { collection: "settings", id: "sites.pages" });
  assert.deepEqual(back.state.config.settings, {});
});

test("saving writes each file once, with the revision it expects", async () => {
  const written = [];
  const pp2 = plugins_load(["runtime-records"], {
    file_write: (d) => (written.push(d), d.path === "config.json" ? { revision: "r2" } : { outside_change: { path: d.path } }),
  });
  const s = { ...state_build(), revisions: { "app/config.json": "r1" } };
  const r = await pp2.store_save(s, [{ file: "config" }, { file: "config" }, { file: "prompts" }]);
  assert.equal(written.length, 2);
  assert.equal(written[0].expected, "r1");
  assert.equal(r.revisions["app/config.json"], "r2");
  assert.deepEqual(r.changes, [{ path: ".promptpipe/prompts.json" }]);
});
