// Qwen's quirks: refusals come as a toast, a dialog can sit on top of the chat, the model list
// sometimes opens by itself, and the thinking is folded into a card whose text only appears once
// it's opened (kept open while a reply comes, so the thinking shows live).
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

const CARDS = ".qwen-chat-thinking-status-card-title-text, .qwen-chat-thinking-status-card-title";

// The newest thinking, read from its card: opened first (and folded again) only when it's closed.
// (Only thinking after the newest card counts: an older reply's may be open further up.)
const card_newest = () => [...document.querySelectorAll(CARDS)].filter(shown).pop() || null;
const thinking_visible = (card = card_newest()) =>
  [...document.querySelectorAll(provider.selectors.thinking.join(","))].filter(
    (el) =>
      shown(el) && (!card || card.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING),
  );
const thinking_open = async () => {
  const read = () => {
    const found = thinking_visible();
    return found.length ? PP.stages.thinking_format(provider, found[found.length - 1]) : "";
  };
  if (thinking_visible().length) return read();
  const card = card_newest();
  if (!card) return "";
  card.click();
  await PP.pause(500);
  const text = read();
  card.click();
  return text;
};

// While a reply comes, the newest card is kept open so its thinking is on the page and can be
// read as it grows (opened once: a second click would fold it again).
// On a phone-sized page Qwen shows the open thinking as a panel over the whole chat, and a second
// click on the card doesn't reach it. So the panel is closed the way panels close: the close button
// of the overlay holding the thinking, else Escape; then checked.
const OVERLAY =
  "[role=dialog], [class*='drawer' i], [class*='modal' i], [class*='popup' i], [class*='sheet' i], [class*='mask' i]";
const CLOSE = /close|关闭|back|返回|done/i;
const overlay_close = async () => {
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
    else
      for (const target of [document.activeElement || document.body, document])
        target.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            code: "Escape",
            keyCode: 27,
            bubbles: true,
          }),
        );
    await PP.pause(400);
  }
  return false;
};

// One this opened is folded again once the reply is read (or its panel closed), so the site view
// shows the chat.
const thinking_keep_open = () => {
  let seen = null;
  let clicked = null;
  const timer = setInterval(() => {
    const card = card_newest();
    if (!card || card === seen) return;
    if (!thinking_visible(card).length) (card.click(), (clicked = card));
    seen = card;
  }, 400);
  return async () => {
    clearInterval(timer);
    if (!clicked) return;
    const thought = [...document.querySelectorAll(provider.selectors.thinking.join(","))].find(
      shown,
    );
    if (thought && thought.closest(OVERLAY)) return overlay_close();
    if (clicked.isConnected && thinking_visible(clicked).length) clicked.click();
  };
};

const site_send = async (data, def) => {
  await list_close();
  const stop = thinking_keep_open();
  try {
    const result = await PP.defaults.site_send(data, def);
    return result.thinking ? result : { ...result, thinking: await thinking_open() };
  } finally {
    await stop();
  }
};

// The site view opening: a thinking panel left over the chat is closed first.
const site_view_prepare = () => overlay_close().then((closed) => ({ closed }));

return { error_find, site_send, site_view_prepare };
