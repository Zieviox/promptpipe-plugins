"use strict";
// The old app's import on a stand-in phone: an old folder with config.json (a profile in the
// legacy: `pipe.rows` shape with the System prompt plugin's stack), the prompt library, a chat file in the
// old format and its Memory summaries. It's backed up, marked, imported once, and not twice.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { plugins_load } = require("./harness.js");

const OLD = "/storage/emulated/0/PromptPipe";
const CHAT = `---
title: Story ideas
source: https://chat.qwen.ai/c/abc
provider: qwen-chat
ai: Qwen Chat
profile: Writer
toggles: "memory=off"
tags: [story, "draft#"]
created: 2026-10-30T21:15:00.000Z
---

# Story ideas

## 1 · 2026-10-30 21:15

<!-- pp:turn {"at":"2026-10-30T21:15:00.000Z","profile":"Writer","tags":["draft#1"],"notes":[]} -->

<!-- pp:you -->
### You

A dragon who hoards maps

<!-- pp:ai -->
### Qwen Chat

She charts every cave.

<!-- pp:raw -->
<details><summary>Sent and raw reply</summary>

Sent:

\`\`\`\`text
[Memory]
A dragon who hoards maps
\`\`\`\`

Raw reply:

\`\`\`\`text
She charts every cave.
\`\`\`\`

</details>
`;
const LOD = `# Story ideas · memory level 1

<!-- pp:lod {"from":0,"to":10,"at":""} -->
## Messages 1-10

<!-- pp:side user -->
The user wants a dragon.
<!-- pp:side ai -->
The AI made her a cartographer.
`;

const files_build = () => ({
  [`${OLD}/config.json`]: JSON.stringify({
    provider: "qwen-chat",
    activeProfile: "p1",
    ui: { scale: 1.1, mode: "dark" },
    git: { enabled: true, name: "Me" },
    profiles: [
      {
        id: "p1",
        name: "Writer",
        pipe: {
          // legacy
          groups: [],
          rows: [
            // legacy
            { type: "step", plugin: "system-prompt", on: true }, // legacy
            { type: "piece", name: "Style", text: "Short.", when: "every" }, // legacy
            { type: "step", plugin: "memory", on: true }, // legacy
            { type: "message" },
          ],
        },
        pluginSettings: {
          "system-prompt": { stack: ["lib1"], when: "first" }, // legacy
          base64: { keepOnFail: false },
        },
      },
    ],
  }),
  [`${OLD}/history/prompt-library.json`]: JSON.stringify({
    promptpipe: "prompt-library", // legacy
    prompts: [{ id: "lib1", name: "Master", text: "Be kind." }],
  }),
  [`${OLD}/history/stories/Story ideas.md`]: CHAT,
  [`${OLD}/history/.memory/stories/Story ideas/lod1.md`]: LOD,
  [`${OLD}/history/.git/HEAD`]: "ref: refs/heads/main\n",
});

const device_build = (files, written) => ({
  file_list: ({ root, folder, hidden }) => {
    if (root !== "device") return [];
    const names = new Map();
    for (const p of Object.keys(files)) {
      if (!p.startsWith(`${folder}/`)) continue;
      const rest = p.slice(folder.length + 1).split("/");
      if (!hidden && rest[0].startsWith(".")) continue;
      names.set(rest[0], rest.length > 1 ? null : files[p].length);
    }
    if (!names.size && !Object.keys(files).some((p) => p.startsWith(`${folder}/`)))
      throw { code: "not_found", message: folder };
    return [...names].map(([name, size]) => ({ name, folder: size === null, size: size || 0 }));
  },
  file_read: ({ root, path: p, encoding }) => {
    const data = root === "device" ? files[p] : undefined;
    if (data === undefined) return [];
    return [
      {
        path: p,
        data: encoding === "base64" ? Buffer.from(data).toString("base64") : data,
        revision: "r",
      },
    ];
  },
  file_write: (d) => (
    written.push(d), d.root === "device" && (files[d.path] = d.data), { revision: "w" }
  ),
  file_move: (d) => (written.push({ move: d }), { copied: 1 }),
  repo_commit: () => ({}),
});

const state_build = () => ({
  app: { app_folder: "/storage/emulated/0/Documents/PromptPipe" },
  schemas: JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "runtime-records", "schemas.json"), "utf8"),
  ),
  config: {
    settings: {},
    profiles: [{ id: "n1", name: "Plain", plugin_settings: {} }],
    blocks: [],
    groups: [],
    provider_choices: {},
  },
  plugins: ["base64", "memory"].map((id) => ({
    id,
    manifest: JSON.parse(fs.readFileSync(path.join(__dirname, "..", id, "plugin.json"), "utf8")),
  })),
  prompts: [],
  chats: [],
  turns: [],
  loaded: [],
  chat_data: [],
  revisions: {},
  ui: {},
});

test("the old app's content is backed up and imported once (X5)", async () => {
  const files = files_build();
  const written = [];
  const pp = plugins_load(
    ["runtime-records", "runtime-chats", "runtime-profiles", "runtime-plugins", "old-app-import"],
    device_build(files, written),
  );
  pp.toast = () => {};
  const reports = [];
  pp.sheet_open = (name, data) => reports.push(data);
  pp.state = state_build();
  await pp.hook_get("old-app-import", "app_start")();

  assert.equal(files[`${OLD}/.nomedia`], "", "the old folder is marked");
  const copy = written.find((w) => w.move).move;
  assert.deepEqual(
    { from: copy.from, to: copy.to, root: copy.root, to_root: copy.to_root, copy: copy.copy },
    {
      from: OLD,
      to: ".promptpipe/backups/old-app-shared",
      root: "device",
      to_root: "app",
      copy: true,
    },
    "the core copies the whole folder (the screen never holds it)",
  );
  assert.match(reports[0].text, /Brought in:\*\* 1 chats, 1 profiles, 1 prompts/);
  assert.match(reports[0].text, /Backed up:\*\* \/storage\/emulated\/0\/PromptPipe/);

  const s = pp.state;
  const writer = s.config.profiles.find((p) => p.name === "Writer");
  assert.equal(s.config.settings["chats.profile"], writer.id);
  assert.equal(s.config.settings["look.scale"], 110);
  const blocks = s.config.blocks.filter((b) => b.profile === writer.id);
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["prompt", "prompt", "plugin", "message"],
  );
  assert.equal(blocks[0].link, "lib1");
  assert.equal(blocks[0].send, "first");
  assert.equal(blocks[2].plugin, "memory");
  assert.deepEqual(writer.plugin_settings.base64, { keep: false });
  assert.equal(s.prompts[0].text, "Be kind.");

  const chat = s.chats[0];
  assert.equal(chat.file, "stories/Story ideas.md");
  assert.deepEqual(chat.tags, ["story", "draft#"]);
  assert.deepEqual(chat.own, {
    provider: "qwen-chat",
    profile: writer.id,
    toggles: { [blocks[2].id]: false }, // the chat's toggle now names the new block
  });
  const [turn] = s.turns;
  assert.equal(turn.message, "A dragon who hoards maps");
  assert.equal(turn.reply, "She charts every cave.");
  assert.equal(turn.sent, "[Memory]\nA dragon who hoards maps");
  assert.equal(turn.page_url, "https://chat.qwen.ai/c/abc");
  assert.equal(pp.chat_data_get(s, chat.id, "memory").levels[0][0].you, "The user wants a dragon.");

  const before = s.chats.length;
  await pp.hook_get("old-app-import", "app_start")();
  assert.equal(pp.state.chats.length, before, "it runs once");
});

test("without room for the backup, the old content still comes in and the report says why", async () => {
  const files = files_build();
  const written = [];
  const pp = plugins_load(
    ["runtime-records", "runtime-chats", "runtime-profiles", "runtime-plugins", "old-app-import"],
    device_build(files, written),
  );
  pp.toast = () => {};
  const reports = [];
  pp.sheet_open = (name, data) => reports.push(data);
  pp.state = { ...state_build(), app: { ...state_build().app, free_bytes: 100 * 1024 * 1024 } };
  await pp.hook_get("old-app-import", "app_start")();
  assert.equal(
    written.some((w) => w.move),
    false,
    "no copy was started",
  );
  assert.equal(pp.state.chats.length, 1, "the chats came in anyway");
  assert.match(
    reports[0].text,
    /Not backed up:\*\* .*not enough space: it needs 1 MB and 100 MB are free/,
  );
});

test("a chat file written by the old app's own code comes in with every field", async () => {
  const files = files_build();
  files[`${OLD}/history/stories/Story ideas.md`] = fs.readFileSync(
    path.join(__dirname, "fixtures", "old-chat.md"),
    "utf8",
  );
  const pp = plugins_load(
    ["runtime-records", "runtime-chats", "runtime-profiles", "runtime-plugins", "old-app-import"],
    device_build(files, []),
  );
  pp.toast = () => {};
  pp.sheet_open = () => {};
  pp.state = state_build();
  await pp.hook_get("old-app-import", "app_start")();
  const chat = pp.state.chats[0];
  assert.equal(chat.name, "Story ideas");
  assert.equal(chat.site_url, "https://chat.qwen.ai/c/abc");
  assert.deepEqual(chat.tags, ["story", "draft#"]);
  assert.equal(chat.created, "2026-10-30T21:15:00.000Z");
  const [one, two] = pp.state.turns;
  assert.equal(one.message, "A dragon who hoards maps\n\nwith ```code``` inside");
  assert.match(one.reply, /\| a \| b \|/);
  assert.equal(one.thinking, "Let me think about dragons.");
  assert.equal(one.sent, "[Memory]\nA dragon");
  assert.equal(one.received, "She charts every cave (raw).");
  assert.deepEqual(one.tags, ["draft#1"]);
  assert.equal(one.model, "Qwen3-Max");
  assert.equal(two.page_url, "https://chat.qwen.ai/c/def", "each message keeps its own site chat");
  assert.equal(two.error.message, "cut short");
});
