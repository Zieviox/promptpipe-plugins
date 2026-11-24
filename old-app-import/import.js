"use strict";
// The old app's content, imported once (X5). Its folders (/sdcard/PromptPipe and its own external
// legacy: folder) get a .nomedia marker and are zipped whole into .promptpipe/backups/; then its
// config.json (settings, profiles in every earlier shape, provider settings), the prompt library,
// and every chat file with its Memory summaries come in. Chats already here are skipped, so an
// import that stops part way loses nothing when it runs again. Old names are read once here and
// nowhere else in the app.

const ID = "old-app-import";
const PACKAGE = "dev.zieviox.promptpipe"; // legacy
const DONE = "import.old";

const device = (call, data) => PP.call_send(call, { root: "device", ...data });
const exists = (folder) =>
  device("file_list", { folder }).then(
    () => true,
    () => false,
  );
const text_read = async (path) =>
  ((await device("file_read", { path }).catch(() => []))[0] || {}).data;
const json_read = async (path) => {
  try {
    return JSON.parse(await text_read(path));
  } catch {
    return null;
  }
};

// The old app's folders: shared storage, its own external folder, and a chats folder chosen
// elsewhere (kept in its private folder).
const folders_find = async (state) => {
  const external = /\/Android\/data\//.test(state.app.app_folder || "")
    ? state.app.app_folder.replace(/\/Documents\/PromptPipe$/, "")
    : `/storage/emulated/0/Android/data/${PACKAGE}/files`;
  const bases = [];
  for (const base of ["/storage/emulated/0/PromptPipe", `${external}/PromptPipe`])
    if (await exists(base)) bases.push(base);
  const chosen = String(
    (await text_read(`/data/user/0/${PACKAGE}/files/core/history-folder`)) || "",
  ).trim();
  const chats = [...bases.map((b) => `${b}/history`), ...(chosen.startsWith("/") ? [chosen] : [])];
  const found = [];
  for (const c of chats) if (!found.includes(c) && (await exists(c))) found.push(c);
  return { bases, chats: found };
};

// ---------- the backup ----------

const files_walk = async (folder, hidden = true) => {
  const out = [];
  for (const e of await device("file_list", { folder, hidden })) {
    const path = `${folder}/${e.name}`;
    if (e.folder) out.push(...(await files_walk(path, hidden)));
    else out.push(path);
  }
  return out;
};

// A folder's size, from its listing (nothing is read).
const folder_size = async (folder) => {
  let total = 0;
  for (const e of await device("file_list", { folder, hidden: true }))
    total += e.folder ? await folder_size(`${folder}/${e.name}`) : e.size || 0;
  return total;
};

const MB = 1024 * 1024;

// A folder marked .nomedia and copied whole by the core (file by file, 1 MB at a time) into
// .promptpipe/backups/, when the phone has room for it (and 500 MB to spare); a copy cut short
// goes on where it stopped next time. Without room: no backup, and the report says why. The
// import never changes the old folders apart from the marker, so it goes ahead either way.
const folder_back_up = async (state, base) => {
  await device("file_write", { path: `${base}/.nomedia`, data: "" }).catch(() => null);
  const size = await folder_size(base);
  const free = state.app.free_bytes;
  if (free !== undefined && size + 500 * MB > free) {
    const why = `not enough space: it needs ${Math.ceil(size / MB)} MB and ${Math.floor(free / MB)} MB are free`;
    return { path: base, size, backup: null, why };
  }
  const to = `.promptpipe/backups/old-app-${base.includes("/Android/") ? "own" : "shared"}`;
  await device("file_move", { from: base, to_root: "app", to, copy: true, overwrite: false });
  return { path: base, size, backup: to };
};

// What the import did, on screen (not only in a toast).
const report_open = (lines) => {
  const text = lines.filter(Boolean).join("\n\n");
  if (PP.log_add) PP.log_add("import", "The old app's content", text);
  PP.sheet_open("text", { title: "The old app's content", text });
};

// ---------- settings and profiles ----------

const SETTINGS = [
  ["provider", "chats.provider"],
  ["site", "chats.provider"],
  ["git.enabled", "git.commit"],
  ["git.name", "git.name"],
  ["git.email", "git.email"],
  ["git.remote", "git.remote"],
  ["git.autoPush", "git.auto_push"],
  ["api.folder", "api.folder"],
  ["ui.theme", "look.theme"],
  ["ui.mode", "look.mode"],
  ["ui.accent", "look.accent"],
  ["ui.text", "look.text"],
  ["ui.enterSends", "look.enter_sends"],
  ["wait.idleMin", "sites.idle_min"],
  ["wait.maxMin", "sites.total_min"],
  ["maxReplies", "sites.pages"],
];
const path_get = (o, path) => path.split(".").reduce((v, k) => (v == null ? v : v[k]), o);

// A plugin's saved settings under their current keys (a setting's `old_keys`).
const plugin_settings_move = (state, plugin, saved = {}) => {
  const defs = ((state.plugins.find((p) => p.id === plugin) || {}).manifest || {}).settings || [];
  const out = {};
  for (const [key, value] of Object.entries(saved)) {
    const def = defs.find((d) => d.key === key || (d.old_keys || []).includes(key));
    if (def) out[def.key] = def.type === "toggle" ? !!value : value;
  }
  return out;
};

// legacy: Every earlier shape of a profile's list as rows: blocks, `pipe.rows`, or the plugins that were on.
const rows_get = (profile) => {
  if (Array.isArray(profile.blocks) && profile.blocks.length) return profile.blocks;
  if (profile.pipe) return profile.pipe.rows || []; // legacy
  if (Array.isArray(profile.plugins))
    return [
      { type: "message" },
      ...profile.plugins.filter((p) => p.on).map((p) => ({ type: "step", plugin: p.id })), // legacy
    ];
  return [{ type: "message" }];
};

// legacy: Old rows as blocks: pieces and prompts are System prompts, steps and plugins are plugin blocks,
// legacy: and the System prompt plugin's stack becomes linked blocks where its row sat.
const blocks_build = (profile, id) => {
  const system = (profile.pluginSettings || {})["system-prompt"] || {}; // legacy
  const out = [];
  const common = (r) => ({ profile: id, group: r.group || "", on: r.on !== false });
  for (const r of rows_get(profile)) {
    if (r.type === "message") out.push({ id: PP.id_create(), profile: id, type: "message" });
    else if (r.type === "prompt" || r.type === "piece" /* legacy */)
      out.push({
        ...common(r),
        id: r.id || PP.id_create(),
        type: "prompt",
        name: r.name || "",
        text: r.text || "",
        link: r.link,
        send: r.when || "every",
        number: r.n ?? 5,
      });
    else if (r.plugin === "system-prompt" /* legacy */) {
      const send = system.when === "every" ? "every" : "first";
      for (const link of system.stack || [])
        out.push({ ...common(r), id: PP.id_create(), type: "prompt", link, send, number: 5 });
      if (!(system.stack || []).length && (system.prompt || "").trim())
        out.push({
          ...common(r),
          id: PP.id_create(),
          type: "prompt",
          name: "System prompt",
          text: system.prompt.trim(),
          send,
          number: 5,
        });
    } else if (r.plugin) {
      const taken = out.some((b) => b.id === r.plugin);
      out.push({
        ...common(r),
        id: taken ? PP.id_create() : r.plugin,
        type: "plugin",
        plugin: r.plugin,
        scope: r.scope || "above",
        text_block: r.textId || r.part,
        picked: r.pick,
      });
    }
  }
  if (!out.some((b) => b.type === "message"))
    out.push({ id: PP.id_create(), profile: id, type: "message" });
  return out;
};

const config_import = (state, old) => {
  const settings = {};
  for (const [from, to] of SETTINGS)
    if (path_get(old, from) != null && path_get(old, from) !== "")
      settings[to] = path_get(old, from);
  if (path_get(old, "ui.scale")) settings["look.scale"] = Math.round(old.ui.scale * 100);
  // The profiles go through the app's own profile import (one rule for ids and name clashes:
  // "Name (2)"), as a file in the export's shape; `ids` maps the old ids to the new ones.
  const file = { version: 1, profiles: [], blocks: [], groups: [], prompts: [] };
  for (const p of old.profiles || []) {
    const plugin_settings = Object.fromEntries(
      Object.entries(p.pluginSettings || {}).map(([k, v]) => [
        k,
        plugin_settings_move(state, k, v),
      ]),
    );
    file.profiles.push({ id: p.id, name: p.name || "Profile", plugin_settings });
    file.blocks.push(...blocks_build(p, p.id));
    file.groups.push(
      ...(p.groups || (p.pipe || {}).groups || []).map((g) => ({ ...g, profile: p.id })), // legacy
    ); // legacy
  }
  const added = PP.record_import(state, {
    collection: "profiles",
    text: JSON.stringify(file),
    clash: "both",
  });
  if (added.ids.profiles[old.activeProfile])
    settings["chats.profile"] = added.ids.profiles[old.activeProfile];
  const provider_choices = { ...added.state.config.provider_choices };
  for (const [plugin, saved] of Object.entries(old.providerSettings || old.siteSettings || {}))
    provider_choices[plugin] = {
      ...(provider_choices[plugin] || {}),
      settings: plugin_settings_move(state, plugin, saved),
    };
  const config = {
    ...added.state.config,
    settings: { ...added.state.config.settings, ...settings },
    provider_choices,
  };
  // A chat names its profile by name, and its toggles by the old block ids (a plugin's by its id).
  const profiles = Object.fromEntries(
    (old.profiles || []).map((p) => [
      p.name,
      { id: added.ids.profiles[p.id], blocks: added.ids.blocks[p.id] },
    ]),
  );
  return { state: { ...added.state, config }, profiles };
};

// ---------- chats ----------

const yaml_value = (v) => {
  const t = v.trim();
  try {
    return t.startsWith('"') ? JSON.parse(t) : t;
  } catch {
    return t;
  }
};

// The old chat file: front matter, then each message after its `<!-- pp:turn {...} -->` marker,
// its parts after `<!-- pp:you|think|ai|raw -->` markers alone on their line.
const chat_file_parse = (text) => {
  const meta = { tags: [], toggles: {} };
  const head = /^---\n([\s\S]*?)\n---/.exec(text);
  for (const line of head ? head[1].split("\n") : []) {
    const kv = /^(\w+):\s?(.*)$/.exec(line);
    if (!kv) continue;
    if (kv[1] === "tags")
      meta.tags = (
        kv[2]
          .trim()
          .replace(/^\[|\]$/g, "")
          .match(/"(?:[^"\\]|\\.)*"|[^,]+/g) || []
      )
        .map(yaml_value)
        .filter(Boolean);
    else if (kv[1] === "toggles" || kv[1] === "switches" /* legacy */)
      meta.toggles = Object.fromEntries(
        [...String(yaml_value(kv[2])).matchAll(/(\S+)=(on|off)/g)].map((m) => [
          m[1],
          m[2] === "on",
        ]),
      );
    else if (kv[1] === "site") meta.provider ||= yaml_value(kv[2]);
    else meta[kv[1]] = yaml_value(kv[2]);
  }
  const turns = [];
  const parts = text.split(/^## [^\n]*\n+<!-- pp:turn (.*?) -->[ \t]*$/m);
  for (let i = 1; i < parts.length; i += 2) {
    let info = {};
    try {
      info = JSON.parse(parts[i]);
    } catch {}
    const sections = {};
    const pieces = (parts[i + 1] || "").split(/^<!-- pp:(you|think|ai|raw) -->[ \t]*$/m); // legacy
    for (let j = 1; j < pieces.length; j += 2) sections[pieces[j]] ??= pieces[j + 1]; // legacy
    const drop = (s) => (s || "").replace(/^\s*###[^\n]*\n/, "").trim();
    const fences = [...(sections.raw || "").matchAll(/^(`{4,})text\n([\s\S]*?)\n\1$/gm)].map(
      (f) => f[2],
    );
    turns.push({
      info,
      message: drop(sections.you),
      reply: drop(sections.ai),
      thinking: (sections.think || "")
        .replace(/<\/?details>|<summary>Thinking<\/summary>/g, "")
        .trim(),
      sent: fences[0] || "",
      received: fences[1] || "",
    });
  }
  return { meta, turns };
};

// Memory's summary files (.memory/<chat>/lod<L>.md): items with message ranges and two sides.
const memory_parse = (text, level, chunk) =>
  String(text || "")
    .split(/^<!-- pp:lod (.*?) -->[ \t]*$/m)
    .flatMap((part, i, all) => {
      if (i % 2 === 0) return [];
      try {
        const info = JSON.parse(part);
        const body = (all[i + 1] || "").replace(/^\s*##[^\n]*\n/, "").trim();
        const sides = /<!-- pp:side user -->\n([\s\S]*?)\n<!-- pp:side ai -->\n([\s\S]*)/.exec(
          body,
        );
        const unit = chunk ** (level - 1);
        const item = { from: info.from / unit, to: info.to / unit };
        return [
          sides
            ? {
                ...item,
                you: sides[1].trim(),
                ai: sides[2].trim(),
                text: `The user's side:\n${sides[1].trim()}\n\nThe AI's side:\n${sides[2].trim()}`,
              }
            : { ...item, text: body },
        ];
      } catch {
        return [];
      }
    })
    .sort((a, b) => a.from - b.from);

const chat_import = async (state, root, path, chunk, profiles, text) => {
  const { meta, turns } = chat_file_parse(text);
  const id = PP.id_create();
  const profile = profiles[meta.profile];
  const toggles = Object.fromEntries(
    Object.entries(meta.toggles).map(([key, on]) => [(profile && profile.blocks[key]) || key, on]),
  );
  const at = meta.created || PP.time_get();
  const chat = {
    id,
    name: meta.title || path.replace(/\.md$/, "").split("/").pop(),
    file: path,
    site_url: meta.source || "",
    tags: meta.tags,
    own: {
      ...(meta.provider && { provider: meta.provider }),
      ...(profile && { profile: profile.id }),
      ...(Object.keys(toggles).length && { toggles }),
    },
    created: at,
    updated: meta.updated || at,
  };
  const records = turns.map((t) => {
    const data = t.info.data || {};
    const url = (data["sub-chats"] || {}).url || (data.memory || {}).url || meta.source || "";
    return {
      id: PP.id_create(),
      chat: id,
      at: t.info.at || at,
      message: t.message,
      reply: t.reply,
      thinking: t.thinking,
      sent: t.sent,
      received: t.received || t.reply,
      tags: t.info.tags || [],
      notes: t.info.notes || [],
      profile: t.info.profile || "",
      page_url: url,
      model: meta.model || "",
      ...(t.info.error && { error: t.info.error }),
    };
  });
  const levels = [];
  for (let level = 1; level < 10; level += 1) {
    const lod = await text_read(`${root}/.memory/${path.replace(/\.md$/, "")}/lod${level}.md`);
    if (!lod) break;
    levels.push(memory_parse(lod, level, chunk));
  }
  return { chat, turns: records, memory: levels.length ? { levels } : null };
};

// ---------- the import ----------

// Paths inside `root`, the shallowest first, so a chat found twice is kept where it's nearest the top.
const paths_shallow_first = (root, files) =>
  files
    .map((full) => full.slice(root.length + 1))
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));

// The same chat imported more than once (the old app once copied its chats folder into itself,
// one copy a level deeper each time): the imported chats whose old file has the same text as
// another's, all but the shallowest. Read from the old folders, which stay as they are.
const duplicates_find = async (state) => {
  const done = PP.setting_get(state, DONE);
  const roots = (done && done.chats) || [];
  const groups = new Map();
  for (const chat of state.chats) {
    for (const root of roots) {
      const text = await text_read(`${root}/${chat.file}`);
      if (!text) continue;
      groups.set(text, [...(groups.get(text) || []), chat]);
      break;
    }
  }
  const depth = (c) => c.file.split("/").length;
  return [...groups.values()]
    .filter((g) => g.length > 1)
    .map((g) => [...g].sort((a, b) => depth(a) - depth(b) || a.file.localeCompare(b.file)));
};

// Asks first; the copies go like any deleted chat (they stay in the history).
const duplicates_remove = async (state, data = {}) => {
  const groups = await duplicates_find(state);
  const copies = groups.flatMap((g) => g.slice(1).map((c) => c.id));
  const checked = () =>
    PP.record_apply(
      (s) =>
        PP.record_set(s, { collection: "settings", fields: { "import.duplicates_checked": true } }),
      "import: copies checked",
    );
  if (!copies.length) {
    await checked();
    return data.quiet ? undefined : PP.toast("No chat was imported twice");
  }
  if (data.choice !== "yes")
    return PP.dialog_open({
      title: `${copies.length} imported chats are copies of ${groups.length} others (the old app had copied its chats folder into itself). Delete the copies? One of each is kept, they stay in the history, and the old folder isn't touched.`,
      choices: [["yes", "Delete the copies"]],
      command: "old_app_duplicates_remove",
    });
  await PP.chats_delete(copies);
  await checked();
};

const old_import = async () => {
  const state = PP.state_get();
  if (PP.setting_get(state, DONE)) return;
  const { bases, chats } = await folders_find(state);
  if (!bases.length && !chats.length) return;
  PP.toast("Bringing in the old app's content…");
  const backups = [];
  for (const base of bases) backups.push(await folder_back_up(state, base));
  const old = bases.length ? await json_read(`${bases[0]}/config.json`) : null;
  const chunk =
    Number(((old && (old.profiles || [])[0]) || {}).pluginSettings?.memory?.chunk) || 10;
  const imported = old
    ? config_import(PP.state_get(), old)
    : { state: PP.state_get(), profiles: {} };
  let next = imported.state;
  const library =
    (await json_read(`${chats[0]}/prompt-library.json`)) ||
    (await json_read(`${chats[0]}/system-prompts.json`)); // legacy
  const known = new Set(next.prompts.map((p) => p.id));
  const prompts = ((library && library.prompts) || [])
    .filter((p) => !known.has(p.id))
    .map((p) => ({
      id: p.id || PP.id_create(),
      name: p.name || "",
      text: p.text || "",
      pinned: !!p.pinned,
      updated: p.edited || p.created || PP.time_get(),
    }));
  next = { ...next, prompts: [...next.prompts, ...prompts] };
  const targets = [{ file: "config" }, { file: "prompts" }];
  let count = 0;
  const seen = new Set();
  for (const root of chats) {
    for (const path of paths_shallow_first(root, await files_walk(root, false))) {
      if (!path.endsWith(".md") || next.chats.some((c) => c.file === path)) continue;
      const text = await text_read(`${root}/${path}`);
      if (!text || seen.has(text)) continue; // the same chat again (a folder copied into itself)
      seen.add(text);
      const made = await chat_import(next, root, path, chunk, imported.profiles, text);
      next = {
        ...next,
        chats: [...next.chats, made.chat],
        turns: [...next.turns, ...made.turns],
        loaded: [...next.loaded, made.chat.id],
      };
      if (made.memory) next = PP.chat_data_set(next, made.chat.id, "memory", made.memory).state;
      targets.push(
        { chat: made.chat.id },
        ...(made.memory ? [{ file: "chat_data", id: `${made.chat.id}/memory` }] : []),
      );
      count += 1;
    }
  }
  next = PP.record_set(next, {
    collection: "settings",
    fields: { [DONE]: { at: PP.time_get(), folders: backups, chats } },
  }).state;
  await PP.record_apply(() => ({ state: next, targets }), `import: the old app (${count} chats)`);
  const profiles = Object.keys(imported.profiles).length;
  report_open([
    `**Brought in:** ${count} chats, ${profiles} profiles, ${prompts.length} prompts${old ? ", your settings" : ""}.`,
    `**Chats from:** ${chats.join(", ") || "no chats folder found"}.`,
    ...backups.map((b) =>
      b.backup
        ? `**Backed up:** ${b.path} (${Math.ceil(b.size / MB)} MB) to \`${b.backup}\` in the app folder.`
        : `**Not backed up:** ${b.path}, ${b.why}. It's unchanged apart from a .nomedia marker, so nothing is lost; free some space and use Settings › Chats and Storage › Import the old app's content again for a backup.`,
    ),
  ]);
};

// Delete the old app's folders, after you say so (only folders named PromptPipe can go).
const folders_delete = async (state, data) => {
  const done = PP.setting_get(state, DONE);
  const folders = ((done && done.folders) || []).map((f) => f.path);
  if (!folders.length) return PP.toast("No old app folders were found");
  if (data.choice !== "yes")
    return PP.dialog_open({
      title: `Delete ${folders.join(" and ")}? Their backups stay in .promptpipe/backups.`, // legacy
      choices: [["yes", "Delete"]],
      command: "old_app_delete",
    });
  for (const folder of folders)
    await device("file_delete", { path: folder }).catch((e) => PP.toast(e.message, true));
  PP.toast("The old app's folders are deleted");
};

PP.plugin_set({
  hooks: {
    app_start: () =>
      old_import()
        .then(() => {
          const state = PP.state_get();
          if (PP.setting_get(state, DONE) && !PP.setting_get(state, "import.duplicates_checked"))
            return duplicates_remove(state, { quiet: true });
        })
        .catch((e) =>
          report_open([
            `**The import stopped:** ${e.message}.`,
            "Nothing in the old folders changed. It goes on at the next start, keeping the chats it already brought in.",
          ]),
        ),
  },
  commands: [
    {
      id: "old_app_delete",
      label: "Delete the old app's folders",
      place: "Settings › Chats and Storage",
      run: folders_delete,
    },
    {
      id: "old_app_duplicates_remove",
      label: "Remove chats imported twice",
      place: "Settings › Chats and Storage",
      run: duplicates_remove,
    },
    {
      id: "old_app_import",
      label: "Import the old app's content again",
      place: "Settings › Chats and Storage",
      run: () =>
        PP.apply_try((s) =>
          PP.record_set(s, { collection: "settings", fields: { [DONE]: null } }),
        ).then(old_import),
    },
  ],
});
