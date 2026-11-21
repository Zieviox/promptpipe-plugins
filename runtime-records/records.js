"use strict";
// Records and settings: every collection through one set of operations (strategy 1), the value
// that applies when a chat doesn't set its own (D8, strategy 3), and saving each collection in the
// file its schema names. Every collection is one flat list of records; a child names its parent
// (a block its `profile`, a turn its `chat`), as in a database. The operations are pure over the
// State; `store_save` writes the files.

// ---------- which value applies (D8) ----------

const own_get = (chat) => (chat && chat.own) || {};
const default_get = (defs, key) => ((defs || []).find((d) => d.key === key) || {}).default;

// An app setting: the value you set, else the schema's default.
const setting_get = (state, key) => {
  const set = state.config.settings || {};
  return key in set ? set[key] : default_get(state.schemas.settings, key);
};

const provider_get = (state, chat) =>
  own_get(chat).provider ?? setting_get(state, "chats.provider");

const profile_get = (state, chat) => {
  const id = own_get(chat).profile ?? setting_get(state, "chats.profile");
  const profiles = state.config.profiles;
  return profiles.find((p) => p.id === id) || profiles[0];
};

const choice_get = (state, chat) =>
  (state.config.provider_choices || {})[provider_get(state, chat)] || {};

const model_get = (state, chat) => own_get(chat).model ?? choice_get(state, chat).model ?? "";

const options_get = (state, chat) => ({
  ...(choice_get(state, chat).options || {}),
  ...(own_get(chat).options || {}),
});

// A block is sent when it and its group are on: the chat's own toggle, else the profile's.
const block_on_get = (state, chat, block) => {
  const toggles = own_get(chat).toggles || {};
  const on = (id, fallback) => (id in toggles ? toggles[id] : fallback);
  const group = state.config.groups.find((g) => g.id === block.group);
  return on(block.id, block.on !== false) && (!group || on(group.id, group.on !== false));
};

// A plugin's setting: a provider's are saved per provider, others per profile.
const plugin_setting_get = (state, chat, plugin_id, key) => {
  const plugin = state.plugins.find((p) => p.id === plugin_id);
  const defs = plugin ? plugin.manifest.settings : [];
  const is_provider = plugin && (plugin.manifest.tags || []).includes("provider");
  const saved = is_provider
    ? ((state.config.provider_choices || {})[plugin_id] || {}).settings
    : (profile_get(state, chat).plugin_settings || {})[plugin_id];
  return saved && key in saved ? saved[key] : default_get(defs, key);
};

// ---------- the record operations (pure) ----------
// A schema names its `collection`, its `file` ("config", "prompts", "folders", "drafts", "chat",
// "chat_data", or none for memory only), its `parent` field if it has one, and its `fields`.
// Each operation returns { state, record, targets } or { error }.

const schema_get = (state, collection) => {
  const schema = state.schemas.collections[collection];
  if (!schema) throw { code: "invalid_argument", message: `no collection "${collection}"` };
  return schema;
};

const list_get = (state, schema) =>
  (schema.file === "config" ? state.config : state)[schema.collection] || [];

const list_put = (state, schema, list) =>
  schema.file === "config"
    ? { ...state, config: { ...state.config, [schema.collection]: list } }
    : { ...state, [schema.collection]: list };

// The file a change must be saved to: a chat's files for chats and turns.
const target_get = (schema, record) => {
  if (schema.file === "chat") return { chat: record.chat || record.id };
  return schema.file ? { file: schema.file, id: record.id } : null;
};

const result_build = (state, schema, list, record) => ({
  state: list_put(state, schema, list),
  record,
  targets: [target_get(schema, record)].filter(Boolean),
});

const error_build = (code, message) => ({ error: { code, message } });

// Fields set to null go back to linked (D8); objects (`own`, maps) merge one level deep.
const fields_merge = (record, fields) => {
  const out = { ...record };
  for (const [key, value] of Object.entries(fields)) {
    if (value === null) delete out[key];
    else if (value && typeof value === "object" && !Array.isArray(value) && out[key]) {
      out[key] = fields_merge(out[key], value);
    } else out[key] = value;
  }
  return out;
};

// The problems in a record, by its schema's fields.
const record_validate = (record, schema) => {
  const problems = [];
  for (const def of schema.fields || []) {
    const value = record[def.key];
    const low = def.min ?? -Infinity;
    const high = def.max ?? Infinity;
    if (value === undefined || value === "") {
      if (def.required) problems.push(`${def.label} is needed`);
    } else if (def.type === "number" && !(typeof value === "number" && low <= value)) {
      problems.push(`${def.label}: a number from ${def.min ?? "any"} to ${def.max ?? "any"}`);
    } else if (def.type === "number" && value > high) {
      problems.push(`${def.label}: a number from ${def.min ?? "any"} to ${def.max ?? "any"}`);
    } else if (def.type === "choice" && !(def.choices || []).some((c) => c.value === value)) {
      problems.push(`${def.label}: not one of the choices`);
    }
  }
  return problems;
};

const record_check = (record, schema) => {
  const problems = record_validate(record, schema);
  return problems.length ? error_build("invalid_argument", problems.join("; ")) : null;
};

// Where `index` among the records with the same parent falls in the whole list.
const position_get = (list, schema, record, index) => {
  if (index === undefined) return list.length;
  const siblings = list.filter((r) => !schema.parent || r[schema.parent] === record[schema.parent]);
  if (siblings[index]) return list.indexOf(siblings[index]);
  return siblings.length ? list.indexOf(siblings[siblings.length - 1]) + 1 : list.length;
};

const record_list = (state, { collection, filter = {} }) =>
  list_get(state, schema_get(state, collection)).filter((r) =>
    Object.entries(filter).every(([k, v]) => r[k] === v),
  );

const record_get = (state, { collection, id }) =>
  record_list(state, { collection }).find((r) => r.id === id) || null;

const record_create = (state, { collection, fields, index, id }) => {
  const schema = schema_get(state, collection);
  const defaults = Object.fromEntries((schema.fields || []).map((d) => [d.key, d.default]));
  const record = { ...defaults, ...fields, id };
  const error = record_check(record, schema);
  if (error) return error;
  const list = [...list_get(state, schema)];
  list.splice(position_get(list, schema, record, index), 0, record);
  return result_build(state, schema, list, record);
};

const record_set = (state, { collection, id, fields }) => {
  const schema = schema_get(state, collection);
  if (collection === "settings") {
    const config = { ...state.config, settings: fields_merge(state.config.settings || {}, fields) };
    return { state: { ...state, config }, record: config.settings, targets: [{ file: "config" }] };
  }
  const list = list_get(state, schema);
  const old = list.find((r) => r.id === id);
  if (!old) return error_build("not_found", `no ${collection} "${id}"`);
  const record = fields_merge(old, fields);
  const error = record_check(record, schema);
  if (error) return error;
  return result_build(
    state,
    schema,
    list.map((r) => (r === old ? record : r)),
    record,
  );
};

const record_move = (state, { collection, id, index }) => {
  const schema = schema_get(state, collection);
  const list = [...list_get(state, schema)];
  const record = list.find((r) => r.id === id);
  if (!record) return error_build("not_found", `no ${collection} "${id}"`);
  list.splice(list.indexOf(record), 1);
  list.splice(position_get(list, schema, record, index), 0, record);
  return result_build(state, schema, list, record);
};

// A copy with a new id; its children (a profile's blocks and groups) are copied with it.
const record_copy = (state, { collection, id, new_id }) => {
  const schema = schema_get(state, collection);
  const list = list_get(state, schema);
  const old = list.find((r) => r.id === id);
  if (!old) return error_build("not_found", `no ${collection} "${id}"`);
  const record = { ...structuredClone(old), id: new_id };
  let result = result_build(state, schema, [...list, record], record);
  const children = Object.values(state.schemas.collections).filter((s) => s.owner === collection);
  for (const child of children) {
    const all = list_get(result.state, child);
    const copies = all
      .filter((r) => r[child.parent] === id)
      .map((r) => ({ ...structuredClone(r), id: PP.id_create(), [child.parent]: new_id }));
    result = { ...result, state: list_put(result.state, child, [...all, ...copies]) };
  }
  return result;
};

const record_delete = (state, { collection, id }) => {
  const schema = schema_get(state, collection);
  if (collection === "settings") return record_set(state, { collection, fields: { [id]: null } });
  const list = list_get(state, schema);
  const record = list.find((r) => r.id === id);
  if (!record) return error_build("not_found", `no ${collection} "${id}"`);
  return result_build(
    state,
    schema,
    list.filter((r) => r !== record),
    record,
  );
};

// ---------- saving (effects) ----------

// The files a target stands for, with what goes in them.
const writes_build = async (state, target) => {
  if (target.chat) return PP.chat_files_build(state, target.chat);
  if (target.file === "config") return [{ root: "app", path: "config.json", data: state.config }];
  if (target.file === "drafts") return [{ root: "app", path: "drafts.json", data: state.drafts }];
  if (target.file === "chat_data") {
    const item = state.chat_data.find((d) => d.id === target.id);
    const path = `.promptpipe/chats/${item.chat}/${item.plugin}.json`;
    return [{ root: "chats", path, data: item.data }];
  }
  return [{ root: "chats", path: `.promptpipe/${target.file}.json`, data: state[target.file] }];
};

// Write each target's files with the revision the app last wrote (D7); an outside change comes
// back for the shared dialog instead of being overwritten.
const store_save = async (state, targets) => {
  const revisions = { ...(state.revisions || {}) };
  const changes = [];
  const seen = new Set();
  const written = [];
  for (const target of targets) {
    for (const w of await writes_build(state, target)) {
      const key = `${w.root}/${w.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const data = typeof w.data === "string" ? w.data : JSON.stringify(w.data, null, 2) + "\n";
      const r = await PP.call_send("file_write", { ...w, data, expected: revisions[key] });
      if (r.outside_change) changes.push(r.outside_change);
      else (revisions[key] = r.revision), written.push(w);
    }
  }
  return { revisions, changes, written };
};

// Commit chats-folder files to the history with the author and remote from Settings (D2), unless
// "Commit on every save" is off.
const repo_commit = async (paths, message) => {
  const state = PP.state_get();
  const git = (key) => setting_get(state, `git.${key}`);
  if (git("commit") === false) return null;
  const author = { name: git("name"), email: git("email"), remote: git("remote") };
  const where = { folder: setting_get(state, "storage.chats_folder"), auto_push: git("auto_push") };
  return PP.call_send("repo_commit", { paths, message, ...author, ...where });
};

// Apply a record operation to the State as it is now, save what it touched, and commit the
// chats folder's files to the history with `message` (D2, unless "Commit on every save" is off).
const record_apply = async (operation, message) => {
  let result;
  PP.state_set((state) => {
    result = operation(state);
    return result.error ? state : result.state;
  });
  if (result.error) throw result.error;
  const saved = await store_save(PP.state_get(), result.targets);
  PP.state_set((state) => ({
    ...state,
    revisions: saved.revisions,
    changes: [...(state.changes || []), ...saved.changes],
  }));
  const paths = saved.written.filter((w) => w.root === "chats").map((w) => w.path);
  if (message && paths.length) await repo_commit(paths, message);
  return result;
};

PP.plugin_set({
  functions: {
    setting_get,
    provider_get,
    profile_get,
    model_get,
    options_get,
    block_on_get,
    plugin_setting_get,
    record_validate,
    record_list,
    record_get,
    record_create,
    record_set,
    record_move,
    record_copy,
    record_delete,
    store_save,
    record_apply,
    repo_commit,
  },
});
