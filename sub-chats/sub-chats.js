"use strict";
// Sub-chats (UC44): a sub-chat is a run of turns that went to one site chat (the turn's
// `page_url`). Before a message goes out, `chat_route` sends it to a new site chat (on the
// provider you picked, the chat's own plugins still running), back to an earlier one, or where
// it was. "New sub-chat here" under a reply starts one that sees the chat up to that reply, then
// only its own turns (Memory asks `sub_chat_turns_get`). The pending choice is screen state; the
// branches are the plugin's chat data.

const ID = "sub-chats";
const same = (a, b) => PP.url_same(a, b);
const site_name = (url) => PP.site_name_get(url);

// Runs of turns with one site chat, each numbered by its site chat in first-seen order.
const segments_get = (turns) => {
  const urls = [];
  return turns.reduce((list, t, i) => {
    const last = list[list.length - 1];
    if (last && (!t.page_url || same(last.url, t.page_url))) return ((last.count += 1), list);
    if (!urls.some((u) => same(u, t.page_url))) urls.push(t.page_url);
    const number = urls.findIndex((u) => same(u, t.page_url)) + 1;
    return [...list, { url: t.page_url, start: i, count: 1, number, model: t.model }];
  }, []);
};

const want_get = (state, chat) => (state.ui.sub_chats || {})[chat] || null;
const want_set = (chat, want) =>
  PP.ui_set((ui) => ({ sub_chats: { ...(ui.sub_chats || {}), [chat]: want } }));
const turns_get = (state, chat) =>
  PP.turns_shown ? PP.turns_shown(state, chat) : state.turns.filter((t) => t.chat === chat);

// What the next message's site chat can see: all of it, or up to a branch's reply and then its own.
const sub_chat_turns_get = (state, chat) => {
  const turns = turns_get(state, chat.id);
  const want = want_get(state, chat.id);
  if (want && want.mode === "new")
    return Number.isInteger(want.cut) ? turns.slice(0, want.cut) : [];
  const segments = segments_get(turns);
  const current = segments[segments.length - 1];
  const branch =
    current &&
    ((PP.chat_data_get(state, chat.id, ID) || {}).branches || []).find(
      (b) => b.start === current.start,
    );
  return branch ? [...turns.slice(0, branch.cut), ...turns.slice(current.start)] : turns;
};

const chat_route = (_, { chat }) => {
  const state = PP.state_get();
  const want = chat && want_get(state, chat.id);
  if (!want) return null;
  want_set(chat.id, null);
  if (want.mode === "go") return { url: want.url, provider: want.provider };
  if (Number.isInteger(want.cut)) {
    const data = PP.chat_data_get(state, chat.id, ID) || { branches: [] };
    const branch = { start: turns_get(state, chat.id).length, cut: want.cut };
    PP.apply_try((s) => PP.chat_data_set(s, chat.id, ID, { branches: [...data.branches, branch] }));
  }
  return { url: "new", provider: want.provider };
};

const note = (
  text,
  chat,
) => PP.html`<div class="chips" style="justify-content:center"><small>${text}</small>
  <button class="pill" onClick=${() => want_set(chat, null)}>Cancel</button></div>`;
const note_text = (w) =>
  w.mode === "new"
    ? `Next message: a new sub-chat${w.cut ? `, after message ${w.cut}` : ""}`
    : "Next message: back to an earlier sub-chat";

// A divider where each sub-chat starts, and where the next message goes under the last turn.
const turn_render = (turn, { chat, turns, index }) => {
  const segments = segments_get(turns);
  const starts = segments.find((s) => s.start === index);
  const want = want_get(PP.state_get(), chat.id);
  return {
    before:
      segments.length > 1 && starts
        ? PP.html`<button class="label" style="text-align:center" onClick=${() => PP.sheet_open("sub_chats")}>
      Sub-chat ${starts.number} · ${site_name(starts.url)}</button>`
        : null,
    after: want && index === turns.length - 1 ? note(note_text(want), chat.id) : null,
  };
};

const sub_chats_sheet = (state, { cut }) => {
  const chat = PP.chat_get(state);
  if (!chat) return { title: "Sub-chats", rows: [PP.item_render({ label: "Open a chat first" })] };
  const segments = segments_get(turns_get(state, chat.id));
  const providers = state.plugins.filter((p) => (p.manifest.tags || []).includes("web"));
  const pick = (want) => (want_set(chat.id, want), PP.sheet_close());
  const provider_of = (url) =>
    (providers.find((p) => site_name(p.manifest.provider.url) === site_name(url)) || {}).id;
  return {
    title: "Sub-chats",
    rows: [
      PP.html`<div class="label">New sub-chat${cut ? `, after message ${cut}` : ""}, on</div>`,
      PP.html`<div class="chips">${providers.map((p) => PP.html`<button class="pill" key=${p.id} onClick=${() => pick({ mode: "new", provider: p.id, cut })}>${p.manifest.name}</button>`)}</div>`,
      PP.html`<div class="label">In this chat</div>`,
      ...segments.map((s, i) =>
        PP.item_render({
          key: s.start,
          label: `Sub-chat ${s.number} · ${site_name(s.url)} · ${s.count} message${s.count === 1 ? "" : "s"}`,
          sub: i === segments.length - 1 ? "Now" : "Tap to continue there",
          onClick: () =>
            i < segments.length - 1 &&
            pick({ mode: "go", url: s.url, provider: provider_of(s.url) }),
        }),
      ),
    ],
  };
};

PP.plugin_set({
  functions: { sub_chat_turns_get },
  hooks: { chat_route, turn_render },
  sheets: { sub_chats: sub_chats_sheet },
  commands: [
    { id: "sub_chats", label: "Sub-chats", place: "Chat", run: () => PP.sheet_open("sub_chats") },
    {
      id: "sub_chat_here",
      label: "New sub-chat here",
      place: "Reply",
      run: (state, { turn }) =>
        PP.sheet_open("sub_chats", {
          cut: turns_get(state, turn.chat).findIndex((t) => t.id === turn.id) + 1,
        }),
    },
  ],
});
