"use strict";
// Profiles: what goes out is built from the chat's profile, top to bottom (UC1, UC23): System
// prompts by their rule, your message where its block sits, a plugin's text where its block sits,
// a plugin's change to the blocks above it (or your message, or picked blocks); "at depth"
// prompts go where a plugin's earlier chat puts them, else just before your message.

const JOIN = "\n\n";
const PLUGIN = "runtime-profiles";

// Whether a System prompt goes with this message (count: the message's number in the chat;
// first: the first message of a site chat).
const prompt_send_get = (block, count, first) => {
  if (block.send === "off") return false;
  if (block.send === "first") return first;
  if (block.send === "every_n") return first || count % Math.max(1, block.number || 1) === 0;
  return true;
};

const blocks_get = (state, profile) => state.config.blocks.filter((b) => b.profile === profile.id);

const prompt_text_get = (state, block) => {
  const linked = block.link && state.prompts.find((p) => p.id === block.link);
  return ((linked ? linked.text : block.text) || "").trim();
};

const block_name_get = (state, block) => {
  if (block.type === "message") return "Your message";
  if (block.type === "plugin") {
    const plugin = state.plugins.find((p) => p.id === block.plugin);
    const name = plugin ? plugin.manifest.name : block.plugin;
    return block.text_block ? `${name} · ${block.text_block}` : name;
  }
  const linked = block.link && state.prompts.find((p) => p.id === block.link);
  const text = linked ? linked.name || linked.text : block.name || block.text;
  return (text || "").trim().split("\n")[0].slice(0, 40) || "(empty system prompt)";
};

// The message for a chat. hook_get(plugin, hook) gives a plugin's `block_text` or `send_before`
// function, or nothing. Returns { text, trace, notes, blocks }.
const message_build = async (state, { chat, message, count, first }, hook_get) => {
  const profile = PP.profile_get(state, chat);
  const parts = []; // { key, text } in order; the message's place has key "message"
  const trace = [{ label: "You", text: message }];
  const notes = [];
  const sent = [];
  let text = message;
  const live = blocks_get(state, profile).filter(
    (b) => b.type === "message" || PP.block_on_get(state, chat, b),
  );
  const depth = live
    .filter((b) => b.type === "prompt" && b.send === "depth" && prompt_text_get(state, b))
    .map((b) => ({
      text: prompt_text_get(state, b),
      number: b.number || 0,
      name: block_name_get(state, b),
    }));
  const context = { chat, profile, first, count, depth, depth_used: false };
  const joined = () =>
    parts
      .map((p) => (p.key === "message" ? text : p.text))
      .filter((t) => t.trim())
      .join(JOIN);

  for (const block of live) {
    const name = block_name_get(state, block);
    if (block.type === "message") parts.push({ key: "message" });
    else if (block.type === "prompt") {
      const body = prompt_text_get(state, block);
      if (block.send === "depth" || !body || !prompt_send_get(block, count, first)) continue;
      parts.push({ key: block.id, text: body });
      sent.push(name);
      trace.push({ label: `System prompt · ${name}`, text: body });
    } else {
      const note = (n) => notes.push(`${name}: ${n}`);
      const adds = hook_get(block.plugin, "block_text");
      const changes = hook_get(block.plugin, "send_before");
      if (adds) {
        const out = await adds({ ...context, message: text, text_block: block.text_block, note });
        if (out && out.depth_used) context.depth_used = true;
        const body = typeof out === "string" ? out : (out && out.text) || "";
        if (body.trim()) parts.push({ key: block.id, text: body.trim() });
        trace.push({ label: `${name} · text`, text: body });
      } else if (changes && block.scope === "message") {
        text = await changes(text, { ...context, note });
        trace.push({ label: `${name} · before`, text });
      } else if (changes && block.scope === "picked") {
        const picked = parts.filter((p) => (block.picked || []).includes(p.key));
        const total = picked.length;
        for (const [i, p] of picked.entries()) {
          const pick = { ...context, note, pick: { i, n: total } };
          if (p.key === "message") text = await changes(text, pick);
          else p.text = await changes(p.text, pick);
        }
        trace.push({ label: `${name} · before`, text: joined() });
      } else if (changes) {
        const out = await changes(joined(), { ...context, note });
        parts.splice(0, parts.length, { key: "changed", text: out });
        trace.push({ label: `${name} · before`, text: out });
      }
    }
  }
  if (depth.length && !context.depth_used) {
    const at = parts.findIndex((p) => p.key === "message");
    const texts = depth.map((d) => ({ key: "depth", text: d.text }));
    parts.splice(at < 0 ? parts.length : at, 0, ...texts);
  }
  const where = context.depth_used ? "" : ", before your message";
  sent.push(...depth.map((d) => `${d.name} (depth ${d.number}${where})`));
  if (sent.length) notes.push(`${profile.name}: ${sent.join(", ")}`);
  return { text: joined() || text, trace, notes, blocks: sent };
};

// What a profile would send, without running anything; plugins show as markers (UC25).
const preview_build = (state, profile, first = true) => {
  const out = [];
  for (const block of blocks_get(state, profile)) {
    const name = block_name_get(state, block);
    if (block.type === "message") out.push("⟨your message⟩");
    else if (block.on === false) continue;
    else if (block.type === "prompt") {
      const body = prompt_text_get(state, block);
      if (block.send !== "depth" && body && prompt_send_get(block, 1, first)) out.push(body);
    } else {
      const scope = { message: "your message", picked: "the blocks picked" }[block.scope];
      out.push(`⟨${name} adds its text or changes ${scope || "everything above"}⟩`);
    }
  }
  const depth = blocks_get(state, profile).filter((b) => b.type === "prompt" && b.send === "depth");
  if (depth.length) {
    const list = depth.map((b) => `${block_name_get(state, b)} ${b.number || 0} up`);
    out.push(`⟨at depth: ${list.join(", ")} in the earlier chat⟩`);
  }
  return out.join(JOIN);
};

// ---------- templates (X6) ----------

// The shipped templates (their texts from content files) and yours.
const text_read = (name) => PP.content_read(PLUGIN, `templates/${name}.md`).trim();

const template_list = (state) => {
  const shipped = JSON.parse(PP.content_read(PLUGIN, "templates.json")).templates.map((t) => ({
    ...t,
    shipped: true,
    blocks: t.blocks.map((b) => (b.text_file ? { ...b, text: text_read(b.text_file) } : b)),
  }));
  const yours = (state.config.templates || []).map((t) => ({
    ...t,
    blocks: state.config.blocks.filter((b) => b.profile === t.id),
  }));
  return [...shipped, ...yours];
};

// A new profile from a template: its blocks and groups copied with new ids.
const profile_create = (state, { template, name, id }) => {
  const source = template_list(state).find((t) => t.id === template);
  if (!source) return { error: { code: "not_found", message: `no template "${template}"` } };
  const groups = state.config.groups.filter((g) => g.profile === template);
  const group_ids = new Map(groups.map((g) => [g.id, PP.id_create()]));
  const group_get = (b) => group_ids.get(b.group) || "";
  const copy = (b) => ({ ...b, id: PP.id_create(), profile: id, group: group_get(b) });
  const config = {
    ...state.config,
    profiles: [...state.config.profiles, { id, name, plugin_settings: {} }],
    blocks: [...state.config.blocks, ...source.blocks.map(({ text_file, ...b }) => copy(b))],
    groups: [
      ...state.config.groups,
      ...groups.map((g) => ({ ...g, id: group_ids.get(g.id), profile: id })),
    ],
  };
  return { state: { ...state, config }, record: { id, name }, targets: [{ file: "config" }] };
};

// The chat's page's models, the model the page shows, and the provider's options (UC10).
const model_list = async (state, chat) => {
  const provider = PP.provider_get(state, chat);
  const page = state.pages.find((p) => p.provider === provider);
  const plugin = state.plugins.find((p) => p.id === provider);
  const id = page
    ? page.id
    : (await PP.call_send("page_open", { provider: PP.provider_build(state, plugin) })).id;
  return PP.call_send("site_model_list", { page: id });
};

PP.plugin_set({
  functions: {
    prompt_send_get,
    message_build,
    preview_build,
    template_list,
    profile_create,
    model_list,
  },
  calls: {
    message_build: (d, state) => message_build(state, d, PP.hook_get),
    model_list: (d, state) => model_list(state, d.chat),
  },
});
