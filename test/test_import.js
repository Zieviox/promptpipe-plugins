"use strict";
// The old app's import on a stand-in phone: an old folder with config.json (a profile in the
// `pipe.rows` shape with the System prompt plugin's stack), the prompt library, a chat file in the
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
          groups: [],
          rows: [
            { type: "step", plugin: "system-prompt", on: true },
            { type: "piece", name: "Style", text: "Short.", when: "every" },
            { type: "step", plugin: "memory", on: true },
            { type: "message" },
          ],
        },
        pluginSettings: {
          "system-prompt": { stack: ["lib1"], when: "first" },
          base64: { keepOnFail: false },
        },
      },
    ],
  }),
  [`${OLD}/history/prompt-library.json`]: JSON.stringify({
    promptpipe: "prompt-library",
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
      names.set(rest[0], rest.length > 1);
    }
    if (!names.size && !Object.keys(files).some((p) => p.startsWith(`${folder}/`)))
      throw { code: "not_found", message: folder };
    return [...names].map(([name, folder]) => ({ name, folder }));
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
  pp.state = state_build();
  await pp.hook_get("old-app-import", "app_start")();

  assert.equal(files[`${OLD}/.nomedia`], "", "the old folder is marked");
  const zip = written.find(
    (w) => w.root === "app" && /backups\/old-app-shared-.*\.zip$/.test(w.path),
  );
  const unzipped = globalThis.fflate.unzipSync(Buffer.from(zip.data, "base64"));
  assert.ok(unzipped["history/.git/HEAD"], "the backup holds the git history");

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
  assert.equal(blocks[2].id, "memory", "a plugin block keeps the id the chat's toggles name");
  assert.deepEqual(writer.plugin_settings.base64, { keep: false });
  assert.equal(s.prompts[0].text, "Be kind.");

  const chat = s.chats[0];
  assert.equal(chat.file, "stories/Story ideas.md");
  assert.deepEqual(chat.tags, ["story", "draft#"]);
  assert.deepEqual(chat.own, {
    provider: "qwen-chat",
    profile: writer.id,
    toggles: { memory: false },
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
