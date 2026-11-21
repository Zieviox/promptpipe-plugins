"use strict";
// Export and import (UC27): a chat as its readable text, profiles with their blocks, groups and
// the library prompts their linked blocks use, prompts as Markdown (one) or the library file
// (several). Importing adds records with new ids; a name clash is asked, kept as both
// ("Name (2)") or replaced, as set (F).

const text_build = async (state, { collection, ids }) => {
  if (collection === "chats") {
    const files = await Promise.all(ids.map((id) => PP.chat_files_build(state, id)));
    return files.map((f) => f[2].data).join("\n\n");
  }
  if (collection === "prompts") {
    const prompts = state.prompts.filter((p) => ids.includes(p.id));
    if (prompts.length === 1)
      return `${prompts[0].name ? `# ${prompts[0].name}\n\n` : ""}${prompts[0].text}\n`;
    return JSON.stringify({ version: 1, prompts }, null, 2);
  }
  const blocks = state.config.blocks.filter((b) => ids.includes(b.profile));
  const links = blocks.map((b) => b.link).filter(Boolean);
  return JSON.stringify(
    {
      version: 1,
      profiles: state.config.profiles.filter((p) => ids.includes(p.id)),
      blocks,
      groups: state.config.groups.filter((g) => ids.includes(g.profile)),
      prompts: state.prompts.filter((p) => links.includes(p.id)),
      plugins: [...new Set(blocks.map((b) => b.plugin).filter(Boolean))],
    },
    null,
    2,
  );
};

const record_export = async (state, { collection, ids, to }) => {
  const text = await text_build(state, { collection, ids });
  if (to === "clipboard") return PP.call_send("clipboard_write", { text });
  const one = collection === "prompts" && ids.length === 1;
  const name = `${collection === "chats" ? "chat" : collection}-${PP.time_get().slice(0, 10)}${one || collection === "chats" ? ".md" : ".json"}`;
  return PP.call_send("content_export", { text, name, to });
};

const name_free = (names, name) => {
  let n = 2;
  while (names.includes(`${name} (${n})`)) n += 1;
  return `${name} (${n})`;
};

// Profiles: each with new ids (its blocks' links pointing at the prompts brought with it). `ids`
// says which new id each profile and block got, by their ids in the file.
const profiles_add = (state, data, clash) => {
  const prompt_ids = new Map((data.prompts || []).map((p) => [p.id, PP.id_create()]));
  const ids = { profiles: {}, blocks: {} };
  let config = state.config;
  for (const profile of data.profiles || []) {
    const id = PP.id_create();
    ids.profiles[profile.id] = id;
    ids.blocks[profile.id] = {};
    const same = config.profiles.find((p) => p.name === profile.name);
    const name =
      same && clash === "both"
        ? name_free(
            config.profiles.map((p) => p.name),
            profile.name,
          )
        : profile.name;
    const group_ids = new Map(
      (data.groups || [])
        .filter((g) => g.profile === profile.id)
        .map((g) => [g.id, PP.id_create()]),
    );
    const blocks = (data.blocks || [])
      .filter((b) => b.profile === profile.id)
      .map((b) => ({
        ...b,
        id: (ids.blocks[profile.id][b.id] = PP.id_create()),
        profile: id,
        group: group_ids.get(b.group) || "",
        link: b.link ? prompt_ids.get(b.link) || b.link : undefined,
      }));
    const groups = (data.groups || [])
      .filter((g) => g.profile === profile.id)
      .map((g) => ({ ...g, id: group_ids.get(g.id), profile: id }));
    const gone = same && clash === "replace" ? same.id : null;
    config = {
      ...config,
      profiles: [...config.profiles.filter((p) => p.id !== gone), { ...profile, id, name }],
      blocks: [...config.blocks.filter((b) => b.profile !== gone), ...blocks],
      groups: [...config.groups.filter((g) => g.profile !== gone), ...groups],
    };
  }
  const prompts = [
    ...state.prompts,
    ...(data.prompts || []).map((p) => ({ ...p, id: prompt_ids.get(p.id) })),
  ];
  return {
    state: { ...state, config, prompts },
    targets: [{ file: "config" }, { file: "prompts" }],
    ids,
  };
};

// A Markdown or text file is one prompt (its first "# " line its name); a library file is many.
const prompts_parse = (text, name = "") => {
  try {
    const data = JSON.parse(text);
    if (Array.isArray(data.prompts)) return data.prompts;
  } catch {}
  const head = /^#\s+(.+)\n+/.exec(text);
  return [
    {
      name: head ? head[1].trim() : name.replace(/\.(md|txt)$/i, ""),
      text: head ? text.slice(head[0].length).trim() : text.trim(),
    },
  ];
};

const record_import = (state, { collection, text, name, clash }) => {
  const choice = clash || PP.setting_get(state, "import.clash");
  if (collection === "prompts") {
    const added = prompts_parse(text, name).map((p) => ({
      name: p.name || "",
      text: p.text,
      pinned: !!p.pinned,
      id: PP.id_create(),
      updated: PP.time_get(),
    }));
    return {
      state: { ...state, prompts: [...state.prompts, ...added] },
      targets: [{ file: "prompts" }],
      records: added,
    };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { error: { code: "invalid_argument", message: "This isn't a profile file" } };
  }
  const clashes = (data.profiles || [])
    .filter((p) => state.config.profiles.some((x) => x.name === p.name))
    .map((p) => p.name);
  if (clashes.length && choice === "ask") return { clashes, plugins: data.plugins || [] };
  return profiles_add(state, data, choice);
};

PP.plugin_set({
  functions: { record_export, record_import },
  calls: {
    record_export: (d, state) => record_export(state, d),
    record_import: (d, state) => record_import(state, d),
  },
});
