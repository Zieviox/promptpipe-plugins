// Qwen's quirks: refusals come as a toast, a dialog can sit on top of the chat, the model list
// sometimes opens by itself, and the thinking is folded into a card whose text only appears once
// it's opened.
const shown = (el) => !!el && el.getClientRects().length > 0;
const text_get = (el) => (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
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

// The newest thinking card opened, read and closed again.
const thinking_open = async () => {
  const cards = [...document.querySelectorAll(CARDS)].filter(shown);
  const card = cards[cards.length - 1];
  if (!card) return "";
  card.click();
  await PP.pause(500);
  const found = [...document.querySelectorAll(provider.selectors.thinking.join(","))].filter(shown);
  const text = found.length ? text_get(found[found.length - 1]) : "";
  card.click();
  return text;
};

const site_send = async (data, def) => {
  await list_close();
  const result = await PP.defaults.site_send(data, def);
  return result.thinking ? result : { ...result, thinking: await thinking_open() };
};

return { error_find, site_send };
