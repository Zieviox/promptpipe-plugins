"use strict";
// Loads runtime plugins the way the loader does (each file in its own scope, given PP), with
// stand-ins for the calls, so the application is tested without a phone (B4, B5).
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

// A PP with the calls answered by `answers` (name → function of data), the rest unimplemented.
const pp_build = (answers = {}) => {
  const pp = { calls: {}, sent: [], state: null };
  let n = 0;
  pp.id_create = () => `id${(n += 1)}`;
  pp.time_get = () => "2026-11-21T10:00:00.000Z";
  pp.content_read = (plugin, file) => fs.readFileSync(path.join(ROOT, plugin, file), "utf8");
  pp.events = {};
  pp.hooks = {};
  pp.hook_get = (plugin, name) => (pp.hooks[plugin] || {})[name];
  pp.plugin_set = (def) => {
    Object.assign(pp, def.functions || {});
    Object.assign(pp.calls, def.calls || {});
    for (const [name, fn] of Object.entries(def.events || {})) (pp.events[name] ||= []).push(fn);
  };
  pp.state_get = () => pp.state;
  pp.pause = (ms) => new Promise((r) => setTimeout(r, ms));
  pp.base64_decode = (text) => new Uint8Array(Buffer.from(text, "base64"));
  pp.base64_encode = (bytes) => Buffer.from(bytes).toString("base64");
  pp.state_set = (change) => (pp.state = change(pp.state));
  pp.event_send = (name, data) => (
    pp.sent.push({ event: name, data }), (pp.events[name] || []).forEach((f) => f(data))
  );
  pp.call_send = async (name, data) => {
    pp.sent.push({ name, data });
    const answer = answers[name] || pp.calls[name];
    if (!answer) throw { code: "unimplemented", message: `${name} is not supported here` };
    return answer(data, pp.state);
  };
  return pp;
};

// Load the listed plugins' files, in order, into one PP.
const plugins_load = (ids, answers) => {
  const pp = pp_build(answers);
  for (const id of ids) {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, id, "plugin.json"), "utf8"));
    // Each plugin gets its own PP whose plugin_set also keeps its hooks, as the loader does.
    const own = Object.create(pp);
    own.plugin_set = (def) => {
      pp.plugin_set(def);
      pp.hooks[id] = { ...(pp.hooks[id] || {}), ...(def.hooks || {}) };
    };
    const page = [].concat(manifest.content_script || []);
    for (const file of manifest.files.filter((f) => f.endsWith(".js") && !page.includes(f))) {
      const code = fs.readFileSync(path.join(ROOT, id, file), "utf8");
      new Function("PP", code)(own);
    }
  }
  return pp;
};

module.exports = { pp_build, plugins_load };
