"use strict";
// Memory (UC43): pinned facts, then the earlier chat, in front of a message. Below the maximum
// everything goes in full; above it the recent turns stay word for word and older ones go in as
// summaries: level 1 sums up `chunk` turns, level 2 `chunk` level-1 summaries, and so on, each
// made once by a side request in the background. The oldest go in at the coarsest level that
// fits. The summaries are the plugin's chat data, shown and edited as the chat file's "Memory"
// section.

const ID = "memory";
const setting = (chat, key) => PP.plugin_setting_get(PP.state_get(), chat, ID, key);

// Text from a chat can't pose as memory's own structure: a line starting with "#" is escaped.
const text_escape = (text) => String(text || "").replace(/^(\s*)#/gm, "$1\\#");
const clip = (text, n) => (text.length > n ? `${text.slice(0, n)}…` : text);
const site_name = (url) => {
  try {
    return new URL(url).host.replace(/^(www|chat)\./, "").split(".")[0];
  } catch {
    return "AI";
  }
};

const turn_format = (turn, named, side = "both", n = Infinity) => {
  const ai = named ? `AI (${site_name(turn.page_url)})` : "AI";
  const you = side !== "ai" ? `You: ${clip(text_escape(turn.message), n)}` : "";
  const reply = side !== "you" ? `${ai}: ${clip(text_escape(turn.reply), n)}` : "";
  return [you, reply].filter(Boolean).join("\n");
};

const turns_get = (state, chat) =>
  PP.sub_chat_turns_get
    ? PP.sub_chat_turns_get(state, chat)
    : state.turns.filter((t) => t.chat === chat.id);
const data_get = (state, chat) => PP.chat_data_get(state, chat.id, ID) || { levels: [] };

// The parts that stand for the older turns: the finest summaries first, then (oldest first) a
// run of `chunk` same-level parts is swapped for the coarser summary of them while it's too
// long; turns no summary covers yet go in clipped; the oldest are dropped last.
const older_build = (older, levels, chunk, room, n) => {
  let items = [];
  for (let i = 0; i < older.length; ) {
    const part = (levels[0] || []).find((p) => p.from === i && p.to <= older.length);
    items.push(
      part
        ? {
            level: 1,
            index: (levels[0] || []).indexOf(part),
            text: part.text,
            size: part.to - part.from,
          }
        : { level: 0, text: older[i], size: 1 },
    );
    i += part ? part.to - part.from : 1;
  }
  const length = () => items.reduce((sum, item) => sum + item.text.length + 2, 0);
  for (let level = 1; length() > room && level <= levels.length; level += 1) {
    for (let at = 0; length() > room && at < items.length; at += 1) {
      const run = items.slice(at, at + chunk);
      const whole =
        run.length === chunk && run.every((x) => x.level === level) && run[0].index % chunk === 0;
      const coarser = whole && (levels[level] || [])[run[0].index / chunk];
      if (coarser)
        items.splice(at, chunk, {
          level: level + 1,
          index: run[0].index / chunk,
          text: coarser.text,
        });
    }
  }
  items = items.map((x) => (x.level ? x : { ...x, text: clip(x.text, n) }));
  while (items.length && length() > room) items.shift();
  return items.map((x) => x.text);
};

// The memory text for a message (a `block_text` hook): nothing in a side request, nothing between
// the every-N messages unless it's a new site chat.
const block_text = (context) => {
  const chat = context.chat;
  if (!chat || !chat.id) return "";
  if (!context.first && (context.count - 1) % setting(chat, "every") !== 0) return "";
  const state = PP.state_get();
  let turns = turns_get(state, chat);
  if (setting(chat, "send") === "unseen" && !context.first)
    turns = turns.filter((t) => t.page_url !== chat.site_url);
  const named = setting(chat, "names") && new Set(turns.map((t) => site_name(t.page_url))).size > 1;
  const pinned = String(setting(chat, "pinned") || "").trim();
  const head = pinned ? `## Pinned facts\n\n${text_escape(pinned)}` : "";
  const lines = turns.map((t) => turn_format(t, named));
  const full = [head, lines.length ? `## Earlier in this chat\n\n${lines.join("\n\n")}` : ""]
    .filter(Boolean)
    .join("\n\n");
  const budget = setting(chat, "budget");
  if (full.length <= budget) return full;
  const recent = setting(chat, "recent");
  const kept = lines.slice(Math.max(0, lines.length - recent));
  const older = lines.slice(0, Math.max(0, lines.length - recent));
  const levels = setting(chat, "overflow") === "summary" ? data_get(state, chat).levels : [];
  const room = budget - head.length - kept.join("\n\n").length - 80;
  const summary = older_build(older, levels, setting(chat, "chunk"), room, setting(chat, "clip"));
  return [
    head,
    summary.length ? `## Earlier (summarised)\n\n${summary.join("\n\n")}` : "",
    `## Recent\n\n${kept.join("\n\n")}`,
  ]
    .filter(Boolean)
    .join("\n\n");
};

// ---------- making summaries (after a reply, in the background) ----------

const summary_ask = async (chat, text) => {
  const plain = !setting(chat, "summary_plugins");
  const answer = await PP.message_send({
    message: `${setting(chat, "request")}\n\n${text}`,
    plain,
    profile: PP.profile_get(PP.state_get(), chat).id,
  });
  return String(answer.reply || "").trim();
};

// One summary of the given texts: your side and the AI's apart (two requests), or together.
const part_make = async (chat, texts) => {
  if (setting(chat, "sides") === "together")
    return { text: await summary_ask(chat, texts.both.join("\n\n")) };
  const you = await summary_ask(chat, texts.you.join("\n\n"));
  const ai = await summary_ask(chat, texts.ai.join("\n\n"));
  return { you, ai, text: `Your side: ${you}\n\nAI side: ${ai}` };
};

let making = false;

// The summaries the chat will need soon: once the memory comes within `ahead` average messages of
// the maximum, each finished chunk of older turns (and of summaries) not yet summed up is made.
const summaries_make = async (chat_id) => {
  const state = PP.state_get();
  const chat = state.chats.find((c) => c.id === chat_id);
  if (making || !chat || setting(chat, "overflow") !== "summary") return;
  const turns = turns_get(state, chat);
  const named = setting(chat, "names") && new Set(turns.map((t) => site_name(t.page_url))).size > 1;
  const size = turns.reduce((sum, t) => sum + turn_format(t, named).length, 0);
  if (size + setting(chat, "ahead") * (size / Math.max(1, turns.length)) <= setting(chat, "budget"))
    return;
  const chunk = setting(chat, "chunk");
  const older = turns.slice(0, Math.max(0, turns.length - setting(chat, "recent")));
  making = true;
  try {
    const levels = structuredClone(data_get(state, chat).levels);
    for (
      let level = 0, count = older.length;
      count >= chunk;
      count = Math.floor(count / chunk), level += 1
    ) {
      levels[level] ||= [];
      for (let i = levels[level].length; (i + 1) * chunk <= count; i += 1) {
        const from = i * chunk;
        const below = level
          ? levels[level - 1].slice(from, from + chunk)
          : older.slice(from, from + chunk);
        const texts = level
          ? {
              both: below.map((p) => p.text),
              you: below.map((p) => p.you || p.text),
              ai: below.map((p) => p.ai || p.text),
            }
          : {
              both: below.map((t) => turn_format(t, named)),
              you: below.map((t) => turn_format(t, named, "you")),
              ai: below.map((t) => turn_format(t, named, "ai")),
            };
        levels[level].push({ from, to: from + chunk, ...(await part_make(chat, texts)) });
        await PP.apply_try(
          (s) => PP.chat_data_set(s, chat.id, ID, { levels }),
          `memory: ${chat.name}`,
        );
      }
    }
  } catch (error) {
    PP.toast(`Memory couldn't make a summary: ${error.message}`, true);
  } finally {
    making = false;
  }
};

const reply_after = (reply, context) => {
  if (context.chat && context.chat.id) setTimeout(() => summaries_make(context.chat.id), 1000);
  return reply;
};

// ---------- the chat file's "Memory" section (D6, D7) ----------

const MARK = /^### Level (\d+), part (\d+)$/;

const chat_section_format = (sections, { chat }) => {
  const levels = data_get(PP.state_get(), chat).levels;
  if (!levels.length) return [];
  const parts = levels.flatMap((list, l) =>
    list.map((p, i) => `### Level ${l + 1}, part ${i + 1}\n\n${p.text}`),
  );
  return [{ plugin: ID, title: "Memory", text: parts.join("\n\n") }];
};

// Your corrections to a summary's text are kept (its two sides become the edited text).
const chat_section_parse = (text, data = { levels: [] }) => {
  const levels = structuredClone(data.levels);
  let at = null;
  const edits = {};
  for (const line of text.split("\n")) {
    const mark = MARK.exec(line.trim());
    if (mark) (at = `${mark[1] - 1}/${mark[2] - 1}`), (edits[at] = []);
    else if (at) edits[at].push(line);
  }
  for (const [key, body] of Object.entries(edits)) {
    const [l, i] = key.split("/").map(Number);
    const part = levels[l] && levels[l][i];
    const edited = body.join("\n").trim();
    if (part && edited !== part.text) levels[l][i] = { from: part.from, to: part.to, text: edited };
  }
  return { levels };
};

PP.plugin_set({ hooks: { block_text, reply_after, chat_section_format, chat_section_parse } });
