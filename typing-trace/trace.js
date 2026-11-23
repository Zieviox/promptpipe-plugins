"use strict";
// Typing trace: while Record is on, what happens around the message box (touches, focus,
// selection, keyboard input, the keyboard opening and closing) goes into one log entry, written
// two seconds after the last event. Off, the listeners return at once.

const ID = "typing-trace";
const on = () => {
  const state = PP.state_get();
  return !!PP.plugin_setting_get(state, PP.chat_get(state), ID, "record");
};

let lines = [];
let started = 0;
let timer = 0;

// An element in a few words: tag, id, classes, label, and the text box's selection.
const name_get = (el) => {
  if (!el || !el.tagName) return el === document ? "document" : String(el && el.nodeName);
  const label = el.getAttribute("aria-label");
  return [
    el.tagName.toLowerCase(),
    el.id ? `#${el.id}` : "",
    el.classList && el.classList.length ? `.${[...el.classList].join(".")}` : "",
    label ? `[${label}]` : "",
  ].join("");
};
const box = () => document.getElementById("message");
const box_state = () => {
  const el = box();
  if (!el) return "no box";
  const focused = document.activeElement === el ? "focused" : `focus=${name_get(document.activeElement)}`;
  return `${focused} sel=${el.selectionStart}-${el.selectionEnd}${el.selectionDirection === "backward" ? "←" : ""} len=${el.value.length}`;
};
const near = (el) => !!(el && el.closest && el.closest(".composer, .editbar"));

const note = (text) => {
  if (!started) started = performance.now();
  lines.push(`${String(Math.round(performance.now() - started)).padStart(6)}ms ${text}`);
  clearTimeout(timer);
  timer = setTimeout(flush, 2000);
};
const flush = () => {
  if (!lines.length) return;
  PP.log_add("notice", `Typing trace: ${lines.length} events`, lines.join("\n"));
  lines = [];
  started = 0;
};

// Touch, pointer and mouse events: where (and whether something stopped the default).
const point = (e) => {
  if (!on() || !near(e.target)) return;
  const t = e.touches && e.touches[0] ? e.touches[0] : e.changedTouches && e.changedTouches[0];
  const at = t || e;
  const where = at && at.clientX !== undefined ? ` @${Math.round(at.clientX)},${Math.round(at.clientY)}` : "";
  // Read after the app's own handlers ran: was the default prevented (focus kept)?
  setTimeout(() => note(`${e.type} ${name_get(e.target)}${where}${e.defaultPrevented ? " prevented" : ""} | ${box_state()}`), 0);
};
["touchstart", "touchend", "touchcancel", "pointerdown", "pointerup", "pointercancel", "mousedown", "mouseup", "click", "dblclick", "contextmenu"].forEach((type) =>
  document.addEventListener(type, point, { capture: true, passive: true }),
);

// Focus anywhere, since losing it is what puts the keyboard down.
document.addEventListener(
  "focusin",
  (e) => on() && note(`focusin ${name_get(e.target)} from ${name_get(e.relatedTarget)}`),
  true,
);
document.addEventListener(
  "focusout",
  (e) => on() && note(`focusout ${name_get(e.target)} to ${name_get(e.relatedTarget)}`),
  true,
);

// The selection in the box, and what the keyboard does to the text.
let last_sel = "";
document.addEventListener("selectionchange", () => {
  if (!on() || document.activeElement !== box()) return;
  const now = box_state();
  if (now !== last_sel) ((last_sel = now), note(`selection | ${now}`));
});
["beforeinput", "input"].forEach((type) =>
  document.addEventListener(
    type,
    (e) =>
      on() &&
      e.target === box() &&
      note(`${type} ${e.inputType || ""}${e.data ? ` "${e.data.slice(0, 20)}"` : ""}${e.isComposing ? " composing" : ""} | ${box_state()}`),
    true,
  ),
);
["compositionstart", "compositionend", "keydown", "keyup"].forEach((type) =>
  document.addEventListener(
    type,
    (e) => on() && e.target === box() && note(`${type}${e.key ? ` ${e.key}` : ""}${e.data ? ` "${e.data.slice(0, 20)}"` : ""} | ${box_state()}`),
    true,
  ),
);

// The keyboard opening and closing shows as the screen's size changing.
let last_size = "";
const size = () => {
  if (!on()) return;
  const v = window.visualViewport;
  const now = `${innerWidth}x${innerHeight}${v ? ` visual ${Math.round(v.width)}x${Math.round(v.height)}+${Math.round(v.offsetTop)}` : ""}`;
  if (now !== last_size) ((last_size = now), note(`size ${now} | ${box_state()}`));
};
addEventListener("resize", size);
if (window.visualViewport) visualViewport.addEventListener("resize", size);
document.addEventListener("visibilitychange", () => on() && note(`visibility ${document.visibilityState}`));
