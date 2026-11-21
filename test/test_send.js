"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { plugins_load } = require("./harness.js");

const IDS = ["runtime-records", "runtime-chats", "runtime-profiles", "runtime-send"];

const state_build = () => ({
  schemas: {
    settings: [
      { key: "chats.provider", default: "deepseek" },
      { key: "chats.profile", default: "p1" },
      { key: "sites.pages", default: 2 },
      { key: "git.commit", default: true },
    ],
    collections: { chats: { collection: "chats", file: "chat" } },
  },
  config: {
    settings: {},
    profiles: [{ id: "p1", name: "Plain", plugin_settings: {} }],
    blocks: [{ id: "m", profile: "p1", type: "message" }],
    groups: [],
    provider_choices: {},
  },
  plugins: [
    {
      id: "deepseek",
      manifest: { name: "DeepSeek", tags: ["provider", "web"], provider: { url: "https://ds" } },
    },
  ],
  prompts: [],
  chats: [
    { id: "c1", name: "New chat", file: "c1.md", tags: ["draft#"] },
    { id: "c2", name: "Other", file: "c2.md", tags: [] },
  ],
  turns: [],
  loaded: ["c1", "c2"],
  sends: [],
  pages: [],
  drafts: [],
  counters: {},
});

// Stand-ins: each site_send waits for the test to finish it.
const world_build = () => {
  const pending = [];
  const files = {};
  let opened = 0;
  const pp = plugins_load(IDS, {
    page_open: (d) => ({ id: `page${(opened += 1)}`, provider: d.provider.id, url: d.url }),
    site_model_set: () => ({}),
    site_send: (d) => new Promise((resolve, reject) => pending.push({ d, resolve, reject })),
    site_stop: () => ({}),
    site_read: () => [{ message: "x", reply: "from the page", thinking: "" }],
    file_write: (d) => ((files[d.path] = d.data), { revision: "r" }),
    file_read: () => [],
    repo_commit: () => ({}),
    vibration_start: () => ({}),
  });
  pp.hook_run = async (hook, input) => input;
  pp.hook_get = () => null;
  pp.state = state_build();
  return { pp, pending, files };
};

const tick = async () => {
  for (let i = 0; i < 30; i += 1) await new Promise((r) => setTimeout(r, 0));
};

test("a chat's messages go in order; other chats go side by side (UC2)", async () => {
  const { pp, pending, files } = world_build();
  pp.message_send({ chat: "c1", message: "one" });
  pp.message_send({ chat: "c1", message: "two" });
  pp.message_send({ chat: "c2", message: "elsewhere" });
  await tick();
  assert.deepEqual(
    pending.map((p) => p.d.text),
    ["one", "elsewhere"],
  );
  pending[0].resolve({ reply: "first reply", url: "https://ds/c/1" });
  await tick();
  await tick();
  await tick();
  assert.deepEqual(
    pending.map((p) => p.d.text),
    ["one", "elsewhere", "two"],
  );
  const turn = pp.state.turns.find((t) => t.message === "one");
  assert.equal(turn.reply, "first reply");
  assert.deepEqual(turn.tags, ["draft#1"]);
  const chat = pp.state.chats.find((c) => c.id === "c1");
  assert.equal(chat.name, "one");
  assert.equal(chat.site_url, "https://ds/c/1");
  assert.match(files["c1.md"], /### You\n\none/);
  assert.ok(pp.sent.some((s) => s.name === "repo_commit" && s.data.message === "chat: one (#1)"));
});

test("a failed send keeps its reason; Retry, Edit and Dismiss (UC4)", async () => {
  const { pp, pending } = world_build();
  pp.message_send({ chat: "c2", message: "hello" });
  await tick();
  pending[0].reject({ code: "permission_denied", message: "The site refused it" });
  await tick();
  await tick();
  const failed = pp.state.sends[0];
  assert.equal(failed.status, "failed");
  assert.equal(failed.error.code, "permission_denied");
  await pp.failure_resolve(failed.id, "retry");
  await tick();
  assert.equal(pending.length, 2);
  pending[1].reject({ code: "unavailable", message: "no connection" });
  await tick();
  await tick();
  await pp.failure_resolve(pp.state.sends[0].id, "edit");
  assert.equal(pp.state.sends.length, 0);
  assert.deepEqual(pp.state.drafts, [{ id: "c2", text: "hello", attachments: [] }]);
});

test("a reply cut short is kept with the error", async () => {
  const { pp, pending } = world_build();
  pp.message_send({ chat: "c2", message: "long one" });
  await tick();
  pp.event_send("reply_changed", {
    page: pending[0].d.page,
    reply: "half of it",
    progress: "writing…",
  });
  pending[0].reject({ code: "deadline_exceeded", message: "no activity for 10 min" });
  await tick();
  await tick();
  await tick();
  const turn = pp.state.turns.find((t) => t.message === "long one");
  assert.equal(turn.reply, "half of it");
  assert.equal(turn.error.code, "deadline_exceeded");
  assert.deepEqual(turn.notes, ["cut short: no activity for 10 min"]);
});

test("a side request answers the caller and isn't saved (UC42.3)", async () => {
  const { pp, pending } = world_build();
  const answer = pp.message_send({ message: "summarise this" });
  await tick();
  pending[0].resolve({ reply: "a summary" });
  const result = await answer;
  assert.equal(result.reply, "a summary");
  assert.equal(pp.state.turns.length, 0);
  assert.equal(pp.state.sends.length, 0);
});

test("pages at once: a send waits for a free page (UC1.4)", async () => {
  const { pp, pending } = world_build();
  pp.state.config.settings = { "sites.pages": 1 };
  pp.message_send({ chat: "c1", message: "a" });
  pp.message_send({ chat: "c2", message: "b" });
  await tick();
  await tick();
  assert.equal(pending.length, 1);
  assert.equal(pp.state.sends.find((s) => s.message === "b").status, "waiting");
  pending[0].resolve({ reply: "ok" });
  await tick();
  await tick();
  await tick();
  await tick();
  assert.equal(pending.length, 2);
});

test("a job becomes a send in a new chat and answers with job_changed (UC41)", async () => {
  const { pp, pending } = world_build();
  pp.state.schemas.collections.chats.fields = [];
  await pp.job_run({ id: "j1", request: "chat", message: "from another app" });
  await tick();
  pending[0].resolve({ reply: "hi app" });
  await tick();
  await tick();
  await tick();
  const done = pp.sent.filter((s) => s.event === "job_changed").pop();
  assert.equal(done.data.status, "done");
  const made = pp.state.chats.find((c) => c.id === done.data.chat);
  assert.equal(made.name, "from another app");
  assert.ok(made.created && made.updated, "an API chat is dated like any other");
  assert.equal(done.data.reply, "hi app");
  await pp.job_run({ id: "j2", request: "models" });
  assert.deepEqual(pp.sent.filter((s) => s.event === "job_changed").pop().data.models, ["Plain"]);
});

test("a cancelled job stops its send (#209)", async () => {
  const { pp, pending } = world_build();
  await pp.job_run({ id: "j3", request: "chat", chat: "c2", message: "hi" });
  await tick();
  await pp.job_run({ id: "j3", request: "cancel" });
  assert.ok(pp.sent.some((s) => s.name === "site_stop" && s.data.page === pending[0].d.page));
});

test("Model and options opens its page through the pool: tracked and within the limit", async () => {
  const { pp } = world_build();
  pp.calls.site_model_list = () => ({ models: ["a"], model: "a", options: [] });
  const listed = await pp.model_list(pp.state, pp.state.chats[0]);
  assert.deepEqual(listed.models, ["a"]);
  assert.equal(pp.state.pages.length, 1, "the page it opened is in the pool");
  await pp.model_list(pp.state, pp.state.chats[0]);
  assert.equal(pp.state.pages.length, 1, "and is reused");
  pp.state = {
    ...pp.state,
    pages: [],
    config: { ...pp.state.config, settings: { "sites.pages": 0 } },
  };
  await assert.rejects(pp.model_list(pp.state, pp.state.chats[0]), { code: "resource_exhausted" });
});
