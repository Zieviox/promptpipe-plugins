// Qwen's quirks: refusals come as a toast, a dialog can sit on top of the chat, and the model list
// sometimes opens by itself. Its thinking card is never clicked: the default routine reads the
// thinking folded or not, and clicking made Qwen's panel full screen on a phone, without its close
// button (seen on the phone). Back in the site view closes a thinking panel open over the chat.
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

const site_send = async (data, def) => {
  await list_close();
  return PP.defaults.site_send(data, def);
};

// Back in the site view: the thinking panel, when one is open over the chat, closes first.
const site_back = async () => {
  const thought = [...document.querySelectorAll(provider.selectors.thinking.join(","))].find(shown);
  if (!thought || !thought.closest(OVERLAY)) return { closed: false };
  return { closed: await overlay_close() };
};

return { error_find, site_send, site_back };
