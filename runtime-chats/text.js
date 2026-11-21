"use strict";
// The text form of a chat (D1, strategy 12): one pure function writes a chat as readable Markdown,
// one reads an edit you chose to keep back. Hidden marker lines (`<!-- pp:… -->`) let the app
// find each part again; everything else is plain Markdown any app can show. The same text serves
// copying, sharing and exporting a chat.

const yaml_value = (value) => {
  const text = String(value ?? "");
  return /^[\w./@+-][\w ./@+-]*$/.test(text) && text.trim() === text ? text : JSON.stringify(text);
};

const yaml_parse = (text) => {
  const value = text.trim();
  if (!value.startsWith('"')) return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    return value;
  }
};

// A code fence longer than any run of backticks in the text, so the text can't close it.
const fence_format = (text) => {
  const longest = Math.max(3, ...(String(text).match(/`+/g) || [""]).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  return `${fence}text\n${text}\n${fence}`;
};

// "2026-11-21 10:05" in the phone's time zone (its offset in minutes, given by the loader).
const time_format = (iso, offset_min = 0) => {
  const local = new Date(Date.parse(iso) + offset_min * 60000);
  if (Number.isNaN(local.getTime())) return iso || "";
  return local.toISOString().slice(0, 16).replace("T", " ");
};

const details_format = (summary, body) =>
  [`<details><summary>${summary}</summary>`, "", body, "", "</details>"].join("\n");

// info: { provider, model, profile, offset_min } as names for people to read.
// sections: [{ plugin, title, text }] from the plugins' `chat_section_format` hook.
const chat_format = (chat, info = {}, sections = []) => {
  const head = [
    "---",
    `id: ${chat.id}`,
    `name: ${yaml_value(chat.name)}`,
    `provider: ${yaml_value(info.provider)}`,
    `model: ${yaml_value(info.model)}`,
    `profile: ${yaml_value(info.profile)}`,
    `tags: [${(chat.tags || []).map(yaml_value).join(", ")}]`,
    `created: ${chat.created || ""}`,
    `updated: ${chat.updated || ""}`,
    "---",
    "",
    `# ${chat.name || "Untitled chat"}`,
    "",
  ];
  const source = [
    chat.site_url
      ? `Source: [${info.provider || "AI chat"}](${chat.site_url})`
      : `AI: ${info.provider || "?"}`,
    info.model && `Model: ${info.model}`,
    info.profile && `Profile: ${info.profile}`,
    chat.tags && chat.tags.length && `Chat tags: ${chat.tags.map((t) => `\`${t}\``).join(" ")}`,
  ].filter(Boolean);
  const out = [...head, `> ${source.join(" · ")}`, ""];
  (chat.turns || []).forEach((turn, i) => {
    const when = time_format(turn.at, info.offset_min);
    out.push(`<!-- pp:turn ${turn.id} -->`, `## ${i + 1} · ${when}`, "");
    if (turn.tags && turn.tags.length) {
      out.push(`Tags: ${turn.tags.map((t) => `\`${t}\``).join(" ")}`, "");
    }
    out.push("<!-- pp:you -->", "### You", "", turn.message || "", "");
    if (turn.thinking) {
      out.push("<!-- pp:thinking -->", details_format("Thinking", turn.thinking), "");
    }
    out.push("<!-- pp:reply -->", `### ${info.provider || "AI"}`, "", turn.reply || "", "");
    const sent = fence_format(turn.sent || "");
    const raw = `Sent:\n\n${sent}\n\nRaw reply:\n\n${fence_format(turn.received || "")}`;
    out.push("<!-- pp:sent -->", details_format("Sent and raw reply", raw), "");
  });
  for (const section of sections) {
    const body = details_format(section.title, section.text);
    out.push(`<!-- pp:section ${section.plugin} -->`, body, "");
  }
  return out.join("\n");
};

const heading_drop = (text) => text.replace(/^\s*###[^\n]*\n/, "").trim();
const details_drop = (text) =>
  text
    .trim()
    .replace(/^<details><summary>[^<]*<\/summary>\s*/, "")
    .replace(/\s*<\/details>$/, "")
    .trim();

// An edited readable file back into what it holds: the name, the chat tags, each turn's message,
// thinking and reply by turn id, and the plugins' sections by plugin id.
const chat_parse = (text) => {
  const front = /^---\n([\s\S]*?)\n---/.exec(text);
  const meta = {};
  for (const line of front ? front[1].split("\n") : []) {
    const pair = /^(\w+):\s?(.*)$/.exec(line);
    if (pair) meta[pair[1]] = pair[2];
  }
  const tags = (meta.tags || "").replace(/^\[|\]$/g, "").match(/"(?:[^"\\]|\\.)*"|[^,]+/g) || [];
  const result = {
    id: meta.id,
    name: yaml_parse(meta.name || ""),
    tags: tags.map(yaml_parse).filter(Boolean),
    turns: [],
    sections: {},
  };
  const parts = text.split(/^<!-- pp:(\w+)(?: (\S+))? -->[ \t]*$/m);
  let turn = null;
  for (let i = 1; i < parts.length; i += 3) {
    const [mark, arg, body] = [parts[i], parts[i + 1], parts[i + 2] || ""];
    if (mark === "turn") result.turns.push((turn = { id: arg }));
    else if (mark === "you" && turn) turn.message = heading_drop(body);
    else if (mark === "thinking" && turn) turn.thinking = details_drop(body);
    else if (mark === "reply" && turn) turn.reply = heading_drop(body);
    else if (mark === "section") result.sections[arg] = details_drop(body);
  }
  return result;
};

PP.plugin_set({ functions: { chat_format, chat_parse, time_format } });
