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

const bytes_from = (base64) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
const base64_from = (bytes) => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 32768)
    binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(binary);
};

// A folder marked .nomedia and zipped whole; returns the zip's path in the app folder.
const folder_back_up = async (base) => {
  await device("file_write", { path: `${base}/.nomedia`, data: "" }).catch(() => null);
  const files = {};
  for (const path of await files_walk(base)) {
    const [file] = await device("file_read", { path, encoding: "base64" });
    files[path.slice(base.length + 1)] = bytes_from(file.data);
  }
  const name = `.promptpipe/backups/old-app-${base.includes("/Android/") ? "own" : "shared"}-${PP.time_get().slice(0, 10)}.zip`; // legacy
  const data = base64_from(globalThis.fflate.zipSync(files, { level: 1 }));
  await PP.call_send("file_write", { root: "app", path: name, data, encoding: "base64" });
  return name;
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
  const ids = new Map();
  const profiles = (old.profiles || []).map((p) => {
    const id = PP.id_create();
    ids.set(p.id, id);
    const plugin_settings = Object.fromEntries(
      Object.entries(p.pluginSettings || {}).map(([k, v]) => [
        k,
        plugin_settings_move(state, k, v),
      ]),
    );
    return {
      profile: { id, name: p.name || "Profile", plugin_settings },
      blocks: blocks_build(p, id),
      groups: (p.groups || (p.pipe || {}).groups || []).map((g) => ({ ...g, profile: id })), // legacy
    };
  });
  if (ids.has(old.activeProfile)) settings["chats.profile"] = ids.get(old.activeProfile);
  const provider_choices = { ...state.config.provider_choices };
  for (const [plugin, saved] of Object.entries(old.providerSettings || old.siteSettings || {}))
    provider_choices[plugin] = {
      ...(provider_choices[plugin] || {}),
      settings: plugin_settings_move(state, plugin, saved),
    };
  const names = new Set(state.config.profiles.map((p) => p.name));
  const config = {
    ...state.config,
    settings: { ...state.config.settings, ...settings },
    profiles: [
      ...state.config.profiles,
      ...profiles.map((x) => ({
        ...x.profile,
        name: names.has(x.profile.name) ? `${x.profile.name} (old app)` : x.profile.name,
      })),
    ],
    blocks: [...state.config.blocks, ...profiles.flatMap((x) => x.blocks)],
    groups: [...state.config.groups, ...profiles.flatMap((x) => x.groups)],
    provider_choices,
  };
  return { ...state, config };
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

const chat_import = async (state, root, path, chunk) => {
  const { meta, turns } = chat_file_parse(await text_read(`${root}/${path}`));
  const id = PP.id_create();
  const profile = state.config.profiles.find((p) => p.name === meta.profile);
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
      ...(Object.keys(meta.toggles).length && { toggles: meta.toggles }),
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

const old_import = async () => {
  const state = PP.state_get();
  if (PP.setting_get(state, DONE)) return;
  const { bases, chats } = await folders_find(state);
  if (!bases.length && !chats.length) return;
  PP.toast("Bringing in the old app's content…");
  const backups = [];
  for (const base of bases) backups.push({ path: base, backup: await folder_back_up(base) });
  const old = bases.length ? await json_read(`${bases[0]}/config.json`) : null;
  const chunk =
    Number(((old && (old.profiles || [])[0]) || {}).pluginSettings?.memory?.chunk) || 10;
  let next = old ? config_import(PP.state_get(), old) : PP.state_get();
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
  for (const root of chats) {
    for (const full of await files_walk(root, false)) {
      const path = full.slice(root.length + 1);
      if (!path.endsWith(".md") || next.chats.some((c) => c.file === path)) continue;
      const made = await chat_import(next, root, path, chunk);
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
  PP.toast(`Brought in ${count} chats from the old app; its folders are backed up`);
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
      old_import().catch((e) =>
        PP.toast(`The old app's import stopped: ${e.message}. It goes on at the next start.`, true),
      ),
  },
  commands: [
    {
      id: "old_app_delete",
      label: "Delete the old app's folders",
      place: "Settings › Chats and storage",
      run: folders_delete,
    },
    {
      id: "old_app_import",
      label: "Import the old app's content again",
      place: "Settings › Chats and storage",
      run: () =>
        PP.apply_try((s) =>
          PP.record_set(s, { collection: "settings", fields: { [DONE]: null } }),
        ).then(old_import),
    },
  ],
});
