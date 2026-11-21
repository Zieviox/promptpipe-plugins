"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { plugins_load } = require("./harness.js");

const IDS = [
  "runtime-records",
  "runtime-chats",
  "runtime-profiles",
  "runtime-plugins",
  "runtime-storage",
];

test("an AI's answer becomes files (UC30)", () => {
  const pp = plugins_load(IDS);
  const answer =
    'Here it is.\n\n**plugin.json**\n```json\n{"id":"x"}\n```\n\nFile: main.js\n```js\nPP.plugin_set({});\n```\nDone.';
  assert.deepEqual(pp.answer_parse(answer), {
    "plugin.json": '{"id":"x"}',
    "main.js": "PP.plugin_set({});",
  });
});

test("zips: one wrapping folder allowed, a zip bomb refused (S6)", () => {
  const pp = plugins_load(IDS);
  const zip = pp.zip_write({ "pack/plugin.json": "{}", "pack/main.js": "x" });
  assert.deepEqual(pp.zip_read(zip), { "plugin.json": "{}", "main.js": "x" });
  const big = globalThis.fflate.zipSync({
    "a.txt": [new Uint8Array(600 * 1024 * 1024), { level: 1 }],
  });
  assert.throws(() => pp.zip_read(big), { message: "That zip unpacks to over 500 MB" });
});

test("versions and the catalogue's offers and updates (UC28, UC31)", async () => {
  const pp = plugins_load(IDS, {
    http_fetch: (d) => ({ status: 200, body: d.url.endsWith(".sig") ? "sig" : "{}" }),
    catalogue_verify: () => ({
      entries: [
        { id: "memory", version: "3.1.0", min_app: "1.0.0" },
        { id: "qwen", version: "2.0.0", min_app: "9.0.0" },
      ],
    }),
  });
  assert.ok(pp.version_compare("1.2.10", "1.2.9") > 0);
  const state = {
    app: { version: "1.0.0" },
    config: { sources: [] },
    plugins: [{ id: "memory", manifest: { version: "3.0.0" } }],
  };
  const r = await pp.catalogue_load(state);
  assert.deepEqual(
    r.updates.map((u) => u.id),
    ["memory"],
  );
  assert.equal(r.offers.find((o) => o.id === "qwen").app_too_old, true);
});

test("a source is added with its own key, and its catalogue is checked against that key", async () => {
  const KEY = "ab".repeat(32);
  const seen = [];
  const pp = plugins_load(IDS, {
    http_fetch: (d) => ({
      status: 200,
      body: d.url.endsWith(".pub") ? `${KEY}\n` : d.url.endsWith(".sig") ? "sig\n" : "{}",
    }),
    catalogue_verify: (d) => (
      seen.push(d), { entries: [{ id: "extra", version: "1.0.0", min_app: "1.0.0" }] }
    ),
  });
  const state = { app: { version: "1.0.0" }, config: { sources: [] }, plugins: [] };
  const found = await pp.source_verify(state, { url: "https://github.com/someone/plugins/" });
  assert.deepEqual(found, {
    source: { url: "https://github.com/someone/plugins", on: true, key: KEY },
    count: 1,
  });
  assert.equal(seen[0].key, KEY);
  assert.equal(seen[0].signature, "sig");
  await assert.rejects(pp.source_verify(state, { url: "not a repo" }), {
    code: "invalid_argument",
  });

  const official = await pp.catalogue_load({
    ...state,
    config: { sources: [{ url: "https://github.com/x/y", on: true }] },
  });
  assert.equal(
    official.failed[0].error.code,
    "failed_precondition",
    "a source with no key is refused",
  );
  assert.equal(
    seen[seen.length - 1].key,
    undefined,
    "the official catalogue uses the app's own keys",
  );
});

test("installing asks first when the name is taken; a new block plugin joins the profile (UC29)", async () => {
  const written = [];
  const pp = plugins_load(IDS, {
    plugin_write: (d) => (written.push(d), { id: d.plugin }),
    file_write: () => ({ revision: "r" }),
  });
  pp.state = {
    schemas: {
      settings: [{ key: "chats.profile", default: "p1" }],
      collections: { blocks: { collection: "blocks", file: "config", parent: "profile" } },
    },
    config: { settings: {}, profiles: [{ id: "p1", name: "Plain" }], blocks: [], groups: [] },
    plugins: [{ id: "base64", copy: "built_in", manifest: { tags: [] } }],
  };
  const files = { "plugin.json": JSON.stringify({ id: "base64", tags: [], files: [] }) };
  assert.ok((await pp.plugin_install(pp.state, { files })).conflict);
  const fresh = { "plugin.json": JSON.stringify({ id: "rot13", tags: [], files: [] }) };
  await pp.plugin_install(pp.state, { files: fresh });
  assert.equal(written[0].plugin, "rot13");
  assert.deepEqual(
    pp.state.config.blocks.map((b) => b.plugin),
    ["rot13"],
  );
});

test("connections and the API token (UC37, UC40.6)", async () => {
  const pp = plugins_load(IDS, {
    credential_create: (d) => ({ name: d.name }),
    file_write: () => ({ revision: "r" }),
  });
  const state = { plugins: [{ id: "openai" }], credentials: [{ name: "key" }] };
  assert.deepEqual(
    pp.connection_verify(state, { provider: "openai", base_url: "https://api", credential: "key" }),
    [],
  );
  assert.equal(
    pp.connection_verify(state, { provider: "x", base_url: "http://a", credential: "y" }).length,
    3,
  );
  pp.state = { config: { settings: {} }, schemas: { settings: [] } };
  const { token } = await pp.api_token_create();
  assert.equal(token.length, 48);
  assert.equal(pp.state.config.api_token_hash.length, 64);
  assert.equal(pp.sent.find((s) => s.name === "credential_create").data.access, "read_write");
});

test("the State is read at start; a first start makes a profile from Plain", async () => {
  const written = [];
  const pp = plugins_load(IDS, {
    file_read: (d) =>
      d.pattern ? [{ data: JSON.stringify({ id: "c1", name: "Trip", file: "Trip.md" }) }] : [],
    file_write: (d) => (written.push(d.path), { revision: "r1" }),
    credential_list: () => [{ name: "git token" }],
  });
  const state = await pp.state_load({
    app: { app_folder: "/sdcard/Documents/PromptPipe" },
    plugins: [],
    prompts: [],
  });
  assert.equal(state.chats[0].name, "Trip");
  assert.equal(state.config.profiles[0].name, "Plain");
  assert.equal(pp.setting_get(state, "chats.profile"), state.config.profiles[0].id);
  assert.equal(pp.setting_get(state, "storage.chats_folder"), "/sdcard/Documents/PromptPipe/chats");
  assert.deepEqual(written, ["config.json"]);
  assert.equal(
    state.config.blocks.filter((b) => b.profile === state.config.profiles[0].id).length,
    2,
  );
});
