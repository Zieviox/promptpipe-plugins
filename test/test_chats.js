"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { plugins_load } = require("./harness.js");

const pp = plugins_load(["runtime-records", "runtime-chats"]);

const chat = {
  id: "c1",
  name: "Trip ideas",
  site_url: "https://chat.example/c/1",
  tags: ["story", "draft#"],
  created: "2026-11-20T09:00:00.000Z",
  updated: "2026-11-21T10:00:00.000Z",
  turns: [
    {
      id: "t1",
      at: "2026-11-21T10:05:00.000Z",
      message: "Hello ```there```",
      reply: "Hi! A table:\n\n| a | b |\n|---|---|\n| 1 | 2 |",
      thinking: "They said hello.",
      sent: "System\n\nHello",
      received: "SGk=",
      tags: ["draft#1"],
    },
  ],
};

test("a chat's text form reads back what can be edited (D1)", () => {
  const text = pp.chat_format(chat, { provider: "DeepSeek", model: "V3", profile: "Plain" }, [
    { plugin: "memory", title: "Memory", text: "Level 1: they met." },
  ]);
  assert.match(text, /^---\nid: c1\nname: Trip ideas\n/);
  assert.match(text, /> Source: \[DeepSeek\]\(https:\/\/chat.example\/c\/1\) · Model: V3/);
  assert.match(text, /## 1 · 2026-11-21 10:05/);
  assert.match(text, /````text\nSystem/);
  const back = pp.chat_parse(
    text.replace("They said hello.", "They greeted me.").replace("Level 1: they met.", "Edited."),
  );
  assert.equal(back.id, "c1");
  assert.deepEqual(back.tags, ["story", "draft#"]);
  assert.deepEqual(back.turns, [
    {
      id: "t1",
      message: "Hello ```there```",
      thinking: "They greeted me.",
      reply: chat.turns[0].reply,
    },
  ]);
  assert.deepEqual(back.sections, { memory: "Edited." });
});

test("counting tags (UC20)", () => {
  assert.equal(pp.chat_tag_build("part #3"), "part-#");
  assert.equal(pp.chat_tag_build("draft#7"), "draft#");
  let r = pp.turn_tags_build(["story", "draft#"], {}, "c1");
  assert.deepEqual(r.tags, ["story", "draft#1"]);
  r = pp.turn_tags_build(["draft#"], r.counters, "c1");
  assert.deepEqual(r.tags, ["draft#2"]);
  const set = pp.turn_tag_build(["draft#2", "x"], "draft#7", r.counters, "c1");
  assert.deepEqual(set.tags, ["x", "draft#7"]);
  assert.equal(set.counters["c1/draft"], 7);
  const other = pp.turn_tags_build(["draft#"], set.counters, "c2");
  assert.deepEqual(other.tags, ["draft#1"]);
});

test("Find's query and filters (UC18)", async () => {
  assert.deepEqual(pp.query_parse('trip "red car" #dra in:food is:ai'), {
    words: ["trip"],
    phrases: ["red car"],
    tags: ["dra"],
    folder: "food",
    side: "ai",
  });
  const p2 = plugins_load(["runtime-records", "runtime-chats"], {
    file_find: () => [
      {
        chat: "c1",
        turn: { id: "t1", at: "1", message: "red car trip", reply: "ok", tags: ["draft#1"] },
      },
      { chat: "c2", turn: { id: "t2", at: "2", message: "trip", reply: "red car", tags: [] } },
      { chat: "c1", turn: { id: "t3", at: "3", message: "trip red car", reply: "", tags: [] } },
    ],
  });
  const state = {
    chats: [
      { id: "c1", name: "A", file: "food/A.md", tags: [] },
      { id: "c2", name: "B", file: "B.md", tags: ["draft#"] },
    ],
  };
  const found = await p2.chat_find(state, 'trip "red car" #dra');
  assert.deepEqual(
    found.map((m) => m.turn.id),
    ["t2", "t1"],
  );
  const mine = await p2.chat_find(state, "red is:you in:food");
  assert.deepEqual(
    mine.map((m) => m.turn.id),
    ["t3", "t1"],
  );
});

test("moving chats keeps the order and refuses a clash (UC17)", () => {
  const state = {
    chats: [
      { id: "c1", file: "A.md" },
      { id: "c2", file: "food/B.md" },
      { id: "c3", file: "B.md" },
    ],
    folders: [
      { id: "", order: ["c1", "c3"], pinned: ["c2"] },
      { id: "food", order: ["c2"], pinned: [] },
    ],
  };
  const r = pp.folder_move(state, ["c1"], { folder: "food", index: 0 });
  assert.deepEqual(r.moves, [{ id: "c1", from: "A.md", to: "food/A.md" }]);
  assert.deepEqual(r.state.folders.find((f) => f.id === "food").order, ["c1", "c2"]);
  assert.deepEqual(r.state.folders.find((f) => f.id === "").order, ["c3"]);
  assert.equal(pp.folder_move(state, ["c2"], { folder: "" }).error.code, "already_exists");
  const pinned = pp.folder_move(state, ["c3"], { pinned: 0 });
  assert.deepEqual(pinned.state.folders.find((f) => f.id === "").pinned, ["c3", "c2"]);
  assert.equal(pp.chat_file_build(state, "B", ""), "B (2).md");
});

test("renaming a folder moves its chats and inner folders; deleting one keeps its chats (UC17)", () => {
  const state = {
    chats: [
      { id: "c1", file: "Worlds/Ilse.md" },
      { id: "c2", file: "Worlds/Maps/Coast.md" },
      { id: "c3", file: "Plain.md" },
    ],
    folders: [
      { id: "", order: ["Worlds", "c3"], pinned: [] },
      { id: "Worlds", order: ["c1", "Worlds/Maps"], pinned: [] },
      { id: "Worlds/Maps", order: ["c2"], pinned: [] },
    ],
  };
  const r = pp.folder_rename(state, { from: "Worlds", to: "Places" });
  assert.deepEqual(
    r.moves.map((m) => m.to),
    ["Places/Ilse.md", "Places/Maps/Coast.md"],
  );
  assert.deepEqual(
    r.state.folders.map((f) => f.id),
    ["", "Places", "Places/Maps"],
  );
  assert.deepEqual(r.state.folders[0].order, ["Places", "c3"]);
  assert.equal(pp.folder_rename(state, { from: "Worlds", to: "Plain.md" }).error, undefined);
  assert.equal(
    pp.folder_rename(state, { from: "Worlds/Maps", to: "Maps" }).error.code,
    "invalid_argument",
  );

  const d = pp.folder_delete(state, { path: "Worlds" });
  assert.deepEqual(
    d.state.chats.map((c) => c.file),
    ["Ilse.md", "Coast.md", "Plain.md"],
  );
  assert.deepEqual(
    d.state.folders.map((f) => f.id),
    [""],
  );
});
