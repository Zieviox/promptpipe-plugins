"use strict";
// Base64 (UC45): the message goes out encoded with an instruction to answer in base64, and the
// reply is decoded. Lenient decoding repairs what it can and says what it fixed; strict fails.

const ID = "base64";
const BAD = /[�\u0000-\u0008\u000E-\u001F]/g;

const text_encode = (text) => PP.base64_encode(new TextEncoder().encode(text));

// One base64 string to text (repaired unless strict): { text, fixes }, or an error when strict and damaged.
const text_decode = (raw, strict) => {
  const fixes = [];
  let s = raw.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  if (/[^A-Za-z0-9+/]/.test(s)) {
    if (strict) throw new Error("the base64 has characters that don't belong");
    s = s.replace(/[^A-Za-z0-9+/]/g, "");
    fixes.push("removed characters that don't belong");
  }
  if (s.length % 4 === 1) {
    if (strict) throw new Error("the base64 is cut off");
    s = s.slice(0, -1);
    fixes.push("dropped a stray character");
  }
  const bytes = Uint8Array.from(atob(s + "=".repeat((4 - (s.length % 4)) % 4)), (c) =>
    c.charCodeAt(0),
  );
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), fixes };
  } catch {
    if (strict) throw new Error("the decoded bytes aren't UTF-8 text");
    return {
      text: new TextDecoder().decode(bytes),
      fixes: [...fixes, "some bytes weren't UTF-8 (shown as �)"],
    };
  }
};

// The longest run of base64-looking words, short words at its start left out ("Here it is").
const words_find = (text) => {
  const runs = [[]];
  for (const w of text
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/```\w*/g, " ")
    .split(/\s+/))
    if (/^[A-Za-z0-9+/_=-]+$/.test(w)) runs[runs.length - 1].push(w);
    else if (runs[runs.length - 1].length) runs.push([]);
  const trimmed = runs.map((r) =>
    r.slice(
      Math.max(
        0,
        r.findIndex((w) => w.length >= 12),
      ),
    ),
  );
  return trimmed.sort((a, b) => b.join("").length - a.join("").length)[0] || [];
};

const bad_count = (text) => (text.match(BAD) || []).length;

// The reply decoded. Up to 3 trailing words (a sign-off that looks like base64) are tried
// without; a garbled last 15% is dropped; text that never was base64 is refused.
const reply_decode = (reply, strict) => {
  const words = words_find(reply);
  if (words.join("").length < 16) throw new Error("no base64 in the reply");
  let best = null;
  for (let cut = 0; cut <= Math.min(3, words.length - 1); cut += 1) {
    let out;
    try {
      out = text_decode(words.slice(0, words.length - cut).join(""), strict);
    } catch (error) {
      if (cut === 0 && strict) throw error;
      continue;
    }
    if (cut) out.fixes.push(`left out ${cut} word${cut > 1 ? "s" : ""} after it`);
    if (!best || bad_count(out.text) < bad_count(best.text)) best = out;
    if (!bad_count(out.text)) break;
  }
  if (!best) throw new Error("the base64 in the reply doesn't decode");
  const first_bad = best.text.search(BAD);
  if (!strict && first_bad > best.text.length * 0.85) {
    best.text = best.text
      .slice(0, first_bad)
      .replace(/[^\s.!?"')\]]*$/, "")
      .trimEnd();
    best.fixes.push("dropped a garbled ending");
  }
  const readable = (best.text.match(/[\p{L}\p{N}\s.,;:!?'"()-]/gu) || []).length;
  if (
    bad_count(best.text) > Math.max(2, best.text.length * 0.03) ||
    readable < best.text.length * 0.6
  )
    throw new Error("the reply doesn't decode to readable text");
  return best;
};

const setting = (context, key) => PP.plugin_setting_get(PP.state_get(), context.chat, ID, key);

// Set to "only the blocks I pick", each picked block is marked and the instruction goes once.
const send_before = (text, context) => {
  const encode = setting(context, "encode");
  const instruction = setting(context, "instruction");
  const body = encode ? text_encode(text) : text;
  if (!context.pick)
    return `${instruction}${encode ? "\nMy message below is base64 encoded UTF-8; decode it first." : ""}\n\n${body}`;
  const marked = encode ? `[base64 block]\n${body}\n[end of base64 block]` : body;
  if (context.pick.i) return marked;
  return `${instruction}${encode ? "\nBlocks marked [base64 block] are base64 encoded UTF-8; decode them first." : ""}\n\n${marked}`;
};

const reply_after = (reply, context) => {
  try {
    const out = reply_decode(reply, setting(context, "strict"));
    if (out.fixes.length) context.notes.push(`Base64: repaired: ${out.fixes.join(", ")}`);
    return out.text;
  } catch (error) {
    if (!setting(context, "keep")) throw error;
    context.notes.push(`Base64: not decoded: ${error.message}`);
    return reply;
  }
};

// Under every reply, whether or not the plugin is on: the decoded text in a sheet.
const reply_show = (state, { turn }) => {
  try {
    const out = reply_decode(turn.received || turn.reply, false);
    const fixed = out.fixes.length ? `\n\n*Repaired: ${out.fixes.join(", ")}*` : "";
    PP.sheet_open("text", { title: "Decoded", text: out.text + fixed });
  } catch (error) {
    PP.toast(error.message, true);
  }
};

PP.plugin_set({
  functions: { reply_decode },
  hooks: { send_before, reply_after },
  commands: [{ id: "base64_decode", label: "Decode base64", place: "Reply", run: reply_show }],
});
