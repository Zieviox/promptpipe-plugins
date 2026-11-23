"use strict";
// Memory (UC43): pinned facts, then the earlier chat, in front of a message. Below the maximum
// everything goes in full; above it the recent turns stay word for word and older ones go in as
// summaries: level 1 sums up `chunk` turns, level 2 `chunk` level-1 summaries, and so on, each
// made once by a side request in the background. The oldest go in at the coarsest level that
// fits. The summaries are the plugin's chat data, shown and edited as the chat file's "Memory"
// section.

const ID = "memory";
const setting = (chat, key) => PP.plugin_setting_get(PP.state_get(), chat, ID, key);

// Text from a chat can't pose as memory's own structure: a heading or one of memory's own
// bracketed labels at the start of a line is escaped.
const text_escape = (text) =>
  String(text || "").replace(
    /^(\s*)(#|\[(?:End of|Memory|Facts|Summar|System|The user|The AI))/gim,
    "$1\\$2",
  );
const clip = (text, n) => (text.length > n ? `${text.slice(0, n)}…` : text);
const site_name = (url) => PP.site_name_get(url);

const turn_format = (turn, named, side = "both", n = Infinity) => {
  const ai = named ? site_name(turn.page_url) : "AI";
  const you = side !== "ai" ? `User: ${clip(text_escape(turn.message), n)}` : "";
  const reply = side !== "you" ? `${ai}: ${clip(text_escape(turn.reply), n)}` : "";
  return [you, reply].filter(Boolean).join("\n");
};

const turns_get = (state, chat) =>
  PP.sub_chat_turns_get
    ? PP.sub_chat_turns_get(state, chat)
    : PP.turns_shown
      ? PP.turns_shown(state, chat.id) // with branches, the path shown
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
  const pinned = text_escape(String(setting(chat, "pinned") || "").trim());
  const lines = turns.map((t) => turn_format(t, named));
  const budget = setting(chat, "budget");
  const full = memory_build(pinned, [], lines, context);
  if (full.text.length <= budget) return full;
  const recent = setting(chat, "recent");
  const kept = lines.slice(Math.max(0, lines.length - recent));
  const older = lines.slice(0, Math.max(0, lines.length - recent));
  const levels = setting(chat, "overflow") === "summary" ? data_get(state, chat).levels : [];
  const room = budget - memory_build(pinned, [], kept, context).text.length - 130;
  const summary = older_build(older, levels, setting(chat, "chunk"), room, setting(chat, "clip"));
  return memory_build(pinned, summary, kept, context);
};

// The memory as it goes out, in the old app's words (X6); the profile's "at depth N" System
// prompts go N messages up from the end of the messages.
const memory_build = (pinned, summary, lines, context) => {
  if (!pinned && !summary.length && !lines.length) return { text: "" };
  const with_depth = [...lines];
  for (const d of [...(context.depth || [])].sort((a, b) => a.number - b.number))
    with_depth.splice(Math.max(0, with_depth.length - d.number), 0, d.text);
  const out = [];
  if (pinned) out.push(`Facts to remember:\n${pinned}`);
  if (summary.length)
    out.push(
      `Summary of the earlier conversation, oldest first (each part says whose side it tells, the user's or the AI's):\n${summary.join("\n\n")}`,
    );
  if (lines.length)
    out.push(
      `${summary.length ? "More recent messages" : "Earlier messages"}:\n${with_depth.join("\n\n")}`,
    );
  const body = out.join("\n\n");
  const text = `[Memory: context from earlier in this conversation. Use it, don't repeat it back.]\n\n${body}\n\n[End of memory]`;
  return { text, depth_used: lines.length > 0 && (context.depth || []).length > 0 };
};

// ---------- making summaries (after a reply, in the background) ----------

const SIDE = { you: "The user's side", ai: "The AI's side" };
const SIDE_ASK = {
  you: "Below are only the user's messages. The AI's replies are not included: do not guess or add them. Summarise what the user said, did, decided and wants. Write nothing the user did not say.",
  ai: "Below are only the AI's messages. The user's messages are not included. Summarise what the AI said and did: its characters, the story and the facts it gave. Do not credit any of it to the user.",
};
const WHAT = { you: "The user's messages", ai: "The AI's messages", both: "Conversation" };

// One summary request, in the old app's words: the request, which side, then the turns (or the
// summaries of consecutive parts). Comment lines and side headings the AI adds are dropped.
const summary_ask = async (chat, parts, of_summaries, side) => {
  const what = WHAT[side];
  const body = of_summaries
    ? `[Summaries of consecutive parts${side !== "both" ? `, ${SIDE[side].toLowerCase()}` : ""}, oldest first]\n${parts.join("\n\n---\n\n")}\n[End of summaries]`
    : `[${what}]\n${parts.join("\n\n")}\n[End of ${what.toLowerCase()}]`;
  const message = [setting(chat, "request").trim(), SIDE_ASK[side], body]
    .filter(Boolean)
    .join("\n\n");
  const plain = !setting(chat, "summary_plugins");
  const profile = PP.profile_get(PP.state_get(), chat).id;
  const answer = await PP.message_send({ message, plain, profile });
  const text = String(answer.reply || "")
    .split("\n")
    .filter((l) => !/^\s*<!--.*-->\s*$/.test(l) && !/^\s*#{1,4}\s*(user|ai)\s*:?\s*$/i.test(l))
    .join("\n")
    .trim();
  if (!text) throw new Error("the summary came back empty");
  return text;
};

// One summary of the given texts: your side and the AI's apart (two requests), or together.
const part_make = async (chat, texts, of_summaries) => {
  if (setting(chat, "sides") === "together")
    return { text: await summary_ask(chat, texts.both, of_summaries, "both") };
  const you = await summary_ask(chat, texts.you, of_summaries, "you");
  const ai = await summary_ask(chat, texts.ai, of_summaries, "ai");
  return { you, ai, text: `${SIDE.you}:\n${you}\n\n${SIDE.ai}:\n${ai}` };
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
        levels[level].push({
          from,
          to: from + chunk,
          ...(await part_make(chat, texts, level > 0)),
        });
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
    if (mark) ((at = `${mark[1] - 1}/${mark[2] - 1}`), (edits[at] = []));
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

// A message as a site shows it, back to what you typed (an import): Memory's part taken off.
const sent_unwrap = (text) =>
  String(text || "")
    .replace(/\[Memory:[^\]]*\][\s\S]*?\[End of memory\]\s*/g, "")
    .trim();

PP.plugin_set({
  hooks: { block_text, reply_after, chat_section_format, chat_section_parse, sent_unwrap },
});
