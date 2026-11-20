// DeepSeek 2.0.0: the new plugin format (tags, provider, options, contentScript).
// 1.2.0: sending and waiting stay the app's own; this script only tells the app when
// DeepSeek refused the message, so the wait ends with DeepSeek's words instead of running for ever.
// Needs an app whose page script asks content scripts for error() (built after 2026-11-16); older
// apps ignore it and wait as before.
//
// From a page report of 2026-11-16: a refused message ("Content too long. Shorten and try
// again.", in the page's language) shows as a line next to your message in the chat list, not
// as a reply. With no reply under it, the newest item never gets its action row, so the
// "still writing" signal stays on.

const shown = (el) => {
  if (!el || !el.getClientRects().length) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== "hidden" && Number(cs.opacity) > 0;
};

// Text of an element without its buttons (a hover row of icons under your message has none).
const ownText = (el) => {
  const c = el.cloneNode(true);
  c.querySelectorAll("button, [role=button], .ds-button, svg").forEach((x) => x.remove());
  return (c.textContent || "").replace(/\s+/g, " ").trim();
};

return {
  error() {
    // Cloudflare's human check ("One more step before you proceed...") over the page.
    for (const id of ["cf-overlay", "cf-turnstile"]) {
      if (shown(document.getElementById(id))) {
        return "DeepSeek wants to check that you're human. Tap the site name, finish the check on the page, then Retry.";
      }
    }
    // The newest item in the chat list: a reply (or its thinking) means no refusal.
    const items = document.querySelectorAll(".ds-virtual-list-visible-items > div");
    const last = items[items.length - 1];
    if (!last || last.querySelector(".ds-assistant-message-main-content, .ds-think-content")) return null;
    // Your message is the item's .ds-message; text beside it is DeepSeek's refusal.
    for (const c of last.children) {
      if (c.classList.contains("ds-message") || !shown(c)) continue;
      const t = ownText(c);
      if (t) return { el: c, text: `DeepSeek refused the message: "${t.slice(0, 200)}"` };
    }
    return null;
  },
};
