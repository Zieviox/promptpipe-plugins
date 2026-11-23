"use strict";
// The default way of using a site (UC42.7), as a content script the app hands each page (S9): type
// the message, press Send, wait for the reply, read it as Markdown, read and set the model and the
// options, list the site's chats, and outline the page for a report. Driven by the provider's
// `Provider_Def`; a provider's own content script replaces single stages. Runs in the site's page.

const selectors_get = (provider, name) => (provider.selectors || {})[name] || [];

const visible = (el) => !!el && el.getClientRects().length > 0;

const all_find = (selector) => {
  try {
    return [...document.querySelectorAll(selector)];
  } catch (error) {
    return []; // a broken selector matches nothing
  }
};

// The first visible match of a selector list, tried in order.
const element_find = (list) => {
  for (const s of list) {
    const el = all_find(s).find(visible);
    if (el) return el;
  }
  return null;
};

const text_get = (el) => (el ? (el.innerText || el.textContent || "").trim() : "");

const wait_for = async (find, ms) => {
  for (const end = Date.now() + ms; ; await PP.pause(250)) {
    const found = find();
    if (found || Date.now() > end) return found;
  }
};

const LOGIN =
  /^\s*(log ?in|sign ?in|fazer login|entrar|iniciar sesi[oó]n|anmelden|se connecter|connexion|accedi|登录|ログイン)\s*$/i;
const logged_out = () =>
  all_find("button, a, [role=button]").some((b) => visible(b) && LOGIN.test(text_get(b)));

const fail = (code, message) => Object.assign(new Error(message), { code });

// ---------- the reply as Markdown ----------

const markdown = (() => {
  const service = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  service.use(turndownPluginGfm.gfm);
  service.remove([
    "button",
    "svg",
    "style",
    "script",
    "noscript",
    "template",
    "textarea",
    "input",
    "select",
    "nav",
    "form",
  ]);
  return service;
})();

// The one way site text comes into the app: an element's HTML as Markdown (Turndown with GFM:
// headings, lists, tables, code), the provider's parts of the given kinds left out; plain text if
// the conversion fails. A reply leaves out its thinking and the "strip" parts (citations); the
// thinking leaves out "strip". The screen then shows all text with one Markdown renderer.
const markdown_get = (provider, el, drop = ["strip"]) => {
  if (!el) return "";
  const copy = el.cloneNode(true);
  for (const s of drop.flatMap((kind) => selectors_get(provider, kind))) {
    try {
      copy.querySelectorAll(s).forEach((n) => n.remove());
    } catch (error) {
      // a broken selector removes nothing
    }
  }
  try {
    return markdown.turndown(copy).trim() || text_get(el);
  } catch (error) {
    return text_get(el);
  }
};
const reply_format = (provider, el) => markdown_get(provider, el, ["thinking", "strip"]);
const thinking_format = (provider, el) => markdown_get(provider, el, ["strip"]);

// ---------- errors from the site ----------

// A refusal, a human check or a login the provider's own `error_find` reports; one already on
// the page before the send (`old`) belongs to an earlier message; one with no element (a check over
// the whole page) stops a send at once.
const error_find = (provider, old) => {
  const own = PP.stages.error_find;
  let found = own ? own(provider) : null;
  if (typeof found === "string") found = { text: found };
  if (!found || !found.text || (found.el && old && old.has(found.el))) return null;
  return found;
};

// ---------- reading the reply ----------

const reply_last = (provider) => {
  for (const s of selectors_get(provider, "reply")) {
    const els = all_find(s);
    if (els.length && text_get(els[els.length - 1])) return els[els.length - 1];
  }
  return null;
};

const snapshot_take = (provider) =>
  Object.fromEntries(
    selectors_get(provider, "reply").map((s) => {
      const els = all_find(s);
      return [s, { count: els.length, last: text_get(els[els.length - 1]) }];
    }),
  );

const thinking_last = (provider) => {
  for (const s of selectors_get(provider, "thinking")) {
    const els = all_find(s);
    if (els.length) return els[els.length - 1];
  }
  return null;
};

// Watch the reply: new text, new thinking, or Stop showing is activity. Finished when it holds
// still with no Stop for the settle time; Stop showing over an unchanged reply for the stuck time
// is taken as stuck. Progress goes to the app as `reply_changed`; a numbers-only log of the last
// changes is kept for waits of 30 s or more (never any text).
const reply_read = async (provider, before, limits = {}, old = null) => {
  const start = Date.now();
  const settle = provider.settle_ms || 2000;
  const stuck = provider.stuck_ms || 45000;
  const idle = (limits.idle_min || 0) * 60000;
  const total = (limits.total_min || 0) * 60000;
  const log = [];
  let text = "";
  let thinking = "";
  let stable = Date.now();
  let active = Date.now();
  let changed = Date.now();
  let shape = "";
  // Numbers only (never text), kept for every reply: how it grew on the page, and how many
  // progress updates went to the app (the reply's sheet shows them under Live updates).
  let sent = 0;
  const progress = (data) => ((sent += 1), PP.event_send("reply_changed", data));
  const diagnostics = () => ({ log: log.slice(-30), sent });
  while (!(total && Date.now() - start >= total) && !(idle && Date.now() - active >= idle)) {
    if (PP.cancelled()) {
      if (text) return { reply: text, thinking, diagnostics: diagnostics() };
      throw fail(
        "cancelled",
        "Stopped waiting before any reply came (if the site answers anyway, add the page's newest reply)",
      );
    }
    await PP.pause(250);
    const error = error_find(provider, old);
    if (error) throw fail("permission_denied", error.text);
    let now = "";
    let shown = 0;
    for (const s of selectors_get(provider, "reply")) {
      const els = all_find(s);
      shown = Math.max(shown, els.length);
      const last = text_get(els[els.length - 1]);
      const was = before[s] || { count: 0, last: "" };
      if (last && (els.length > was.count || last !== was.last)) {
        now = last;
        break;
      }
    }
    const busy = !!element_find(selectors_get(provider, "stop"));
    const th = thinking_format(provider, thinking_last(provider));
    const next = [
      busy,
      now.length,
      th.length,
      shown,
      innerWidth,
      innerHeight,
      document.hidden,
    ].join();
    if (next !== shape) {
      shape = next;
      const at_s = Math.round((Date.now() - start) / 1000);
      log.push({
        at_s,
        stop: busy,
        reply_length: now.length,
        thinking_length: th.length,
        replies_shown: shown,
        view_width: innerWidth,
        view_height: innerHeight,
        hidden: document.hidden,
      });
    }
    if (busy || th !== thinking || now !== text) active = Date.now();
    if (th !== thinking || now !== text) changed = Date.now();
    if (busy && now && now === text && Date.now() - changed > stuck) break;
    // Thinking can keep growing after the reply starts (or show up at the same moment): it goes
    // to the app whenever it changes, not only before the reply.
    const thought = th !== thinking;
    thinking = th;
    if (thought && now === text)
      progress({
        progress: now ? `writing… ${now.length} chars` : `thinking… ${th.length} chars`,
        thinking: th,
        ...(now && { reply: now }),
      });
    if (now && now === text && !busy && !thought) {
      if (Date.now() - stable > settle)
        return { reply: text, thinking, diagnostics: diagnostics() };
    } else {
      if (now !== text)
        progress({
          progress: `writing… ${now.length} chars`,
          thinking,
          reply: now,
        });
      text = now;
      stable = Date.now();
    }
  }
  if (text) return { reply: text, thinking, diagnostics: diagnostics() };
  const minutes = total && Date.now() - start >= total ? total / 60000 : idle / 60000;
  const why =
    total && Date.now() - start >= total
      ? `No finished reply after ${minutes} min (your limit in Settings)`
      : `No activity on the page for ${minutes} min (your limit in Settings, or check the provider's reply selectors)`;
  throw Object.assign(fail("deadline_exceeded", why), { diagnostics: diagnostics() });
};

// ---------- sending ----------

// Type the way a keyboard does (the events React and Vue listen to), else the native setter.
const text_write = (el, text) => {
  el.focus();
  if (el.isContentEditable) {
    document.execCommand("selectAll", false, null);
    document.execCommand("insertText", false, text);
    return;
  }
  el.select();
  if (document.execCommand("insertText", false, text) && el.value === text) return;
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, text);
  el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
};

const enabled = (b) => b && !b.disabled && b.getAttribute("aria-disabled") !== "true";

// No Send matched: the last button after the box in its own area is almost always Send (a
// disabled one means wait, never press a toggle).
const send_near = (box) => {
  for (let area = box.parentElement, up = 0; area && up < 6; area = area.parentElement, up += 1) {
    const after = [...area.querySelectorAll("button, [role=button]")].filter(
      (b) =>
        visible(b) &&
        !b.contains(box) &&
        box.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
    if (after.length) return enabled(after[after.length - 1]) ? after[after.length - 1] : null;
  }
  return null;
};

const site_send = async ({ text, limits }, provider) => {
  const box = await wait_for(() => element_find(selectors_get(provider, "input")), 15000);
  if (!box) {
    const hint = logged_out() ? "; it shows a Log in button" : "";
    throw fail(
      "failed_precondition",
      `The chat box wasn't found on the page after 15 s (open the site to look${hint})`,
    );
  }
  const before = snapshot_take(provider);
  const first_error = error_find(provider, null);
  if (first_error && !first_error.el) throw fail("failed_precondition", first_error.text);
  const old = new Set(first_error ? [first_error.el] : []);
  const users_before = all_find(selectors_get(provider, "user").join(",") || "x-none").length;
  text_write(box, text);
  const button =
    (await wait_for(
      () =>
        enabled(element_find(selectors_get(provider, "send")))
          ? element_find(selectors_get(provider, "send"))
          : null,
      1500,
    )) || (await wait_for(() => send_near(box), 2500));
  const box_text = () => (box.isContentEditable ? box.innerText : box.value || "").trim();
  const press = () => {
    if (button) return button.click();
    for (const type of ["keydown", "keypress", "keyup"]) {
      box.dispatchEvent(
        new KeyboardEvent(type, {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
          bubbles: true,
        }),
      );
    }
  };
  const url = location.href;
  // Sent: a new reply or a new message of yours, the box gone or empty, a new address, or Stop.
  const went = () => {
    const error = error_find(provider, old);
    if (error) throw fail("permission_denied", error.text);
    const grew = Object.entries(snapshot_take(provider)).some(
      ([s, now]) => now.count > (before[s] || { count: 0 }).count,
    );
    const users =
      all_find(selectors_get(provider, "user").join(",") || "x-none").length > users_before;
    return (
      grew ||
      users ||
      !box.isConnected ||
      location.href !== url ||
      !box_text() ||
      !!element_find(selectors_get(provider, "stop"))
    );
  };
  press();
  if (!(await wait_for(() => went() || null, 5000))) {
    if (box.isConnected && box_text()) press();
    if (!(await wait_for(() => went() || null, 10000))) {
      throw fail(
        "not_found",
        "Couldn't tell whether the site sent it. If it's answering, tap Check; if not, copy the page report",
      );
    }
  }
  const result = await reply_read(provider, before, limits, old);
  await PP.pause(300); // the address of a new site chat
  const el = reply_last(provider);
  return {
    ...result,
    reply: reply_format(provider, el) || result.reply,
    url: location.href,
    model: text_get(element_find(selectors_get(provider, "model"))),
  };
};

// ---------- the other stages ----------

const thinking_near = (provider, el) => {
  for (let area = el, up = 0; area && up < 3; area = area.parentElement, up += 1) {
    for (const s of selectors_get(provider, "thinking")) {
      const found = [...area.querySelectorAll(s)].filter((n) => !n.contains(el) && text_get(n));
      if (found.length) return found[found.length - 1];
    }
  }
  return null;
};

// The newest reply (waiting until it's finished if asked), or every turn in page order.
const site_read = async ({ which, wait, limits }, provider) => {
  if (which === "all") {
    const users = all_find(selectors_get(provider, "user").join(",") || "x-none").filter((e) =>
      text_get(e),
    );
    const replies = selectors_get(provider, "reply")
      .flatMap(all_find)
      .filter((e) => text_get(e) && !users.some((u) => u.contains(e) || e.contains(u)));
    if (!users.length && !replies.length)
      throw fail("not_found", "No messages found on the page (copy the page report)");
    const marks = [
      ...users.map((el) => ({ el, you: true })),
      ...replies.map((el) => ({ el, you: false })),
    ];
    marks.sort((a, b) =>
      a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
    );
    const turns = [];
    for (const m of marks) {
      if (m.you) turns.push({ message: text_get(m.el), reply: "", thinking: "" });
      else {
        if (!turns.length || turns[turns.length - 1].reply)
          turns.push({ message: "", reply: "", thinking: "" });
        Object.assign(turns[turns.length - 1], {
          reply: reply_format(provider, m.el),
          thinking: thinking_format(provider, thinking_near(provider, m.el)),
        });
      }
    }
    return turns;
  }
  if (wait) await reply_read(provider, {}, limits);
  const el = reply_last(provider);
  const users = all_find(selectors_get(provider, "user").join(",") || "x-none");
  return [
    {
      message: text_get(users[users.length - 1]),
      reply: reply_format(provider, el),
      thinking: el ? thinking_format(provider, thinking_near(provider, el)) : "",
    },
  ];
};

const items_find = (provider) => {
  const seen = new Set();
  for (const s of (provider.model_picker || {}).items || []) {
    const items = all_find(s)
      .filter(visible)
      .map((el) => ({ name: text_get(el).split("\n")[0].trim(), el }))
      .filter((i) => i.name && !seen.has(i.name) && seen.add(i.name));
    if (items.length) return items;
  }
  return [];
};

const picker_close = async (provider) => {
  for (const t of [document.activeElement, document.body])
    t &&
      t.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }),
      );
  await PP.pause(300);
  const item = items_find(provider)[0];
  const dialog = item && item.el.closest("[role=dialog], .ant-drawer, [class*=popup i]");
  const close =
    dialog &&
    [...dialog.querySelectorAll("[aria-label=Close i], .ant-drawer-close, [class*=close i]")].find(
      visible,
    );
  if (close) close.click();
  await PP.pause(300);
};

const picker_open = async (provider) => {
  const button = await wait_for(() => element_find((provider.model_picker || {}).open || []), 5000);
  if (!button)
    throw fail(
      "not_found",
      "The model picker wasn't found on the page (check the provider's model picker selectors)",
    );
  button.click();
  await wait_for(() => items_find(provider).length || null, 2000);
};

const option_find = (option) => {
  const want = (option.text || "").toLowerCase();
  const label = (el) =>
    [text_get(el), el.getAttribute("aria-label"), el.getAttribute("title")].join(" ").toLowerCase();
  const ok = (el) => visible(el) && (!want || label(el).includes(want));
  return all_find(option.selector || "button, [role=button]").find(ok) || null;
};

const option_on = (el) =>
  !!el &&
  (el.getAttribute("aria-pressed") === "true" ||
    el.getAttribute("aria-checked") === "true" ||
    /(^|[\s_-])(active|selected|checked|on)([\s_-]|$)/i.test(
      String(el.className.baseVal ?? el.className),
    ));

const options_get = (provider) =>
  (provider.options || []).map((o) => ({
    name: o.name,
    found: !!option_find(o),
    on: option_on(option_find(o)),
  }));

// The model list and the options' states; "Choose on the site" when the list can't be read.
const site_model_list = async (data, provider) => {
  const model = text_get(element_find(selectors_get(provider, "model")));
  if (!provider.model_picker) return { models: [], model, options: options_get(provider) };
  await picker_open(provider);
  const models = items_find(provider).map((i) => i.name);
  await picker_close(provider);
  return { models, model, options: options_get(provider) };
};

const site_model_set = async ({ model, options = {} }, provider) => {
  const shown = text_get(element_find(selectors_get(provider, "model")));
  if (model && provider.model_picker && !shown.toLowerCase().includes(model.toLowerCase())) {
    await picker_open(provider);
    const want = model.toLowerCase();
    const items = items_find(provider);
    const item =
      items.find((i) => i.name.toLowerCase() === want) ||
      items.find((i) => i.name.toLowerCase().includes(want));
    if (!item) {
      await picker_close(provider);
      throw fail("not_found", `The model "${model}" isn't in the site's list`);
    }
    item.el.click();
    await PP.pause(600);
    if (items_find(provider).length) await picker_close(provider);
  }
  for (const [name, on] of Object.entries(options)) {
    const option = (provider.options || []).find((o) => o.name === name);
    const el = option && option_find(option);
    if (el && option_on(el) !== !!on) el.click();
  }
  return {
    model: text_get(element_find(selectors_get(provider, "model"))),
    options: options_get(provider),
  };
};

// The site's own chats from its links: each address once, its first line.
const site_chat_list = (data, provider) => {
  const seen = new Set();
  return all_find(selectors_get(provider, "chat_links").join(",") || "x-none")
    .filter((a) => a.href && !seen.has(a.href) && seen.add(a.href))
    .map((a) => ({ url: a.href, name: text_get(a).split("\n")[0].slice(0, 120) || a.href }));
};

// An outline of the page around the newest reply, the chat box and open panels: tags, classes and
// a few attributes, at most 50 characters of text each (UC46).
const site_report_build = (data, provider) => {
  if (PP.stages.report_build) return PP.stages.report_build(provider);
  const lines = [];
  const walk = (el, depth) => {
    if (lines.length > 700 || depth > 14) return;
    const cls =
      typeof el.className === "string" && el.className.trim()
        ? "." + el.className.trim().split(/\s+/).join(".")
        : "";
    const attrs = ["id", "role", "aria-label", "aria-expanded", "data-testid"]
      .filter((a) => el.getAttribute(a))
      .map((a) => `[${a}=${el.getAttribute(a)}]`)
      .join("");
    const own = [...el.childNodes]
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent.trim())
      .join(" ")
      .slice(0, 50);
    lines.push(
      "  ".repeat(depth) + el.tagName.toLowerCase() + cls + attrs + (own ? `  "${own}"` : ""),
    );
    for (const c of el.children)
      if (!/^(svg|script|style|path)$/i.test(c.tagName)) walk(c, depth + 1);
  };
  const around = (el, up) => {
    for (let i = 0; i < up && el.parentElement && el.parentElement !== document.body; i += 1)
      el = el.parentElement;
    return el;
  };
  const reply = reply_last(provider);
  lines.push("== around the newest reply ==");
  walk(around(reply || document.body, 4), 0);
  // While a reply is on its way the newest reply found may be the one before; what follows your
  // newest message is where the new thinking and reply are.
  const yours = all_find(selectors_get(provider, "user").join(",") || "x-none").pop();
  if (yours) {
    lines.push("", "== around your newest message (a reply on its way is here) ==");
    walk(around(yours, 5), 0);
  }
  const box = element_find(selectors_get(provider, "input"));
  lines.push(
    "",
    box
      ? "== around the message box =="
      : "== message box: not found with the provider's input selectors ==",
  );
  if (box) walk(around(box, 5), 0);
  const panels = all_find(
    "[role=dialog], [class*='drawer' i], [class*='panel' i], [class*='modal' i], [class*='think' i]",
  ).filter((el) => visible(el) && text_get(el).length > 20);
  if (panels.length) lines.push("", "== open panels and thinking elsewhere ==");
  panels
    .filter((el) => !panels.some((o) => o !== el && o.contains(el)))
    .slice(0, 4)
    .forEach((el) => walk(el, 0));
  return { url: location.href, report: lines.join("\n") };
};

// Whether the chat box shows (logged in, or a guest the site lets in): the welcome guide's sign.
const ready_get = (provider) => !!element_find(selectors_get(provider, "input"));

return {
  site_send,
  site_read,
  site_model_list,
  site_model_set,
  site_chat_list,
  site_report_build,
  ready_get,
  reply_read,
  reply_format,
  thinking_format,
  markdown_get,
  text_write,
  element_find,
  visible,
  text_get,
};
