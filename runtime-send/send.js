"use strict";
// Sending (strategy 8): one sequence for every send. A chat's messages go one after another
// (UC2); different chats, side requests and other apps' jobs go side by side, each on a free page
// of its provider, up to the pages-at-once setting (UC1.4). Sends live in the State (`sends`):
// the queue and the failed list are views of it.

const ACTIVE = ["waiting", "sending"];

// ---------- the State's sends (pure) ----------

const send_set = (state, id, fields) => ({
  ...state,
  sends: state.sends.map((s) => (s.id === id ? { ...s, ...fields } : s)),
});

const send_remove = (state, id) => ({ ...state, sends: state.sends.filter((s) => s.id !== id) });

const send_get = (id) => PP.state_get().sends.find((s) => s.id === id);

// A streaming reply's parts into the send: progress, the thinking and the reply so far.
const reply_apply = (send, part) => ({
  ...send,
  progress: part.progress ?? send.progress,
  thinking: part.thinking || send.thinking,
  reply: part.reply || send.reply,
  updates_got: (send.updates_got || 0) + 1,
});

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

// ---------- the queue and the page pool ----------

const message_send = (draft) => {
  const send = {
    id: PP.id_create(),
    turn: PP.id_create(),
    chat: draft.chat || null,
    message: draft.message,
    attachments: draft.attachments || [],
    replaces: draft.replaces || null,
    profile: draft.profile || null,
    plain: !!draft.plain, // a side request sent as it is, without the profile's blocks
    job: draft.job || null,
    status: "queued",
    at: PP.time_get(),
    progress: "",
  };
  PP.state_set((state) => ({ ...state, sends: [...state.sends, send] }));
  if (send.chat) return (queue_run(), send);
  // A side request runs at once; its answer is what the call returns (UC42.3).
  PP.state_set((state) => send_set(state, send.id, { status: "sending" }));
  return send_run(send.id);
};

// Start each chat's first queued send when the chat has none on its way.
const queue_run = () => {
  const sends = PP.state_get().sends;
  const busy = new Set(sends.filter((s) => ACTIVE.includes(s.status)).map((s) => s.chat));
  const next = new Map();
  for (const s of sends.filter((x) => x.status === "queued" && x.chat)) {
    if (!busy.has(s.chat) && !next.has(s.chat)) next.set(s.chat, s);
  }
  for (const s of next.values()) {
    PP.state_set((state) => send_set(state, s.id, { status: "sending" }));
    send_run(s.id);
  }
};

const page_busy = (state, page) =>
  state.sends.some((s) => s.page === page.id && ACTIVE.includes(s.status));

// A free page of the provider, preferring the chat's own site chat; a new one up to the setting.
const pool_remove = async (send, provider, url) => {
  const state = PP.state_get();
  const free = state.pages.filter((p) => p.provider === provider.id && !page_busy(state, p));
  const same = free.find((p) => PP.url_same(p.url, url));
  if (same || free[0]) return (same || free[0]).id;
  const page = await page_add(provider, url);
  return page ? page.id : null;
};

// The one way to open a site page: within "Pages at once" (pages being opened count too, so two
// sends can't both open the last one), kept in the pool. Null when there's no room.
const page_add = async (provider, url) => {
  let room = false;
  PP.state_set((s) => {
    room = s.pages.length + (s.opening || 0) < PP.setting_get(s, "sites.pages");
    return room ? { ...s, opening: (s.opening || 0) + 1 } : s;
  });
  if (!room) return null;
  try {
    const page = await PP.call_send("page_open", { url: url || provider.url, provider });
    PP.state_set((s) => ({ ...s, pages: [...s.pages, page] }));
    return page;
  } finally {
    PP.state_set((s) => ({ ...s, opening: s.opening - 1 }));
  }
};

// A page is free again: sends waiting for one can go.
const pool_add = () => {
  for (const s of PP.state_get().sends.filter((x) => x.status === "waiting")) {
    PP.state_set((state) => send_set(state, s.id, { status: "sending" }));
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

const send_run = async (id) => {
  if (send_get(id).chat) await PP.chat_load(send_get(id).chat);
  const send = send_get(id);
  const state = PP.state_get();
  const chat = send.chat && state.chats.find((c) => c.id === send.chat);
  const turns = chat ? state.turns.filter((t) => t.chat === chat.id) : [];
  let waiting = false;
  try {
    const route = (await PP.hook_run("chat_route", null, { chat, message: send.message })) || {};
    // A route can pick the profile, or lend only a provider (its site and model, UC44).
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
    const context = { chat: view, message: send.message, count: turns.length + 1, first };
    const built = send.plain
      ? { text: send.message, trace: [], notes: [], blocks: [] }
      : await PP.message_build(state, context, PP.hook_get);
    let answer;
    if (plugin.manifest.tags.includes("api")) {
      PP.state_set((s) =>
        send_set(s, id, { status: "sending", progress: `Sending to ${plugin.manifest.name}…` }),
      );
      const progress = (part) =>
        PP.state_set((s) => ({
          ...s,
          sends: s.sends.map((x) => (x.id === id ? reply_apply(x, part) : x)),
        }));
      answer = await PP.hook_get(plugin.id, "chat_send")(built.text, { ...context, progress });
    } else {
      let page = await pool_remove(send, provider, url || provider.url);
      // A chat's send waits for `pool_add`; a side request's caller waits for its answer here.
      while (!page && !chat)
        page = await PP.pause(500).then(() => pool_remove(send, provider, url || provider.url));
      if (!page) {
        PP.state_set((s) =>
          send_set(s, id, { status: "waiting", progress: "Waiting for a free site page…" }),
        );
        return void (waiting = true);
      }
      PP.state_set((s) =>
        send_set(s, id, {
          status: "sending",
          page,
          progress: `Sending to ${plugin.manifest.name}…`,
        }),
      );
      // The page shows this chat's conversation before anything is typed: a chat's own site
      // chat, or the site's start (a new site chat) for a new chat or a side request. A free page
      // may still show another chat's conversation.
      const target = url || provider.url;
      const shown = PP.state_get().pages.find((p) => p.id === page);
      if (!shown || !PP.url_same(shown.url, target)) {
        PP.state_set((s) =>
          send_set(s, id, {
            progress: `Opening ${first ? "a new chat on" : "this chat on"} ${plugin.manifest.name}…`,
          }),
        );
        await PP.call_send("page_navigate", { page, to: target, wait: true });
        PP.state_set((s) => ({
          ...s,
          pages: s.pages.map((p) => (p.id === page ? { ...p, url: target } : p)),
        }));
      }
      const model = PP.model_get(state, view);
      const options = PP.options_get(state, view);
      if (model || Object.keys(options).length)
        await PP.call_send("site_model_set", { page, model, options });
      const limits = {
        idle_min: PP.setting_get(state, "sites.idle_min"),
        total_min: PP.setting_get(state, "sites.total_min"),
      };
      answer = await PP.call_send("site_send", {
        page,
        text: built.text,
        attachments: send.attachments,
        limits,
      });
    }
    const reply = await PP.hook_run("reply_after", answer.reply, {
      chat: view,
      notes: built.notes,
    });
    if (!chat) return send_done(id, { ...answer, received: answer.reply, reply });
    await turn_save(id, {
      ...built,
      ...answer,
      received: answer.reply,
      reply,
      profile: PP.profile_get(state, view).name,
    });
  } catch (error) {
    const part = (send_get(id) || {}).reply;
    if (part && chat)
      await turn_save(id, {
        reply: part,
        received: part,
        error,
        notes: [`cut short: ${error.message}`],
      });
    else PP.state_set((s) => send_set(s, id, { status: "failed", error, progress: "" }));
  } finally {
    if (!waiting) (queue_run(), pool_add());
  }
};

// A side request is done: the send goes away and its answer goes back to whoever asked.
const send_done = (id, answer) => {
  PP.state_set((s) => send_remove(s, id));
  return answer;
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
    thought_ms: answer.thought_ms || 0,
    tags: tagged.tags,
    profile: answer.profile || "",
    model: answer.model || "",
    page_url: answer.url || "",
    blocks: answer.blocks || [],
    notes: answer.notes || [],
    diagnostics: { ...(answer.diagnostics || {}), got: send.updates_got || 0 },
    ...(answer.error && { error: answer.error }),
  };
  const name =
    chat.name && chat.name !== "New chat" ? chat.name : send.message.split("\n")[0].slice(0, 60);
  const count = state.turns.filter((t) => t.chat === chat.id && t.id !== send.replaces).length + 1;
  await PP.record_apply((s) => {
    const kept = s.turns.filter((t) => t.id !== send.replaces);
    const chats = s.chats.map((c) =>
      c.id === chat.id
        ? { ...c, name, site_url: answer.url || c.site_url, updated: PP.time_get() }
        : c,
    );
    const next = {
      ...send_remove(s, id),
      turns: [...kept, turn],
      chats,
      counters: tagged.counters,
    };
    return { state: next, targets: [{ chat: chat.id }, { file: "counters" }] };
  }, `chat: ${name} (#${count})`);
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

const send_stop = async (id) => {
  const send = send_get(id);
  if (!send) return;
  if (send.status === "sending" && send.page) await PP.call_send("site_stop", { page: send.page });
  else PP.state_set((s) => send_remove(s, id));
};

// Retry: queue it again. Check: keep what the page shows now. Edit: back into the box. Dismiss.
const failure_resolve = async (id, choice) => {
  const send = send_get(id);
  if (choice === "retry") {
    PP.state_set((s) => send_set(s, id, { status: "queued", error: null }));
    return queue_run();
  }
  if (choice === "check") {
    const [last] = (
      await PP.call_send("site_read", { page: send.page, which: "newest", wait: true })
    ).slice(-1);
    return turn_save(id, {
      reply: last.reply,
      received: last.reply,
      thinking: last.thinking,
      notes: ["checked on the page"],
    });
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
    return;
  }
  PP.state_set((s) => send_remove(s, id));
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
const page_changed = (event) =>
  PP.state_set((s) => {
    if (event.status === "closed")
      return { ...s, pages: s.pages.filter((p) => p.id !== event.page) };
    const fields = ["url", "title", "status", "popup", "error"].filter((k) => k in event);
    const update = (p) => ({ ...p, ...Object.fromEntries(fields.map((k) => [k, event[k]])) });
    return { ...s, pages: s.pages.map((p) => (p.id === event.page ? update(p) : p)) };
  });

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
    page_add,
    message_send,
    attachments_check,
    queue_run,
    reply_apply,
    send_set,
    send_stop,
    failure_resolve,
    job_run,
    provider_build,
  },
  calls: {
    message_send: (draft) => message_send(draft),
    send_stop: (d) => send_stop(d.send),
    failure_resolve: (d) => failure_resolve(d.send, d.choice),
    job_run: (job) => job_run(job),
  },
  events: { reply_changed, page_changed, job_received: job_run },
});
