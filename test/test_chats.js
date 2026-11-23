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

test("a chat loaded without its messages is never saved over them", async () => {
  const old = [{ id: "t1", chat: "c9", message: "old one", reply: "kept" }];
  const pp = plugins_load(["runtime-records", "runtime-chats"], {
    file_read: (d) =>
      d.path === ".promptpipe/chats/c9/turns.json"
        ? [{ data: JSON.stringify(old), revision: "r" }]
        : [],
  });
  const state = {
    config: {
      settings: {},
      profiles: [{ id: "p", name: "Plain", plugin_settings: {} }],
      blocks: [],
    },
    schemas: { settings: [] },
    plugins: [],
    chats: [{ id: "c9", name: "Old", file: "Old.md", tags: [] }],
    turns: [{ id: "t2", chat: "c9", message: "new one", reply: "r" }],
    loaded: ["c9"],
  };
  const files = await pp.chat_files_build(state, "c9");
  const turns = files.find((f) => f.path.endsWith("turns.json")).data;
  assert.deepEqual(
    turns.map((t) => t.id),
    ["t1", "t2"],
  );
});

test("adding the site's messages skips what's here, unwraps PromptPipe's, and runs reply plugins", async () => {
  const site = [
    { message: "BLOCK TEXT\n\nhello", reply: "aGk=", thinking: "" }, // sent by PromptPipe, base64 reply
    { message: "already here", reply: "yes", thinking: "" },
    { message: "new one", reply: "bmV3", thinking: "" },
  ];
  const pp = plugins_load(["runtime-records", "runtime-chats"], { site_read: () => site });
  pp.hook_run = async (name, value, context) => {
    if (name !== "reply_after") return value;
    assert.ok(context.chat && context.chat.id === "c1" && Array.isArray(context.notes));
    return Buffer.from(value, "base64").toString();
  };
  const state = {
    schemas: JSON.parse(
      require("node:fs").readFileSync(
        require("node:path").join(__dirname, "..", "runtime-records", "schemas.json"),
        "utf8",
      ),
    ),
    config: {
      settings: { "chats.profile": "p" },
      profiles: [{ id: "p", name: "Plain", plugin_settings: {} }],
      blocks: [{ id: "b", profile: "p", type: "prompt", text: "BLOCK TEXT" }],
    },
    chats: [{ id: "c1", name: "Chat", file: "Chat.md", tags: [] }],
    turns: [{ id: "t0", chat: "c1", message: "already here", reply: "yes" }],
  };
  const out = await pp.site_chat_import(state, {
    chat: "c1",
    page: "p1",
    which: "all",
    save: true,
  });
  assert.equal(out.added, 2);
  assert.equal(out.skipped, 1);
  const added = out.state.turns.filter((t) => t.id !== "t0");
  assert.deepEqual(
    added.map((t) => [t.message, t.reply]),
    [
      ["hello", "hi"],
      ["new one", "new"],
    ],
  );
});

test("deleting a chat's last message saves it empty (the safety net only keeps saved messages when there are new ones)", async () => {
  const old = [{ id: "t1", chat: "c9", message: "old one", reply: "r" }];
  const pp = plugins_load(["runtime-records", "runtime-chats"], {
    file_read: (d) =>
      d.path === ".promptpipe/chats/c9/turns.json"
        ? [{ data: JSON.stringify(old), revision: "r" }]
        : [],
  });
  const state = {
    config: {
      settings: {},
      profiles: [{ id: "p", name: "Plain", plugin_settings: {} }],
      blocks: [],
    },
    schemas: { settings: [] },
    plugins: [],
    chats: [{ id: "c9", name: "Old", file: "Old.md", tags: [] }],
    turns: [],
    loaded: ["c9"],
  };
  const files = await pp.chat_files_build(state, "c9");
  assert.deepEqual(files.find((f) => f.path.endsWith("turns.json")).data, []);
});

test("an import never adds the same message twice, and repeated messages can be removed", async () => {
  // The page read each reply three times (nested elements): one with the message, two without.
  const site = [
    { message: "hi", reply: "hello", thinking: "" },
    { message: "", reply: "hello", thinking: "" },
    { message: "", reply: "hello", thinking: "" },
  ];
  const pp = plugins_load(["runtime-records", "runtime-chats"], { site_read: () => site });
  pp.hook_run = async (name, reply) => reply;
  const state = {
    schemas: JSON.parse(
      require("node:fs").readFileSync(
        require("node:path").join(__dirname, "..", "runtime-records", "schemas.json"),
        "utf8",
      ),
    ),
    config: {
      settings: {},
      profiles: [{ id: "p", name: "Plain", plugin_settings: {} }],
      blocks: [],
    },
    chats: [{ id: "c1", name: "Chat", file: "Chat.md", tags: [] }],
    turns: [],
  };
  const out = await pp.site_chat_import(state, {
    chat: "c1",
    page: "p1",
    which: "all",
    save: true,
  });
  assert.equal(out.added, 1);
  assert.equal(out.skipped, 2);

  const tripled = {
    ...state,
    turns: [1, 2, 3].map((i) => ({ id: `t${i}`, chat: "c1", message: "hi", reply: "hello" })),
  };
  const cleaned = pp.turns_repeated_remove(tripled, { chat: "c1" });
  assert.deepEqual(
    cleaned.state.turns.map((t) => t.id),
    ["t1"],
  );
  assert.equal(cleaned.removed, 2);
});

test("Base64 and Memory take their own parts off a message as the site shows it", async () => {
  const pp = plugins_load(["runtime-records", "runtime-plugins", "base64", "memory"]);
  const run = async (text) => {
    let out = text;
    for (const id of ["base64", "memory"]) out = await pp.hook_get(id, "sent_unwrap")(out, {});
    return out;
  };
  const encoded = Buffer.from("What did the lamp mean?").toString("base64");
  const shown =
    "[Memory: context from earlier in this conversation. Use it, don't repeat it back.]\n\nThey met at the harbour.\n\n[End of memory]\n\n" +
    "Reply with base64 only: encode your whole answer as UTF-8 base64. No plain text, no code block, no explanation outside the base64.\n" +
    "My message below is base64 encoded UTF-8; decode it first.\n\n" +
    encoded;
  assert.equal(await run(shown), "What did the lamp mean?");
  assert.equal(await run("A plain message stays as it is."), "A plain message stays as it is.");
  assert.equal(
    await run("Supercalifragilistic"),
    "Supercalifragilistic",
    "one long word isn't base64",
  );
});

test("an import fills in your text in messages an earlier import brought in without it", async () => {
  const pp = plugins_load(["runtime-records", "runtime-chats"], {
    site_read: () => [{ message: "what's the lamp?", reply: "A light.", thinking: "" }],
  });
  pp.hook_run = async (name, value) => value;
  const state = {
    schemas: JSON.parse(
      require("node:fs").readFileSync(
        require("node:path").join(__dirname, "..", "runtime-records", "schemas.json"),
        "utf8",
      ),
    ),
    config: {
      settings: {},
      profiles: [{ id: "p", name: "Plain", plugin_settings: {} }],
      blocks: [],
    },
    chats: [{ id: "c1", name: "Chat", file: "Chat.md", tags: [] }],
    turns: [{ id: "t1", chat: "c1", message: "", reply: "A light.", received: "A light." }],
  };
  const out = await pp.site_chat_import(state, {
    chat: "c1",
    page: "p1",
    which: "all",
    save: true,
  });
  assert.equal(out.added, 0);
  assert.equal(out.fixed, 1);
  assert.equal(out.state.turns.find((t) => t.id === "t1").message, "what's the lamp?");
});
