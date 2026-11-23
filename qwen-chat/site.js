// Qwen's quirks: refusals come as a toast, a dialog can sit on top of the chat, and the model list
// sometimes opens by itself. Its thinking lives in a drawer that the card in the reply opens (in
// the reply itself only the current step's title shows). While you aren't looking at the site,
// the drawer is kept open so the thinking can be read as it's written; the moment the site view
// shows the page (site_shown), a drawer this opened is closed with its Close button first, and it's
// never opened while you look (Gtex chose this, 2026-11-23). Only the card in the reply is ever
// tapped: tapping the step cards inside the drawer made it full screen on a phone.
const shown = (el) => PP.stages.visible(el);
const text_get = (el) => PP.stages.text_get(el).replace(/\s+/g, " ");
const REFUSAL = /permission|denied|limit|too many|try again|error|failed|log ?in/i;

const error_find = () => {
  for (const el of document.querySelectorAll(".qwen-chat-v2-toast-container, [role=alert]")) {
    const text = shown(el) && text_get(el);
    if (text && REFUSAL.test(text)) return { el, text: `Qwen said: "${text.slice(0, 200)}"` };
  }
  return null;
};

// The model list Qwen opened by itself, closed before typing.
const list_close = async () => {
  if (!shown(document.querySelector("[class*='mms'] [role=option], [class*='mms-item']"))) return;
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await PP.pause(300);
};

// A thinking panel over the chat is closed the way panels close: the close button of the overlay
// holding the thinking, else Escape, else the page's back step (a phone panel); then checked.
const OVERLAY =
  "[role=dialog], [class*='drawer' i], [class*='modal' i], [class*='popup' i], [class*='sheet' i], [class*='mask' i]";
const CLOSE = /close|关闭|back|返回|done/i;
const overlay_close = async () => {
  const escape = () =>
    [document.activeElement || document.body, document].forEach((target) =>
      target.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }),
      ),
    );
  for (let i = 0; i < 3; i += 1) {
    const thought = [...document.querySelectorAll(provider.selectors.thinking.join(","))].find(
      shown,
    );
    const overlay = thought && thought.closest(OVERLAY);
    if (!overlay) return true;
    const button = [...overlay.querySelectorAll("button, [role=button], [class*='close' i]")].find(
      (b) =>
        shown(b) &&
        CLOSE.test(
          [b.getAttribute("aria-label"), b.getAttribute("title"), b.className, b.textContent].join(
            " ",
          ),
        ),
    );
    if (button) button.click();
    else if (i === 0) escape();
    else history.back(); // a phone panel that closes with the back gesture
    await PP.pause(400);
  }
  return false;
};

// The thinking drawer: open (holding the thinking), opened from the reply's own card, closed with
// its Close button. `opened` remembers that this plugin opened it.
const DRAWER_THINKING = ".qwen-chat-thinking-and-sources-content-thinking-container";
let opened = false;
const drawer_get = () =>
  [...document.querySelectorAll(".ant-drawer-open")].find((d) =>
    d.querySelector(DRAWER_THINKING),
  ) || null;
const drawer_open = () => {
  const card = [
    ...document.querySelectorAll(".chat-response-message .qwen-chat-thinking-status-card-title"),
  ]
    .filter((c) => shown(c) && !c.closest(".ant-drawer"))
    .pop();
  if (!card) return false;
  card.click();
  opened = true;
  return true;
};
const drawer_close = async () => {
  const drawer = drawer_get();
  if (!drawer) return true;
  const button = drawer.querySelector(
    "button.ant-drawer-close, .qwen-chat-thinking-and-sources-header-close",
  );
  if (button) button.click();
  await PP.pause(350);
  return !drawer_get();
};

// While a reply comes and you aren't looking: the drawer kept open (opened again if Qwen closes
// it); when the reply is in, one this opened is closed.
const drawer_keep = () => {
  const timer = setInterval(() => {
    if (!PP.view_shown() && !drawer_get()) drawer_open();
  }, 600);
  return async () => {
    clearInterval(timer);
    if (opened) (await drawer_close(), (opened = false));
  };
};

// The whole thinking at the end, from the drawer (opened for it only while you aren't looking).
const thinking_full = async () => {
  if (!drawer_get() && (PP.view_shown() || !drawer_open())) return "";
  await PP.pause(500);
  const box = [...document.querySelectorAll(DRAWER_THINKING)].pop();
  return box ? PP.stages.thinking_format(provider, box) : "";
};

const site_send = async (data, def) => {
  await list_close();
  const stop = drawer_keep();
  try {
    const result = await PP.defaults.site_send(data, def);
    const full = await thinking_full();
    // Without the drawer the thinking is only the step title ("Thinking completed"): not kept.
    const thinking =
      full ||
      (/^thinking completed$/i.test(String(result.thinking || "").trim()) ? "" : result.thinking);
    return { ...result, thinking };
  } finally {
    await stop();
  }
};

// The site view shows or hides this page: shown, a drawer this opened is closed first.
const site_shown = async ({ shown: on }) => {
  if (on && opened) (await drawer_close(), (opened = false));
  return {};
};

// Back in the site view: an open thinking drawer (or another thinking panel) closes first.
const site_back = async () => {
  if (drawer_get()) return { closed: (await drawer_close()) && !(opened = false) };
  const thought = [...document.querySelectorAll(provider.selectors.thinking.join(","))].find(shown);
  if (!thought || !thought.closest(OVERLAY)) return { closed: false };
  return { closed: await overlay_close() };
};

return { error_find, site_send, site_shown, site_back };
