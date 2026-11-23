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
      profiles: {
        collection: "profiles",
        file: "config",
        fields: [{ key: "name", label: "Name", required: true }],
      },
      blocks: { collection: "blocks", file: "config", parent: "profile", owner: "profiles" },
      groups: { collection: "groups", file: "config", parent: "profile", owner: "profiles" },
      settings: { collection: "settings", file: "config" },
      sends: { collection: "sends" },
      chats: { collection: "chats", file: "chat" },
      turns: { collection: "turns", file: "chat", parent: "chat" },
      prompts: { collection: "prompts", file: "prompts" },
    },
  },
  config: {
    settings: {},
    profiles: [
      { id: "p1", name: "Plain", plugin_settings: {} },
      { id: "p2", name: "Story", plugin_settings: { memory: { budget: 9 } } },
    ],
    blocks: [
      { id: "b1", profile: "p1", type: "message" },
      { id: "b2", profile: "p2", type: "prompt", on: true, group: "g1" },
    ],
    groups: [{ id: "g1", profile: "p2", on: false }],
    provider_choices: {
      deepseek: { model: "V3", options: { Search: true }, settings: { reply: "x" } },
    },
  },
  plugins: [
    {
      id: "memory",
      manifest: {
        tags: [],
        settings: [
          { key: "budget", default: 50000 },
          { key: "recent", default: 6 },
        ],
      },
    },
    {
      id: "deepseek",
      manifest: { tags: ["provider", "web"], settings: [{ key: "reply", default: "" }] },
    },
  ],
  chats: [
    { id: "c1", name: "Trip", own: { profile: "p2", options: { Search: false, DeepThink: true } } },
  ],
  turns: [],
  sends: [],
  prompts: [],
});

test("linked values come from the defaults, own values from the chat (D8)", () => {
  const s = state_build();
  assert.equal(pp.provider_get(s, null), "deepseek");
  assert.equal(pp.profile_get(s, null).id, "p1");
  assert.equal(pp.profile_get(s, s.chats[0]).id, "p2");
  assert.equal(pp.model_get(s, s.chats[0]), "V3");
  assert.deepEqual(pp.options_get(s, s.chats[0]), { Search: false, DeepThink: true });
  assert.equal(pp.setting_get(s, "sites.pages"), 5);
});

test("a block is off when its group is off, unless the chat says otherwise", () => {
  const s = state_build();
  const b2 = s.config.blocks[1];
  assert.equal(pp.block_on_get(s, s.chats[0], b2), false);
  const chat = { ...s.chats[0], own: { toggles: { g1: true } } };
  assert.equal(pp.block_on_get(s, chat, b2), true);
});

test("plugin settings: per profile, a provider's per provider", () => {
  const s = state_build();
  assert.equal(pp.plugin_setting_get(s, s.chats[0], "memory", "budget"), 9);
  assert.equal(pp.plugin_setting_get(s, s.chats[0], "memory", "recent"), 6);
  assert.equal(pp.plugin_setting_get(s, s.chats[0], "deepseek", "reply"), "x");
});

test("create validates, set merges, null goes back to linked", () => {
  const s = state_build();
  assert.ok(pp.record_create(s, { collection: "profiles", fields: {}, id: "p3" }).error);
  const made = pp.record_create(s, { collection: "profiles", fields: { name: "New" }, id: "p3" });
  assert.equal(made.state.config.profiles.length, 3);
  assert.deepEqual(made.targets, [{ file: "config", id: "p3" }]);
  const set = pp.record_set(s, {
    collection: "chats",
    id: "c1",
    fields: { own: { profile: null } },
  });
  assert.equal(set.record.own.profile, undefined);
  assert.equal(set.state.chats[0].own.profile, undefined);
  assert.deepEqual(set.targets, [{ chat: "c1" }]);
});

test("nested collections, moves, copies, deletes", () => {
  const s = state_build();
  const ids = (st, p) => st.config.blocks.filter((b) => b.profile === p).map((b) => b.id);
  const add = pp.record_create(s, {
    collection: "blocks",
    fields: { profile: "p1", type: "prompt" },
    id: "b9",
    index: 0,
  });
  assert.deepEqual(ids(add.state, "p1"), ["b9", "b1"]);
  const moved = pp.record_move(add.state, { collection: "blocks", id: "b9", index: 1 });
  assert.deepEqual(ids(moved.state, "p1"), ["b1", "b9"]);
  const copied = pp.record_copy(s, { collection: "profiles", id: "p2", new_id: "p4" });
  assert.equal(copied.state.config.profiles[2].id, "p4");
  assert.deepEqual(
    copied.state.config.blocks.filter((b) => b.profile === "p4").map((b) => b.type),
    ["prompt"],
  );
  assert.equal(copied.state.config.groups.filter((g) => g.profile === "p4").length, 1);
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
    file_write: (d) => (
      written.push(d),
      d.path === "config.json" ? { revision: "r2" } : { outside_change: { path: d.path } }
    ),
  });
  const s = { ...state_build(), revisions: { "app/config.json": "r1" } };
  const r = await pp2.store_save(s, [{ file: "config" }, { file: "config" }, { file: "prompts" }]);
  assert.equal(written.length, 2);
  assert.equal(written[0].expected, "r1");
  assert.equal(r.revisions["app/config.json"], "r2");
  assert.deepEqual(r.changes, [
    { path: ".promptpipe/prompts.json", root: "chats", target: { file: "prompts" } },
  ]);
});

test("saves of one file that overlap aren't taken for an outside change (drafts while sending)", async () => {
  // A stand-in core that checks revisions like the real one, answering a moment later.
  let disk = "r0";
  let n = 0;
  const pp2 = plugins_load(["runtime-records"], {
    file_write: async (d) => {
      await new Promise((r) => setTimeout(r, 5));
      if (d.expected !== disk) return { outside_change: { path: d.path } };
      disk = `r${(n += 1)}`;
      return { revision: disk };
    },
  });
  const s = { ...state_build(), drafts: [], revisions: { "app/drafts.json": "r0" } };
  const saves = await Promise.all([1, 2, 3].map(() => pp2.store_save(s, [{ file: "drafts" }])));
  assert.deepEqual(
    saves.flatMap((r) => r.changes),
    [],
    "each save started from the revision the one before wrote",
  );
  assert.equal(disk, "r3");
});

test("the outbox comes back after the app closed: a message on its way then is failed, not lost", () => {
  const pp2 = plugins_load(["runtime-records", "runtime-storage"]);
  const loaded = pp2.outbox_load({
    sends: [
      { id: "a", chat: "c", message: "was on its way", status: "sending" },
      { id: "b", chat: "c", message: "was waiting", status: "queued" },
    ],
    held: { c: "paused" },
  });
  assert.deepEqual(
    loaded.sends.map((s) => [s.message, s.status]),
    [
      ["was on its way", "failed"],
      ["was waiting", "queued"],
    ],
  );
  assert.match(loaded.sends[0].error.message, /closed before the reply came/);
  assert.deepEqual(loaded.held, { c: "paused" });
});
