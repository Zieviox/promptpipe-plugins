"use strict";
// Records and settings: every collection through one set of operations (strategy 1), the value
// that applies when a chat doesn't set its own (D8, strategy 3), and saving each collection in the
// place its schema names. The operations are pure over the State; `store_save` writes the files.

// ---------- which value applies (D8) ----------

const own_get = (chat) => (chat && chat.own) || {};
const default_get = (defs, key) => ((defs || []).find((d) => d.key === key) || {}).default;

// An app setting: the value you set, else the schema's default.
const setting_get = (state, key) => {
  const set = state.config.settings || {};
  return key in set ? set[key] : default_get(state.schemas.settings, key);
};

const provider_get = (state, chat) => own_get(chat).provider ?? setting_get(state, "chats.provider");

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
const block_on_get = (profile, chat, block) => {
  const toggles = own_get(chat).toggles || {};
  const on = (id, fallback) => (id in toggles ? toggles[id] : fallback);
  const group = (profile.groups || []).find((g) => g.id === block.group);
  return on(block.id, block.on !== false) && (!group || on(group.id, group.on !== false));
};

// A plugin's setting: a provider's are saved per provider, others per profile.
const plugin_setting_get = (state, chat, plugin_id, key) => {
  const plugin = state.plugins.find((p) => p.id === plugin_id);
  const defs = plugin ? plugin.manifest.settings : [];
  const is_provider = plugin && plugin.manifest.tags.includes("provider");
  const saved = is_provider
    ? ((state.config.provider_choices || {})[plugin_id] || {}).settings
    : (profile_get(state, chat).plugin_settings || {})[plugin_id];
  return saved && key in saved ? saved[key] : default_get(defs, key);
};

// ---------- where a collection lives in the State ----------
// A schema's `place`: "config" (a list in Config), "settings" (Config's map of changed values),
// "profile" (a list inside a profile: blocks, groups), "chat" (a chat's turns), "state" (memory
// only), "file" (a list saved in its own file), "chats" (each chat in its own folder),
// "chat_data" (a plugin's data for a chat).

const chat_find = (state, id) =>
  state.chat && state.chat.id === id ? state.chat : state.chats.find((c) => c.id === id);

const list_get = (state, schema, parent) => {
  const field = schema.field || schema.collection;
  if (schema.place === "config") return state.config[field] || [];
  if (schema.place === "profile") return (profile_find(state, parent)[field] || []);
  if (schema.place === "chat") return (chat_find(state, parent) || {}).turns || [];
  return state[field] || [];
};

const profile_find = (state, id) => state.config.profiles.find((p) => p.id === id) || {};

const list_put = (state, schema, parent, list) => {
  const field = schema.field || schema.collection;
  if (schema.place === "config") return { ...state, config: { ...state.config, [field]: list } };
  if (schema.place === "profile") {
    const profiles = state.config.profiles.map((p) => (p.id === parent ? { ...p, [field]: list } : p));
    return { ...state, config: { ...state.config, profiles } };
  }
  if (schema.place === "chat") {
    if (!state.chat || state.chat.id !== parent) {
      throw { code: "failed_precondition", message: "turns change only in the open chat" };
    }
    return { ...state, chat: { ...state.chat, turns: list } };
  }
  if (schema.place === "chats" && state.chat) {
    // The open chat holds its turns; its other fields follow the list.
    const meta = list.find((c) => c.id === state.chat.id);
    const chat = meta ? { ...meta, turns: state.chat.turns } : state.chat;
    return { ...state, [field]: list, chat };
  }
  return { ...state, [field]: list };
};

// The file a change to this collection must be saved to.
const target_get = (schema, parent, record) => {
  if (["config", "settings", "profile"].includes(schema.place)) return { file: "config" };
  if (schema.place === "chats") return { chat: record.id };
  if (schema.place === "chat") return { chat: parent };
  if (schema.place === "chat_data") return { chat_data: record.id };
  if (schema.place === "file") return { file: schema.collection };
  return null;
};

// ---------- the record operations (pure) ----------
// Each returns { state, record, targets } or { error }.

// Fields set to null go back to linked (D8); `own` and maps merge one level deep.
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
    if (value === undefined || value === "") {
      if (def.required) problems.push(`${def.label} is needed`);
      continue;
    }
    if (def.type === "number" && typeof value !== "number") problems.push(`${def.label}: a number`);
    if (def.type === "number" && def.min !== undefined && value < def.min) {
      problems.push(`${def.label}: at least ${def.min}`);
    }
    if (def.type === "number" && def.max !== undefined && value > def.max) {
      problems.push(`${def.label}: at most ${def.max}`);
    }
    if (def.type === "choice" && def.choices && !def.choices.some((c) => c.value === value)) {
      problems.push(`${def.label}: not one of the choices`);
    }
  }
  return problems;
};

const schema_get = (state, collection) => {
  const schema = state.schemas.collections[collection];
  if (!schema) throw { code: "invalid_argument", message: `no collection "${collection}"` };
  return schema;
};

const result_build = (state, schema, parent, list, record) => ({
  state: list_put(state, schema, parent, list),
  record,
  targets: [target_get(schema, parent, record)].filter(Boolean),
});

const record_create = (state, { collection, fields, parent, index, id }) => {
  const schema = schema_get(state, collection);
  const defaults = Object.fromEntries((schema.fields || []).map((d) => [d.key, d.default]));
  const record = { ...defaults, ...fields, id };
  const problems = record_validate(record, schema);
  if (problems.length) return { error: { code: "invalid_argument", message: problems.join("; ") } };
  const list = [...list_get(state, schema, parent)];
  list.splice(index ?? list.length, 0, record);
  return result_build(state, schema, parent, list, record);
};

const record_set = (state, { collection, id, fields, parent }) => {
  const schema = schema_get(state, collection);
  if (schema.place === "settings") {
    const settings = fields_merge(state.config.settings || {}, fields);
    const next = { ...state, config: { ...state.config, settings } };
    return { state: next, record: settings, targets: [{ file: "config" }] };
  }
  const list = list_get(state, schema, parent);
  const old = list.find((r) => r.id === id);
  if (!old) return { error: { code: "not_found", message: `no ${collection} "${id}"` } };
  const record = fields_merge(old, fields);
  const problems = record_validate(record, schema);
  if (problems.length) return { error: { code: "invalid_argument", message: problems.join("; ") } };
  const next = list.map((r) => (r.id === id ? record : r));
  return result_build(state, schema, parent, next, record);
};

const record_move = (state, { collection, id, parent, index }) => {
  const schema = schema_get(state, collection);
  const list = [...list_get(state, schema, parent)];
  const from = list.findIndex((r) => r.id === id);
  if (from < 0) return { error: { code: "not_found", message: `no ${collection} "${id}"` } };
  const [record] = list.splice(from, 1);
  list.splice(Math.max(0, Math.min(index, list.length)), 0, record);
  return result_build(state, schema, parent, list, record);
};

const record_copy = (state, { collection, id, parent, new_id }) => {
  const schema = schema_get(state, collection);
  const list = list_get(state, schema, parent);
  const at = list.findIndex((r) => r.id === id);
  if (at < 0) return { error: { code: "not_found", message: `no ${collection} "${id}"` } };
  const record = { ...structuredClone(list[at]), id: new_id };
  const next = [...list.slice(0, at + 1), record, ...list.slice(at + 1)];
  return result_build(state, schema, parent, next, record);
};

const record_delete = (state, { collection, id, parent }) => {
  const schema = schema_get(state, collection);
  if (schema.place === "settings") return record_set(state, { collection, fields: { [id]: null } });
  const list = list_get(state, schema, parent);
  const record = list.find((r) => r.id === id);
  if (!record) return { error: { code: "not_found", message: `no ${collection} "${id}"` } };
  return result_build(state, schema, parent, list.filter((r) => r.id !== id), record);
};

const record_list = (state, { collection, parent, filter = {} }) =>
  list_get(state, schema_get(state, collection), parent).filter((r) =>
    Object.entries(filter).every(([k, v]) => r[k] === v),
  );

const record_get = (state, { collection, parent, id }) =>
  record_list(state, { collection, parent }).find((r) => r.id === id) || null;

// ---------- saving (effects) ----------

// The files a target stands for, with what goes in them.
const writes_build = (state, target, chat_files) => {
  if (target.file === "config") {
    return [{ root: "app", path: "config.json", data: state.config }];
  }
  if (target.file) {
    return [{ root: "chats", path: `.promptpipe/${target.file}.json`, data: state[target.file] }];
  }
  if (target.chat_data) {
    const [chat, plugin] = target.chat_data.split("/");
    const data = (state.chat_data || []).find((d) => d.id === target.chat_data) || {};
    return [{ root: "chats", path: `.promptpipe/chats/${chat}/${plugin}.json`, data: data.data }];
  }
  return chat_files(state, target.chat);
};

// Write each target's files with the revision the app last wrote (D7); an outside change comes
// back for the shared dialog instead of being overwritten.
const store_save = async (state, targets) => {
  const revisions = { ...(state.revisions || {}) };
  const changes = [];
  const seen = new Set();
  for (const target of targets) {
    for (const w of writes_build(state, target, PP.chat_files_build)) {
      const key = `${w.root}/${w.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const text = typeof w.data === "string" ? w.data : JSON.stringify(w.data, null, 2) + "\n";
      const r = await PP.call_send("file_write", { ...w, data: text, expected: revisions[key] });
      if (r.outside_change) changes.push(r.outside_change);
      else revisions[key] = r.revision;
    }
  }
  return { revisions, changes };
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
    record_create,
    record_set,
    record_move,
    record_copy,
    record_delete,
    record_list,
    record_get,
    store_save,
  },
});
