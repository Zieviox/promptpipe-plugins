"use strict";
// Plugins: the sources' catalogues (verified by the core, S3), installing from a catalogue entry,
// a link, a zip or an AI's answer, updating, going back to the previous copy, and copying a
// built-in plugin to edit it. The core checks every file's hash and writes it (`plugin_write`).

const OFFICIAL = { id: "official", url: "https://github.com/Zieviox/promptpipe-plugins", on: true };
const ZIP_MAX = 500 * 1024 * 1024; // an unpacked size far beyond any real plugin (S6)

// "1.2.10" against "1.2.9": SemVer's order for the parts that matter here.
const version_compare = (a, b) => {
  const parse = (v) =>
    String(v || "0")
      .split("-")[0]
      .split(".")
      .map(Number);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i += 1) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
};

// A GitHub repository's raw file address.
const raw_url = (source, path) =>
  source.url.replace("https://github.com/", "https://raw.githubusercontent.com/") + `/main/${path}`;

const text_fetch = async (url) => {
  const r = await PP.call_send("http_fetch", { url, method: "GET" });
  if (r.status >= 300) throw { code: "unavailable", message: `${url} answered ${r.status}` };
  return r.body;
};

// ---------- catalogues ----------

// Each source's catalogue, verified; what it offers and the updates for installed plugins.
const catalogue_load = async (state, { source } = {}) => {
  const sources = source ? [source] : [OFFICIAL, ...state.config.sources].filter((s) => s.on);
  const offers = [];
  const failed = [];
  for (const s of sources) {
    try {
      const data = await text_fetch(raw_url(s, "catalogue.json"));
      const signature = await text_fetch(raw_url(s, "catalogue.json.sig"));
      const catalogue = await PP.call_send("catalogue_verify", { data, signature });
      offers.push(...catalogue.entries.map((entry) => ({ ...entry, source: s })));
    } catch (error) {
      failed.push({ source: s, error });
    }
  }
  const installed = new Map(state.plugins.map((p) => [p.id, p]));
  const app = state.app.version;
  const updates = offers.filter((o) => {
    const plugin = installed.get(o.id);
    return plugin && version_compare(o.version, plugin.manifest.version) > 0;
  });
  return {
    offers: offers.map((o) => ({
      ...o,
      installed: installed.has(o.id),
      app_too_old: version_compare(o.min_app, app) > 0,
    })),
    updates: updates.filter((o) => version_compare(o.min_app, app) <= 0),
    failed,
  };
};

// ---------- reading what's installed from ----------

// An AI's answer as files: each code block belongs to the file named on the line before it.
const answer_parse = (text) => {
  const files = {};
  let name = "";
  let body = null;
  for (const line of String(text).replace(/\r/g, "").split("\n")) {
    if (body === null) {
      if (/^\s*```/.test(line)) body = [];
      else {
        const plain = line.replace(/[*`#]/g, "").replace(/^\s*(file|filename|name)\s*:\s*/i, "");
        if (/^[\w./-]+\.\w+$/.test(plain.replace(/:\s*$/, "").trim()))
          name = plain.replace(/:\s*$/, "").trim();
      }
    } else if (/^\s*```\s*$/.test(line)) {
      if (name) files[name.replace(/^\.?\//, "")] = body.join("\n");
      [name, body] = ["", null];
    } else body.push(line);
  }
  return files;
};

// The files in a zip (fflate), refused when it unpacks far beyond any real plugin (S6); one
// wrapping folder is allowed.
const zip_read = (bytes) => {
  let total = 0;
  const files = globalThis.fflate.unzipSync(bytes, {
    filter: (f) => {
      total += f.originalSize;
      if (total > ZIP_MAX)
        throw { code: "invalid_argument", message: "That zip unpacks to over 500 MB" };
      return !f.name.endsWith("/");
    },
  });
  const names = Object.keys(files);
  const wrap =
    names.length &&
    names.every((n) => n.split("/")[0] === names[0].split("/")[0] && n.includes("/"));
  const out = {};
  for (const n of names)
    out[wrap ? n.slice(n.indexOf("/") + 1) : n] = globalThis.fflate.strFromU8(files[n]);
  return out;
};

const zip_write = (files) =>
  globalThis.fflate.zipSync(
    Object.fromEntries(Object.entries(files).map(([n, t]) => [n, globalThis.fflate.strToU8(t)])),
  );

// ---------- installing ----------

// A plugin's files from a link: a GitHub folder, a plugin.json (and the files it lists), a zip.
const link_read = async (url) => {
  const folder = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/tree\/([^/]+)\/(.+)$/.exec(url);
  const base = folder
    ? `https://raw.githubusercontent.com/${folder[1]}/${folder[2]}/${folder[3]}`
    : url.replace(/\/plugin\.json$/, "");
  if (url.endsWith(".zip")) {
    const r = await PP.call_send("http_fetch", { url, method: "GET", encoding: "base64" });
    return zip_read(Uint8Array.from(atob(r.body), (c) => c.charCodeAt(0)));
  }
  const manifest = await text_fetch(`${base}/plugin.json`);
  const files = { "plugin.json": manifest };
  for (const name of JSON.parse(manifest).files || [])
    files[name] = await text_fetch(`${base}/${name}`);
  return files;
};

// from: { entry } (a catalogue offer), { url }, { zip } (bytes) or { files } (an AI's answer).
// A name already taken asks first (`confirmed`); a new block plugin goes into the active profile.
const plugin_install = async (state, from) => {
  let files = from.files;
  if (from.entry) {
    const names = Object.keys(from.entry.hashes);
    const base = from.entry.path;
    files = {};
    for (const n of names) files[n] = await text_fetch(raw_url(from.entry.source, `${base}/${n}`));
  } else if (from.url) files = await link_read(from.url.trim());
  else if (from.zip) files = zip_read(from.zip);
  if (!files || !files["plugin.json"])
    return { error: { code: "invalid_argument", message: "No plugin.json in it" } };
  const manifest = JSON.parse(files["plugin.json"]);
  const taken = state.plugins.find((p) => p.id === manifest.id);
  if (taken && !from.confirmed && taken.copy !== "updated")
    return { conflict: { plugin: taken, manifest } };
  const plugin = await PP.call_send("plugin_write", {
    plugin: manifest.id,
    files,
    entry: from.entry || null,
  });
  const blocks =
    !taken &&
    !(manifest.tags || []).some((t) => ["provider", "theme", "passive", "runtime"].includes(t));
  if (!blocks) return { plugin };
  const profile = PP.profile_get(state, null);
  const fields = {
    profile: profile.id,
    type: "plugin",
    plugin: manifest.id,
    scope: "above",
    on: true,
  };
  await PP.record_apply((s) =>
    PP.record_create(s, { collection: "blocks", fields, id: PP.id_create() }),
  );
  return { plugin };
};

// Update the given plugins (or every one with an update), or go back to each one's previous copy.
const plugin_update = async (state, { ids, previous }) => {
  if (previous) {
    for (const id of ids) await PP.call_send("plugin_write", { plugin: id, previous: true });
    return { updated: ids };
  }
  const { updates } = await catalogue_load(state);
  const chosen = updates.filter((u) => !ids || ids.includes(u.id));
  for (const entry of chosen) await plugin_install(state, { entry, confirmed: true });
  return { updated: chosen.map((u) => u.id) };
};

// A built-in plugin into your folder, to change it; your copy runs instead from the next start.
const plugin_copy = async (state, { plugin }) => {
  const found = state.plugins.find((p) => p.id === plugin);
  const files = {};
  for (const name of ["plugin.json", ...found.manifest.files]) {
    const [file] = await PP.call_send("file_read", { root: "built_in", path: `${plugin}/${name}` });
    files[name] = file.data;
  }
  return PP.call_send("plugin_write", { plugin, files, entry: null, copy: "yours" });
};

PP.plugin_set({
  functions: {
    version_compare,
    catalogue_load,
    answer_parse,
    zip_read,
    zip_write,
    plugin_install,
    plugin_update,
    plugin_copy,
  },
  calls: {
    catalogue_load: (d, state) => catalogue_load(state, d),
    plugin_install: (d, state) => plugin_install(state, d),
    plugin_update: (d, state) => plugin_update(state, d),
    plugin_copy: (d, state) => plugin_copy(state, d),
  },
});
