// DeepSeek's quirks: a refused message shows as a line beside your message instead of a reply,
// and Cloudflare's human check covers the page. Both end the wait with what the page says.
const shown = (el) => {
  if (!el || !el.getClientRects().length) return false;
  const style = getComputedStyle(el);
  return style.visibility !== "hidden" && Number(style.opacity) > 0;
};

const text_get = (el) => {
  const copy = el.cloneNode(true);
  copy.querySelectorAll("button, [role=button], svg").forEach((x) => x.remove());
  return (copy.textContent || "").replace(/\s+/g, " ").trim();
};

const error_find = () => {
  if (["cf-overlay", "cf-turnstile"].some((id) => shown(document.getElementById(id))))
    return "DeepSeek wants to check that you're human: open the site, finish the check, then Retry.";
  const items = document.querySelectorAll(".ds-virtual-list-visible-items > div");
  const last = items[items.length - 1];
  if (!last || last.querySelector(".ds-assistant-message-main-content, .ds-think-content"))
    return null;
  for (const el of last.children) {
    const text = !el.classList.contains("ds-message") && shown(el) && text_get(el);
    if (text) return { el, text: `DeepSeek refused the message: "${text.slice(0, 200)}"` };
  }
  return null;
};

return { error_find };
