"use strict";
// An OpenAI-style chat API (UC9 with an API provider): the chat's earlier turns and the built
// message go out as messages, the answer streams back as `http_received` lines ("data: {...}").
// The key never comes here: the platform adds the named credential for its hosts (S6).

const ID = "openai";
const streams = {}; // request id → what to do with each line

const setting = (chat, key) => PP.plugin_setting_get(PP.state_get(), chat, ID, key);

const request_build = (chat, body) => ({
  url: `${String(setting(chat, "base_url")).replace(/\/$/, "")}/${body ? "chat/completions" : "models"}`,
  method: body ? "POST" : "GET",
  headers: { "Content-Type": "application/json" },
  credential: setting(chat, "credential"),
  body: body ? JSON.stringify(body) : "",
});

const response_check = (r) => {
  if (r.status < 400) return r;
  let message = r.body;
  try {
    message = JSON.parse(r.body).error.message;
  } catch {}
  throw {
    code: r.status === 401 || r.status === 403 ? "permission_denied" : "unavailable",
    message: `The API said (${r.status}): ${String(message).slice(0, 300)}`,
  };
};

const chat_send = async (text, context) => {
  const state = PP.state_get();
  const chat = context.chat;
  const earlier = chat
    ? state.turns.filter((t) => t.chat === chat.id).slice(-setting(chat, "history"))
    : [];
  const messages = [
    ...earlier.flatMap((t) => [
      { role: "user", content: t.sent || t.message },
      { role: "assistant", content: t.received || t.reply },
    ]),
    { role: "user", content: text },
  ];
  const model = PP.model_get(state, chat);
  if (!model)
    throw { code: "failed_precondition", message: "Pick a model first (Model and Options)" };
  const id = PP.id_create();
  let reply = "";
  let thinking = "";
  streams[id] = (line) => {
    const data = line.startsWith("data:") ? line.slice(5).trim() : "";
    if (!data || data === "[DONE]") return;
    try {
      const delta = JSON.parse(data).choices[0].delta || {};
      reply += delta.content || "";
      thinking += delta.reasoning_content || delta.reasoning || "";
      context.progress({ reply, thinking });
    } catch {}
  };
  try {
    const r = response_check(
      await PP.call_send("http_fetch", {
        ...request_build(chat, { model, messages, stream: true }),
        id,
        stream: true,
      }),
    );
    if (!reply && r.body)
      reply = (JSON.parse(r.body).choices || [{ message: {} }])[0].message.content || "";
    return { reply, thinking, model };
  } finally {
    delete streams[id];
  }
};

// The service's models, for Model and Options.
const model_list = async (state, chat) => {
  const r = response_check(await PP.call_send("http_fetch", request_build(chat, null)));
  const models = (JSON.parse(r.body).data || []).map((m) => m.id).sort();
  return { models, model: PP.model_get(state, chat), options: [] };
};

PP.plugin_set({
  hooks: { chat_send, model_list },
  events: { http_received: (e) => streams[e.request] && streams[e.request](e.part) },
});
