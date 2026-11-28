"use strict";
// Sending (strategy 8): one sequence for every send. A chat's messages go one after another
// (UC2); different chats, side requests and other apps' jobs go side by side, each on a free page
// of its provider, up to the pages-at-once setting (UC1.4). Sends live in the State (`sends`):
// the queue and the failed list are views of it.

const ACTIVE = ["waiting", "sending", "checking"];

// ---------- the State's sends (pure) ----------

const send_set = (state, id, fields) => ({
  ...state,
  sends: state.sends.map((s) => (s.id === id ? { ...s, ...fields } : s)),
});

const send_remove = (state, id) => ({ ...state, sends: state.sends.filter((s) => s.id !== id) });

const send_get = (id) => PP.state_get().sends.find((s) => s.id === id);

// A streaming reply's parts into the send: progress, the thinking and the reply so far, and when
// the thinking and the writing first showed (how long it thought: the sites don't say).
const reply_apply = (send, part) => ({
  ...send,
  progress: part.progress ?? send.progress,
  thinking: part.thinking || send.thinking,
  reply: part.reply || send.reply,
  thinking_at: send.thinking_at || (part.thinking ? Date.now() : 0),
  writing_at: send.writing_at || (part.reply ? Date.now() : 0),
  updates_got: (send.updates_got || 0) + 1,
});
// How long it thought: from the first thinking to the first of the reply (or now); 0 when the
// thinking only came with the finished reply.
const thought_ms_get = (send) =>
  send.thinking_at ? (send.writing_at || Date.now()) - send.thinking_at : 0;

// ---------- attachments (UC48) ----------

// What stops these attachments going to this provider, said plainly; null when nothing does.
// A provider declares what it really sends in `provider.accepts` ({ types, max }); max 0 (or no
// `accepts`) means its plugin has no way to send attachments yet.
const type_match = (pattern, type) =>
  pattern === "*/*" ||
  pattern === type ||
  (pattern.endsWith("/*") && String(type || "").startsWith(pattern.slice(0, -1)));

const attachments_check = (plugin, attachments = []) => {
  if (!plugin || !attachments.length) return null;
  const name = plugin.manifest.name;
  const { types = [], max = 0 } = (plugin.manifest.provider || {}).accepts || {};
  const n = attachments.length;
  if (!max)
    return `${name}'s plugin can't send attachments yet (${n} attached). Remove ${n === 1 ? "it" : "them"} to send.`;
  if (n > max) return `${name} takes at most ${max} attachments; ${n} are attached.`;
  const refused = attachments.filter((a) => !types.some((t) => type_match(t, a.mime_type)));
  return refused.length
    ? `${name} doesn't take ${refused.map((a) => a.name).join(", ")} (it takes ${types.join(", ")}).`
    : null;
};

// ---------- the outbox and holds ----------

// A chat's messages not answered yet (queued, failed) are kept in the app's outbox.json, so text
// you typed is never lost to a closed app or an error; one on its way when the app closed comes
// back as failed (storage's state_load).
const outbox_save = async () => {
  try {
    const saved = await PP.store_save(PP.state_get(), [{ file: "outbox" }]);
    PP.state_set((s) => ({ ...s, revisions: { ...s.revisions, ...saved.revisions } }));
  } catch {
    // kept in memory; the next change saves it again
  }
};

// Why a chat's queue holds, or null: one of its messages failed, the reply before was cut short
// or its message removed, or you paused it. Only a reply that comes back, Resume, or a message's
// Send now lets the queue go on (Send now sends that one message, even past a hold).
const hold_get = (state, chat) =>
  state.sends.some((s) => s.chat === chat && s.status === "failed")
    ? "failed"
    : (state.held || {})[chat] || null;

const hold_set = (chat, why) => {
  PP.state_set((s) => {
    const held = { ...(s.held || {}) };
    if (why) held[chat] = why;
    else delete held[chat];
    return { ...s, held };
  });
  outbox_save();
  if (!why) queue_run();
};

// Pause or resume a chat's queue (the bar over its waiting messages).
const queue_pause = (chat, on) => hold_set(chat, on ? "paused" : null);

// Send this waiting message now, past any hold (it still waits for the chat's message on its way).
const send_now = (id) => {
  PP.state_set((s) => send_set(s, id, { force: true }));
  queue_run();
};

// Remove a failed or waiting message: its text back into the box, or discarded (you choose; the
// screen asks). Messages waiting behind it then hold until you resume.
const send_dismiss = async (id, choice) => {
  const send = send_get(id);
  if (!send) return;
  if (choice === "back") {
    await PP.record_apply((s) => {
      const old = s.drafts.find((d) => d.id === send.chat) || {
        id: send.chat,
        text: "",
        attachments: [],
      };
      const text = old.text ? `${old.text}\n\n${send.message}` : send.message;
      const draft = {
        ...old,
        text,
        attachments: [...old.attachments, ...(send.attachments || [])],
      };
      return {
        state: { ...s, drafts: [...s.drafts.filter((d) => d.id !== send.chat), draft] },
        targets: [{ file: "drafts" }],
      };
    });
  }
  const behind = PP.state_get().sends.some(
    (s) => s.chat === send.chat && s.id !== id && s.status === "queued",
  );
  PP.state_set((s) => send_remove(s, id));
  if (behind && send.status === "failed") hold_set(send.chat, "removed");
  else outbox_save();
};

// ---------- the queue and the page pool ----------

const message_send = (draft) => {
  const send = {
    id: PP.id_create(),
    turn: PP.id_create(),
    chat: draft.chat || null,
    message: draft.message,
    attachments: draft.attachments || [],
    replaces: draft.replaces || null, // a new version of that message (an edit, Send again)
    regenerate: !!draft.regenerate, // Send again: the same message, the site's own Regenerate
    profile: draft.profile || null,
    plain: !!draft.plain, // a side request sent as it is, without the profile's blocks
    job: draft.job || null,
    status: "queued",
    at: PP.time_get(),
    progress: "",
  };
  PP.state_set((state) => ({ ...state, sends: [...state.sends, send] }));
  if (send.chat) {
    outbox_save();
    queue_run();
    return send;
  }
  // A side request runs at once; its answer is what the call returns (UC42.3).
  PP.state_set((state) => send_set(state, send.id, { status: "sending" }));
  return send_run(send.id);
};

// Start each chat's first queued send when the chat has none on its way and its queue doesn't
// hold (a message marked Send now goes past the hold).
const queue_run = () => {
  const state = PP.state_get();
  const sends = state.sends;
  const busy = new Set(sends.filter((s) => ACTIVE.includes(s.status)).map((s) => s.chat));
  const next = new Map();
  for (const s of sends.filter((x) => x.status === "queued" && x.chat)) {
    if (busy.has(s.chat) || next.has(s.chat)) continue;
    const forced = sends.find((x) => x.chat === s.chat && x.status === "queued" && x.force);
    if (forced) next.set(s.chat, forced);
    else if (!hold_get(state, s.chat)) next.set(s.chat, s);
  }
  for (const s of next.values()) {
    PP.state_set((state) => send_set(state, s.id, { status: "sending" }));
    send_run(s.id);
  }
};

const page_busy = (state, page) =>
  state.sends.some((s) => s.page === page.id && ACTIVE.includes(s.status));

// A free page of the provider for this send, preferring the chat's own site chat, taken for it in
// the same change that finds it, so two sends never share a page (H2); a new one up to the setting.
const pool_remove = async (id, provider, url) => {
  let page = null;
  PP.state_set((state) => {
    const free = state.pages.filter((p) => p.provider === provider.id && !page_busy(state, p));
    page = free.find((p) => PP.url_same(p.url, url)) || free[0] || null;
    return page ? send_set(state, id, { page: page.id }) : state;
  });
  if (page) return page.id;
  const added = await page_add(provider, url, id);
  return added ? added.id : null;
};

// The one way to open a site page: within "Pages at once" (pages being opened count too, so two
// sends can't both open the last one), kept in the pool, and taken by the send it's opened for in
// the same change. Null when there's no room.
const page_add = async (provider, url, send) => {
  let room = false;
  PP.state_set((s) => {
    room = s.pages.length + (s.opening || 0) < PP.setting_get(s, "sites.pages");
    return room ? { ...s, opening: (s.opening || 0) + 1 } : s;
  });
  if (!room) return null;
  try {
    const page = await PP.call_send("page_open", { url: url || provider.url, provider });
    PP.state_set((s) => {
      const next = { ...s, pages: [...s.pages, page] };
      return send ? send_set(next, send, { page: page.id }) : next;
    });
    return page;
  } finally {
    PP.state_set((s) => ({ ...s, opening: s.opening - 1 }));
  }
};

// A page is free again: the sends waiting for one go, as many as there are free pages of their
// provider and room for new ones (the others keep waiting, nothing is started for nothing).
const pool_add = () => {
  const state = PP.state_get();
  const free = state.pages.filter((p) => !page_busy(state, p));
  let room = PP.setting_get(state, "sites.pages") - state.pages.length - (state.opening || 0);
  for (const s of state.sends.filter((x) => x.status === "waiting")) {
    const at = free.findIndex((p) => p.provider === s.provider);
    if (at >= 0) free.splice(at, 1);
    else if (room > 0) room -= 1;
    else continue;
    PP.state_set((next) => send_set(next, s.id, { status: "sending" }));
    send_run(s.id);
  }
};

// A provider as its page needs it: its description, its reply selector setting first, and the
// content scripts to hand over (the default routine, then the provider's own, S9).
const provider_build = (state, plugin) => {
  const code = (p) =>
    [].concat(p.manifest.content_script || []).map((f) => PP.content_read(p.id, f));
  const site = state.plugins.find((p) => p.id === "runtime-site");
  const def = plugin.manifest.provider || {};
  const own = PP.plugin_setting_get(state, null, plugin.id, "reply_selector");
  const reply = [...(own ? [own] : []), ...((def.selectors || {}).reply || [])];
  const scripts = [site ? code(site).join("\n;\n") : "", ...code(plugin)].filter(Boolean);
  return { id: plugin.id, ...def, selectors: { ...def.selectors, reply }, scripts };
};

// ---------- the sequence ----------

// One send, start to end (strategy 8): its plan, the message, the provider, the reply's hooks,
// saved (a side request's answer goes back to its caller). No free page yet: it waits.
const send_run = async (id) => {
  if (send_get(id).chat) await PP.chat_load(send_get(id).chat);
  const state = PP.state_get();
  const send = send_get(id);
  const chat = send.chat && state.chats.find((c) => c.id === send.chat);
  const path = parent_find(state, send, chat ? PP.turns_shown(state, chat.id) : []);
  if (chat) PP.state_set((s) => send_set(s, id, { parent: path.parent }));
  let waiting = false;
  try {
    const plan = await send_plan(state, send, chat, path);
    const built = await message_get(state, send, path.versioned, plan.context);
    const api = plan.plugin.manifest.tags.includes("api");
    const answer = api ? await api_send(id, plan, built) : await site_send(id, plan, built, path);
    waiting = !answer;
    if (waiting) return;
    // A message sent as typed (the profile off) gets its reply as it came, too.
    const notes = { chat: plan.view, notes: built.notes };
    const reply = send.plain ? answer.reply : await PP.hook_run("reply_after", answer.reply, notes);
    const got = { ...answer, received: answer.reply, reply };
    if (!chat) return send_done(id, got);
    await turn_save(id, { ...built, ...got, profile: PP.profile_get(state, plan.view).name });
  } catch (error) {
    await send_fail(id, error);
  } finally {
    if (!waiting) {
      queue_run();
      pool_add();
    }
  }
};

// The messages as shown (with branches, the path you see); the new one follows the last of them,
// or, as a new version of a message (an edit, Send again), the message that one follows.
const parent_find = (state, send, turns) => {
  const tree = () => PP.turns_tree(state.turns.filter((t) => t.chat === send.chat));
  const versioned = send.replaces && tree().find((t) => t.id === send.replaces);
  const last = turns.length ? turns[turns.length - 1].id : null;
  return { turns, versioned, parent: versioned ? versioned.parent || null : last };
};

// What the send goes through: the chat as its route sees it (a route can pick the profile, or lend
// only a provider: its site and model, UC44), the provider, and the site chat's address.
const send_plan = async (state, send, chat, { turns, parent }) => {
  const route = (await PP.hook_run("chat_route", null, { chat, message: send.message })) || {};
  const own = {
    ...(chat ? chat.own : {}),
    ...(route.profile && { profile: route.profile }),
    ...(route.provider && { provider: route.provider, model: undefined }),
  };
  const view = chat ? { ...chat, own } : send.profile ? { own: { profile: send.profile } } : null;
  const plugin = state.plugins.find((p) => p.id === PP.provider_get(state, view));
  if (!plugin)
    throw { code: "failed_precondition", message: "No provider yet: get one from the header" };
  const refused = attachments_check(plugin, send.attachments);
  if (refused) throw { code: "failed_precondition", message: refused };
  const provider = provider_build(state, plugin);
  const url = route.url === "new" ? provider.url : route.url || (chat && chat.site_url);
  const first = !chat || !turns.length || route.url === "new";
  // Its place on the path shown: after the message it follows (for a new version, the one before).
  const at = turns.findIndex((t) => t.id === parent);
  const count = !parent ? 1 : at >= 0 ? at + 2 : turns.length + 1;
  const context = { chat: view, message: send.message, count, first };
  return { view, plugin, provider, url: url || provider.url, first, context };
};

// The message as it goes: Send again's as it went (the site re-answering it), a plain one as
// typed, else built from the profile's blocks.
const message_get = (state, send, versioned, context) => {
  const as_is = (text, blocks = []) => ({ text, trace: [], notes: [], blocks });
  if (send.regenerate && versioned)
    return as_is(versioned.sent || versioned.message, versioned.blocks || []);
  if (send.plain) return as_is(send.message);
  return PP.message_build(state, context, PP.hook_get);
};

// An API provider: its plugin's `chat_send`, the reply streaming into the send.
const api_send = (id, plan, built) => {
  const progress_text = `Sending to ${plan.plugin.manifest.name}…`;
  PP.state_set((s) => send_set(s, id, { status: "sending", progress: progress_text }));
  const progress = (part) =>
    PP.state_set((s) => ({
      ...s,
      sends: s.sends.map((x) => (x.id === id ? reply_apply(x, part) : x)),
    }));
  return PP.hook_get(plan.plugin.id, "chat_send")(built.text, { ...plan.context, progress });
};

// A site provider: a page of the pool showing this chat's conversation, on the versions the app
// shows, then the message typed there (or the site's own Regenerate). Null: no free page yet.
const site_send = async (id, plan, built, path) => {
  const page = await page_take(id, plan);
  if (!page) return null;
  await page_show(id, page, plan);
  const state = PP.state_get();
  const limits = {
    idle_min: PP.setting_get(state, "sites.idle_min"),
    total_min: PP.setting_get(state, "sites.total_min"),
  };
  const send = send_get(id);
  const attachments = await files_read(send);
  await versions_show(page, send, path);
  const site_ref = send.regenerate && path.versioned && path.versioned.site_ref;
  if (site_ref) return PP.call_send("site_regenerate", { page, site_ref, limits });
  return PP.call_send("site_send", { page, text: built.text, attachments, limits });
};

// A page for the send: a free one of the pool, or a new one. A side request's caller waits for one
// here; a chat's send waits for `pool_add`.
const page_take = async (id, plan) => {
  const { provider, plugin, url } = plan;
  const chat = send_get(id).chat;
  let page = await pool_remove(id, provider, url);
  while (!page && !chat) page = await PP.pause(500).then(() => pool_remove(id, provider, url));
  if (!page) {
    const progress = "Waiting for a free site page…";
    PP.state_set((s) => send_set(s, id, { status: "waiting", provider: provider.id, progress }));
    return null;
  }
  PP.state_set((s) => ({
    ...send_set(s, id, { status: "sending", progress: `Sending to ${plugin.manifest.name}…` }),
    pages: s.pages.map((p) => (p.id === page ? { ...p, chat } : p)),
  }));
  return page;
};

// The page shows this chat's conversation before anything is typed: a chat's own site chat, or
// the site's start (a new site chat) for a new chat or a side request; a free page may still show
// another chat's. Then the chat's model and options.
const page_show = async (id, page, { url, first, plugin, view }) => {
  const shown = PP.state_get().pages.find((p) => p.id === page);
  if (!shown || !PP.url_same(shown.url, url)) {
    const where = `${first ? "a new chat on" : "this chat on"} ${plugin.manifest.name}`;
    PP.state_set((s) => send_set(s, id, { progress: `Opening ${where}…` }));
    await PP.call_send("page_navigate", { page, to: url, wait: true });
    PP.state_set((s) => ({ ...s, pages: s.pages.map((p) => (p.id === page ? { ...p, url } : p)) }));
  }
  const state = PP.state_get();
  const model = PP.model_get(state, view);
  const options = PP.options_get(state, view);
  if (model || Object.keys(options).length)
    await PP.call_send("site_model_set", { page, model, options });
};

// The attachments' contents, read from the chat's folder, for the page to hand the site.
const files_read = async (send) => {
  const files = [];
  for (const a of send.attachments || []) {
    const read = { root: "chats", path: a.path, encoding: "base64" };
    const [file] = await PP.call_send("file_read", read);
    if (!file)
      throw { code: "not_found", message: `The attached file ${a.name} isn't there any more` };
    files.push({ name: a.name, mime_type: a.mime_type, data: file.data });
  }
  return files;
};

// The site shows the versions the app shows on the way to where this goes (a message switched to
// another version in the app is switched on the site first), so it continues the same branch.
const versions_show = async (page, send, { turns, parent }) => {
  const tree = PP.turns_tree(PP.state_get().turns.filter((t) => t.chat === send.chat));
  for (const t of turns.slice(0, parent ? turns.findIndex((x) => x.id === parent) + 1 : 0)) {
    const versions = tree.filter((x) => (x.parent || null) === (t.parent || null));
    const refs = versions.map((x) => x.site_ref).filter(Boolean);
    if (versions.length > 1 && t.site_ref)
      await PP.call_send("site_version_set", { page, want: t.site_ref, refs }).catch(() => null);
  }
};

// A send that failed. A reply cut short is kept with the error, and the chat's queue holds. Else
// the message waits in the failed list with its reason, and whoever asked hears why: the screen
// (`send_failed`), another app (its job's `job_changed`, failed, H3).
const send_fail = async (id, error) => {
  const send = send_get(id);
  if (!send) return;
  if (send.reply && send.chat) {
    const notes = [`cut short: ${error.message}`];
    await turn_save(id, { reply: send.reply, received: send.reply, error, notes });
    return hold_set(send.chat, "cut short");
  }
  const reason = { code: error.code || "", message: error.message || String(error) };
  PP.state_set((s) => send_set(s, id, { status: "failed", error, progress: "", force: false }));
  outbox_save();
  PP.event_send("send_failed", { send: id, chat: send.chat, message: send.message, error: reason });
  if (send.job) PP.event_send("job_changed", { job: send.job, status: "failed", error: reason });
};

// A side request is done: the send goes away and its answer goes back to whoever asked.
const send_done = (id, answer) => {
  PP.state_set((s) => send_remove(s, id));
  return answer;
};

// Whether an address is one of a provider's own chats (its `chat_urls`, "*" for any part).
const chat_url_is = (state, provider_id, url) => {
  const plugin = state.plugins.find((p) => p.id === provider_id);
  const patterns = ((plugin && plugin.manifest.provider) || {}).chat_urls || [];
  return patterns.some((pattern) =>
    new RegExp(`^${pattern.replace(/[.?+^$()[\]{}|\\]/g, "\\$&").replace(/\*/g, "[^?#]*")}`).test(
      url || "",
    ),
  );
};

// The site chat a chat is linked to after a reply: the page's address only when it's one of the
// site's chats (the start page would make the next message start a new conversation there), and
// never a non-chat address over a chat's own one.
const chat_link_get = (state, chat, url) => {
  const provider = PP.provider_get(state, chat);
  const patterns = ((state.plugins.find((p) => p.id === provider) || {}).manifest || {}).provider;
  const known = patterns && (patterns.chat_urls || []).length;
  if (!url) return chat.site_url;
  if (!known || chat_url_is(state, provider, url)) return url;
  return chat.site_url;
};

// The finished turn, saved with the chat (D1, D2): the chat's tags (counters numbered), the
// chat's name from the first line when it has none, its site chat's address, a short tick.
const turn_save = async (id, answer) => {
  const send = send_get(id);
  const state = PP.state_get();
  const chat = state.chats.find((c) => c.id === send.chat);
  const scope = PP.setting_get(state, "tags.counter_scope") === "all" ? "all" : chat.id;
  const tagged = PP.turn_tags_build(chat.tags || [], state.counters || {}, scope);
  const turn = {
    id: send.turn,
    chat: chat.id,
    at: send.at,
    message: send.message,
    attachments: send.attachments,
    sent: answer.text || "",
    received: answer.received,
    reply: answer.reply,
    thinking: answer.thinking || "",
    thought_ms: answer.thought_ms || thought_ms_get(send),
    tags: tagged.tags,
    profile: answer.profile || "",
    model: answer.model || "",
    page_url: answer.url || "",
    site_ref: answer.site_ref || "",
    parent: send.parent === undefined ? null : send.parent,
    blocks: answer.blocks || [],
    notes: answer.notes || [],
    diagnostics: { ...(answer.diagnostics || {}), got: send.updates_got || 0 },
    ...(answer.error && { error: answer.error }),
  };
  const name =
    chat.name && chat.name !== "New chat" ? chat.name : send.message.split("\n")[0].slice(0, 60);
  const path = PP.turns_shown(state, chat.id);
  const at = path.findIndex((t) => t.id === send.parent);
  const count = !send.parent ? 1 : at >= 0 ? at + 2 : path.length + 1;
  // A new version (an edit, Send again) is kept beside the one it's a version of, and shown.
  const key = send.parent || "root";
  await PP.record_apply((s) => {
    const chats = s.chats.map((c) =>
      c.id === chat.id
        ? {
            ...c,
            name,
            site_url: chat_link_get(s, c, answer.url),
            updated: PP.time_get(),
            ...(send.replaces && { shown: { ...(c.shown || {}), [key]: turn.id } }),
          }
        : c,
    );
    const next = {
      ...send_remove(s, id),
      turns: [...s.turns, turn],
      chats,
      counters: tagged.counters,
    };
    return { state: next, targets: [{ chat: chat.id }, { file: "counters" }] };
  }, `chat: ${name} (#${count})`);
  outbox_save();
  // A reply that came back whole lets a queue held by the one before go on (a pause stays).
  const why = (PP.state_get().held || {})[chat.id];
  if (!answer.error && why && why !== "paused") hold_set(chat.id, null);
  PP.call_send("vibration_start", {}).catch(() => {});
  if (send.job) {
    const done = {
      job: send.job,
      status: "done",
      chat: chat.id,
      reply: turn.reply,
      sent: turn.sent,
    };
    PP.event_send("job_changed", { ...done, thinking: turn.thinking, error: turn.error });
  }
};

// ---------- stopping and failures (UC3, UC4) ----------

// Stop a send: one typing on its page is stopped there (what came is kept); one not sent yet goes
// away, and another app waiting for it hears it was stopped (H3).
const send_stop = async (id) => {
  const send = send_get(id);
  if (!send) return;
  if (send.status === "sending" && send.page) {
    await PP.call_send("site_stop", { page: send.page });
    return;
  }
  PP.state_set((s) => send_remove(s, id));
  const error = { code: "cancelled", message: "Stopped in promptpipe" };
  if (send.job) PP.event_send("job_changed", { job: send.job, status: "failed", error });
};

// Retry: queue it again. Check: keep what the page shows now. Edit: back into the box. Dismiss.
const failure_resolve = async (id, choice) => {
  const send = send_get(id);
  if (choice === "retry") {
    PP.state_set((s) => send_set(s, id, { status: "queued", error: null, force: true }));
    outbox_save();
    return queue_run();
  }
  // Check: the page's newest reply, waited for while it's still being written (never for long),
  // saved as this message's reply; nothing there puts the message back with the reason.
  if (choice === "check") {
    const failed = (message) => (
      PP.state_set((s) =>
        send_set(s, id, { status: "failed", progress: "", error: { code: "not_found", message } }),
      ),
      outbox_save()
    );
    if (!send.page || !PP.state_get().pages.some((p) => p.id === send.page))
      return failed(
        "This message never reached a site page, so there's nothing to check. Tap Retry.",
      );
    PP.state_set((s) => send_set(s, id, { status: "checking", progress: "Checking the page…" }));
    try {
      const [last] = (
        await PP.call_send("site_read", {
          page: send.page,
          which: "newest",
          wait: true,
          limits: { idle_min: 0.5, total_min: 3 },
        })
      ).slice(-1);
      if (!last || !last.reply)
        return failed(
          "The page shows no reply to this message yet. Open the site to look, or tap Retry.",
        );
      return turn_save(id, {
        reply: last.reply,
        received: last.reply,
        thinking: last.thinking,
        notes: ["checked on the page"],
      });
    } catch (error) {
      return failed(`Couldn't check the page: ${error.message}`);
    }
  }
  if (choice === "edit") {
    const draft = { id: send.chat, text: send.message, attachments: send.attachments };
    await PP.record_apply((s) => ({
      state: {
        ...send_remove(s, id),
        drafts: [...s.drafts.filter((d) => d.id !== send.chat), draft],
      },
      targets: [{ file: "drafts" }],
    }));
    const behind = PP.state_get().sends.some((x) => x.chat === send.chat && x.status === "queued");
    return behind ? hold_set(send.chat, "removed") : outbox_save();
  }
  return send_dismiss(id, choice === "back" ? "back" : "discard");
};

// ---------- a saved reply against the site's ----------

const words_same = (a, b) =>
  String(a || "")
    .replace(/\s+/g, " ")
    .trim() ===
  String(b || "")
    .replace(/\s+/g, " ")
    .trim();

// The site's own version of a saved reply (one cut short, or any you doubt): the chat's site chat
// opened on a free page, the message found there (by what was sent, else by its place from the
// end), and its reply taken when it differs. Answers "updated", "same" or why it couldn't.
const turn_check = async (id) => {
  const state = PP.state_get();
  const turn = state.turns.find((t) => t.id === id);
  const chat = turn && state.chats.find((c) => c.id === turn.chat);
  if (!chat) return { status: "missing", why: "That message isn't here any more." };
  if (!chat.site_url)
    return {
      status: "missing",
      why: "This chat isn't linked to a site chat yet, so there's nothing to compare with.",
    };
  const plugin = state.plugins.find((p) => p.id === PP.provider_get(state, chat));
  if (!plugin || !plugin.manifest.tags.includes("web"))
    return { status: "missing", why: "Only chats on a site can be checked against it." };
  const provider = provider_build(state, plugin);
  const check = { id: PP.id_create(), chat: null, status: "checking", message: "" };
  PP.state_set((s) => ({ ...s, sends: [...s.sends, check] })); // holds the page while it reads
  try {
    const page = await pool_remove(check.id, provider, chat.site_url);
    if (!page)
      return {
        status: "missing",
        why: "Every site page is busy. Try again when the replies are in.",
      };
    const shown = PP.state_get().pages.find((p) => p.id === page);
    if (!shown || !PP.url_same(shown.url, chat.site_url))
      await PP.call_send("page_navigate", { page, to: chat.site_url, wait: true });
    const site = await PP.call_send("site_read", { page, which: "all" });
    const mine = PP.turns_shown(PP.state_get(), chat.id);
    const by_text = site.filter(
      (t) => words_same(t.message, turn.sent) || words_same(t.message, turn.message),
    );
    const from_end = mine.length - 1 - mine.findIndex((t) => t.id === id);
    const by_ref = turn.site_ref && site.find((t) => t.site_ref === turn.site_ref);
    const found = by_ref || by_text[by_text.length - 1] || site[site.length - 1 - from_end];
    if (!found || !found.reply)
      return { status: "missing", why: "That message wasn't found in the site chat." };
    const reply = await PP.hook_run("reply_after", found.reply, { chat, notes: [] });
    if (words_same(found.reply, turn.received || turn.reply) && words_same(reply, turn.reply))
      return { status: "same" };
    await PP.record_apply(
      (s) =>
        PP.record_set(s, {
          collection: "turns",
          id,
          fields: {
            received: found.reply,
            reply,
            thinking: found.thinking || turn.thinking,
            error: null,
            notes: [
              ...(turn.notes || []).filter((n) => !/^cut short/.test(n)),
              "updated from the site",
            ],
          },
        }),
      `reply updated from the site: ${chat.name}`,
    );
    const why = (PP.state_get().held || {})[chat.id];
    if (why === "cut short") hold_set(chat.id, null);
    return { status: "updated" };
  } finally {
    PP.state_set((s) => send_remove(s, check.id));
    queue_run();
    pool_add();
  }
};

// A saved reply through the chat's reply plugins again, from what came back (an imported Base64
// reply decoded, say); no site needed.
const turn_redo = async (id) => {
  const state = PP.state_get();
  const turn = state.turns.find((t) => t.id === id);
  const chat = turn && state.chats.find((c) => c.id === turn.chat);
  if (!chat) return { status: "missing", why: "That message isn't here any more." };
  const received = turn.received || turn.reply;
  const reply = await PP.hook_run("reply_after", received, { chat, notes: [] });
  if (words_same(reply, turn.reply)) return { status: "same" };
  await PP.record_apply(
    (s) => PP.record_set(s, { collection: "turns", id, fields: { reply, received } }),
    `reply plugins run again: ${chat.name}`,
  );
  return { status: "updated" };
};

// ---------- other apps' requests (UC41) ----------

// A job becomes a send in its chat (a saved one, or a new one in the API folder); `models` jobs
// answer with the profiles' names. The answer goes back as `job_changed` events.
const job_run = async (job) => {
  const state = PP.state_get();
  if (job.request === "cancel") {
    // The caller left (#209): stop the send that answers the job.
    const send = state.sends.find((s) => s.job === job.id);
    return send && send_stop(send.id);
  }
  if (job.request === "models") {
    return PP.event_send("job_changed", {
      job: job.id,
      status: "done",
      models: state.config.profiles.map((p) => p.name),
    });
  }
  const profile = state.config.profiles.find(
    (p) => p.name.toLowerCase() === String(job.profile || "").toLowerCase(),
  );
  let chat = job.chat;
  if (!chat) {
    const folder = PP.setting_get(state, "api.folder") || "";
    const id = PP.id_create();
    const own = profile ? { profile: profile.id } : {};
    await PP.record_apply((s) => PP.chat_create(s, { id, message: job.message, folder, own }));
    chat = id;
  }
  const send = message_send({ chat, message: job.message, job: job.id });
  PP.event_send("job_changed", { job: job.id, status: "sending", chat, send: send.id });
};

// ---------- events ----------

// What the platform reports about a page (its address, title, state, a sign-in pop-up, an error)
// kept in the pool; a closed page leaves it.
const page_changed = (event) => {
  PP.state_set((s) => {
    if (event.status === "closed")
      return { ...s, pages: s.pages.filter((p) => p.id !== event.page) };
    const fields = ["url", "title", "status", "popup", "error"].filter((k) => k in event);
    const update = (p) => ({ ...p, ...Object.fromEntries(fields.map((k) => [k, event[k]])) });
    return { ...s, pages: s.pages.map((p) => (p.id === event.page ? update(p) : p)) };
  });
  // The page moved to a site chat's address after its chat's reply was saved (a new site chat gets
  // its address late): that chat is linked to it now, if it isn't linked to a site chat yet.
  const state = PP.state_get();
  const page = state.pages.find((p) => p.id === event.page);
  const chat = page && page.chat && state.chats.find((c) => c.id === page.chat);
  if (!chat || !event.url || !chat_url_is(state, page.provider, event.url)) return;
  if (chat.site_url && chat_url_is(state, page.provider, chat.site_url)) return;
  PP.record_apply(
    (s) => PP.record_set(s, { collection: "chats", id: chat.id, fields: { site_url: event.url } }),
    `linked: ${chat.name}`,
  ).catch(() => null);
};

const reply_changed = (event) => {
  const send = PP.state_get().sends.find((s) => s.page === event.page && s.status === "sending");
  if (!send) return;
  PP.state_set((s) => ({
    ...s,
    sends: s.sends.map((x) => (x.id === send.id ? reply_apply(x, event) : x)),
  }));
  if (send.job)
    PP.event_send("job_changed", { job: send.job, status: "sending", reply: event.reply });
};

PP.plugin_set({
  functions: {
    thought_ms_get,
    page_add,
    message_send,
    attachments_check,
    queue_run,
    reply_apply,
    send_set,
    send_stop,
    failure_resolve,
    send_dismiss,
    send_now,
    outbox_save,
    queue_pause,
    hold_get,
    turn_check,
    turn_redo,
    job_run,
    provider_build,
  },
  calls: {
    message_send: (draft) => message_send(draft),
    send_stop: (d) => send_stop(d.send),
    failure_resolve: (d) => failure_resolve(d.send, d.choice),
    turn_check: (d) => turn_check(d.turn),
    turn_redo: (d) => turn_redo(d.turn),
    job_run: (job) => job_run(job),
  },
  events: { reply_changed, page_changed, job_received: job_run },
  // Messages kept from before the app closed: the queues go on where they don't hold.
  hooks: { app_start: () => queue_run() },
});
