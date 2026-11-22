"use strict";
// The screen's root: draws the State on every change (one frame at most), the theme and scale,
// staying at the bottom while a reply comes in and "↓ 1 new" when you've scrolled up, the keys
// and Back (Escape closes what's on top first), what other apps share in, help mode and the
// guides.

const { html } = PP;

const UI_NEW = {
  sheets: [],
  drawer: false,
  menu: false,
  site_view: { open: false, page: null },
  selection: { on: false, ids: [] },
  query: "",
  find_results: [],
  help: false,
  help_card: null,
  tour: null,
  composer: { big: false },
  unfolded: [],
  loads: {},
  unseen: {},
  toasts: [],
  dialog: null,
  chat: null,
  folder: "",
  folders_open: [],
};
PP.state_set((s) => ({ ...s, ui: { ...UI_NEW, ...(s.ui || {}) } }));

// ---------- guides (UC40) ----------
// Each stage lights up one part of the screen and says what it does.

const GUIDES = [
  {
    id: "welcome",
    title: "Welcome",
    stages: [
      [
        "[aria-label='Switch provider']",
        "This is the AI you talk to. Tap it to pick a provider, and open its site once to log in.",
      ],
      [
        "#message",
        "Type here and send. Your chats are saved as files in your chats folder, with their history.",
      ],
      [
        "[aria-label='Chats']",
        "Your chats and folders. Press and hold to select; drag the grips to reorder.",
      ],
      ["[aria-label='Find chats and functions']", "Find any chat, message or function by name."],
    ],
  },
  {
    id: "profiles",
    title: "Profiles and blocks",
    stages: [
      [
        "[aria-label='Quick edit and add']",
        "Quick edit: turn the profile's blocks on or off for this chat, and add files.",
      ],
      ["[aria-label='Chat title']", "The chat's sheet: tags, folder, export and its history."],
    ],
  },
  {
    id: "site",
    title: "The AI page",
    stages: [
      [
        "[aria-label='Switch provider']",
        "Open its site to see the page the app writes to; replies come back here.",
      ],
    ],
  },
];

const tour_start = (id) => PP.ui_set(() => ({ tour: { id, at: 0 }, sheets: [], drawer: false }));

const tour_render = (state) => {
  const guide = GUIDES.find((g) => g.id === state.ui.tour.id);
  const [, text] = guide.stages[state.ui.tour.at];
  const last = state.ui.tour.at === guide.stages.length - 1;
  const done = () => {
    PP.ui_set(() => ({ tour: null }));
    PP.apply_try((s) =>
      PP.record_set(s, {
        collection: "settings",
        fields: {
          "help.seen": [...new Set([...(PP.setting_get(s, "help.seen") || []), guide.id])],
        },
      }),
    );
  };
  const next = () => PP.ui_set((ui) => ({ tour: { ...ui.tour, at: ui.tour.at + 1 } }));
  return html`<div
    class="help-bar"
    style="position:fixed;left:10px;right:10px;bottom:90px;z-index:35"
    role="dialog"
    aria-label=${guide.title}
  >
    <span class="grow" style="flex:1">${text}</span
    ><button class="pill" onClick=${done}>${last ? "Done" : "Skip"}</button> ${
      last ? null : html`<button class="pill on" onClick=${next}>Next</button>`
    }
  </div>`;
};

// ---------- help mode (UC39) ----------
// While it's on, a tap anywhere says what that thing does instead of doing it.

const help_explain = (target) => {
  const el = target.closest("[aria-label],[title]");
  if (!el || el.closest(".help-bar")) return;
  const name = el.getAttribute("aria-label") || el.getAttribute("title");
  const command = [...PP.COMMANDS, ...(PP.plugin_commands || [])].find(
    (c) => c.label.toLowerCase() === name.toLowerCase(),
  );
  const text = command
    ? `${command.place}${command.key ? ` · ${command.key}` : ""}`
    : "Tap it to use it once help mode is off.";
  PP.ui_set(() => ({ help_card: { title: name, text } }));
  return true;
};

addEventListener(
  "click",
  (e) => {
    const ui = PP.ui_get();
    if (ui && ui.help && help_explain(e.target)) e.preventDefault(), e.stopPropagation();
  },
  true,
);

// ---------- keys and Back ----------

const key_name = (e) => {
  const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  const shift = e.shiftKey && (/^[A-Z]$/.test(key) || key.length > 1);
  return [e.ctrlKey || e.metaKey ? "Ctrl" : "", e.altKey ? "Alt" : "", shift ? "Shift" : "", key]
    .filter(Boolean)
    .join("+");
};

// Escape and Back close what's on top, in this order; nothing open: not handled (the app goes to
// the background).
const back_run = () => {
  const ui = PP.ui_get();
  const close = (change) => (PP.ui_set(() => change), true);
  if (ui.dialog) return close({ dialog: null });
  if (ui.help_card) return close({ help_card: null });
  if (ui.help) return close({ help: false });
  if (ui.tour) return close({ tour: null });
  if (ui.menu) return close({ menu: false });
  if (ui.sheets.length) return PP.sheet_close(), true;
  if (ui.selection.on) return close({ selection: { on: false, ids: [] } });
  if (ui.drawer) return close({ drawer: false });
  if (ui.site_view.open) return PP.command_run("site_view"), true;
  if (ui.composer.big) return close({ composer: { big: false } });
  return false;
};

addEventListener("keydown", (e) => {
  if (e.key === "Escape") return back_run() && e.preventDefault();
  if (e.key === "F3") return e.preventDefault(), PP.command_run("find");
  const name = key_name(e);
  if (["ArrowUp", "Enter"].includes(name)) return; // the message box's own keys
  const command = [...PP.COMMANDS, ...(PP.plugin_commands || [])].find((c) => c.key === name);
  if (command) e.preventDefault(), PP.command_run(command.id);
});

// ---------- what comes in ----------

// Shared text goes into the open chat's box; shared files are attached (UC14, UC48).
const share_received = (data) => {
  const state = PP.state_get();
  if (data.text)
    PP.draft_set(
      `${PP.draft_get(state).text}${PP.draft_get(state).text ? "\n\n" : ""}${data.text}`,
    );
  if (data.files && data.files.length)
    PP.call_try("attachment_add", { chat: state.ui.chat || "new", files: data.files });
};

// A finished reply in a chat you aren't reading, or while you've scrolled up, is marked new.
const reply_changed = (data) => {
  if (data.status !== "finished") return;
  const send = PP.state_get().sends.find((s) => s.page === data.page && s.chat);
  if (!send) return;
  setTimeout(() => {
    const state = PP.state_get();
    const turns = state.turns.filter((t) => t.chat === send.chat);
    const last = turns[turns.length - 1];
    if (!last || (send.chat === state.ui.chat && at_bottom)) return;
    PP.ui_set((ui) => ({ unseen: { ...ui.unseen, [send.chat]: last.id } }));
    // A reply in a chat you aren't reading: a tappable toast (it never moves your view).
    const chat = state.chats.find((c) => c.id === send.chat);
    if (send.chat !== state.ui.chat && chat) PP.toast(`Reply ready: ${chat.name}`, false, chat.id);
  }, 300);
};

// ---------- drawing ----------

let at_bottom = true;
addEventListener(
  "scroll",
  (e) => {
    if (e.target.id !== "chat") return;
    at_bottom = e.target.scrollHeight - e.target.scrollTop - e.target.clientHeight < 40;
    if (PP.ui_get().scrolled_up === at_bottom) PP.ui_set(() => ({ scrolled_up: !at_bottom }));
  },
  true,
);

const dialog_render = (state) => {
  const d = state.ui.dialog;
  const run = (choice) => {
    const value = document.getElementById("dialog-value")?.value ?? "";
    PP.ui_set(() => ({ dialog: null }));
    PP.command_run(d.command, { ...(d.data || {}), value, choice });
  };
  return html`<div class="layer dialog">
    <div class="scrim" onClick=${() => PP.ui_set(() => ({ dialog: null }))}></div>
    <section class="sheet" role="dialog" aria-label=${d.title}>
      <h2>${d.title}</h2>
      ${
        d.choices
          ? null
          : html`<input
            class="field"
            id="dialog-value"
            ref=${PP.focus_ref}
            value=${d.value}
            onKeyDown=${(e) => e.key === "Enter" && run()}
          />`
      }
      <div class="chips">
        <button class="pill" onClick=${() => PP.ui_set(() => ({ dialog: null }))}>Cancel</button>
        ${(d.choices || [[undefined, d.ok]]).map(
          ([choice, label]) =>
            html`<button class="pill on" key=${label} onClick=${() => run(choice)}>
              ${label}
            </button>`,
        )}
      </div>
    </section>
  </div>`;
};

const banners_render = (state) => [
  state.app.safe_mode
    ? html`<div class="banner" key="safe">
        Safe mode: only the app's own plugins.${state.app.failed ? ` ${state.app.failed}` : ""}
        <button class="pill" onClick=${() => PP.call_try("app_start", { mode: "normal" })}>
          Leave
        </button>
      </div>`
    : null,
  ...state.plugins
    .filter((p) => p.status === "failed")
    .map(
      (p) => html`<div class="banner" key=${p.id}>${p.manifest.name} didn't load: ${p.error}</div>`,
    ),
];

const screen_render = (state) => {
  const ui = state.ui;
  if (!state.config) return html`<p style="padding:24px">Starting…</p>`;
  const main = ui.site_view.open
    ? PP.site_bar_render(state)
    : html`${PP.header_render(state)}${
        ui.menu ? PP.provider_menu_render(state) : null
      }${PP.chat_render(state)}${PP.new_reply_render(state)}
      ${
        ui.help
          ? html`<div class="help-bar">
            <span style="flex:1"
              >${
                ui.help_card
                  ? html`<b>${ui.help_card.title}</b> · ${ui.help_card.text}`
                  : "Tap anything to learn what it does"
              }</span
            >
            <button
              class="pill"
              onClick=${() => PP.ui_set(() => ({ help: false, help_card: null }))}
            >
              Done
            </button>
          </div>`
          : null
      }
      ${PP.composer_render(state)}`;
  return html`${banners_render(state)}${main} ${ui.drawer ? PP.drawer_render(state) : null}
    ${ui.sheets.length ? PP.sheet_render(state) : null}
    ${state.changes.length ? PP.change_render(state) : null}
    ${ui.dialog ? dialog_render(state) : null} ${ui.tour ? tour_render(state) : null}
    <div class="toasts" aria-live="polite">
      ${ui.toasts.map((t) =>
        t.open
          ? html`<button class="toast tap" key=${t.id} onClick=${() => PP.chat_open(t.open)}>${t.text}</button>`
          : html`<div class=${`toast${t.error ? " error" : ""}`} key=${t.id}>${t.text}</div>`,
      )}
    </div>`;
};

// The theme: light or dark (or the system's), the accent, a theme plugin, the scale and text size;
// the system bars follow.
let bars = "";
const theme_set = (state) => {
  const root = document.documentElement;
  const mode = PP.setting_get(state, "look.mode");
  const dark =
    mode === "dark" || (mode === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  root.dataset.mode = dark ? "dark" : "light";
  root.dataset.accent = PP.setting_get(state, "look.accent");
  root.dataset.theme = PP.setting_get(state, "look.theme") || "";
  root.style.setProperty("--scale", PP.setting_get(state, "look.scale") / 100);
  root.style.setProperty("--reply-size", `${PP.setting_get(state, "look.text")}px`);
  const background = getComputedStyle(root).getPropertyValue("--bg").trim();
  if (`${background}${dark}` !== bars)
    (bars = `${background}${dark}`),
      PP.call_send("bars_set", { background, dark }).catch(() => null);
};

// After drawing: stay at the bottom, light up the guide's part, and keep the site view's place.
let view_open = false;
const after_draw = (state) => {
  const chat = document.getElementById("chat");
  // A chat just opened shows its newest message; then it follows only when you're at the bottom.
  if (chat && state.ui.bottom) {
    at_bottom = true;
    chat.scrollTop = chat.scrollHeight;
    PP.ui_set(() => ({ bottom: false, scrolled_up: false }));
  } else if (chat && at_bottom && PP.setting_get(state, "look.stay_at_bottom"))
    chat.scrollTop = chat.scrollHeight;
  document.querySelectorAll(".lit").forEach((el) => el.classList.remove("lit"));
  if (state.ui.tour)
    document
      .querySelector(GUIDES.find((g) => g.id === state.ui.tour.id).stages[state.ui.tour.at][0])
      ?.classList.add("lit");
  // A control Find pointed to: lit up and brought into view for a moment.
  if (state.ui.lit) {
    const el = [...document.querySelectorAll(".sheet [data-lit]")].find(
      (x) => x.dataset.lit === state.ui.lit,
    );
    if (el) {
      el.classList.add("hl");
      el.scrollIntoView({ block: "center" });
      setTimeout(() => el.classList.remove("hl"), 2600);
    }
    PP.ui_set(() => ({ lit: null }));
  }
  if (state.ui.site_view.open !== view_open) {
    view_open = state.ui.site_view.open;
    PP.call_send(
      "view_set",
      view_open ? { page: state.ui.site_view.page, region: PP.region_get() } : { page: null },
    ).catch(() => null);
  }
};

let frame = 0;
let first = true;
const redraw = () => {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    const state = PP.state_get();
    const root = document.getElementById("app");
    if (first) (first = false), (root.textContent = "");
    if (!state.config) return preact.render(screen_render(state), root);
    theme_set(state);
    preact.render(screen_render(state), root);
    after_draw(state);
    if (
      !(PP.setting_get(state, "help.seen") || []).includes("welcome") &&
      !state.ui.tour &&
      !state.chats.length
    )
      tour_start("welcome");
  });
};
PP.redraw_set(redraw);

PP.plugin_set({
  functions: { GUIDES, tour_start, screen_render },
  calls: {
    back_pressed: (data) => ({
      handled: data && data.key === "Alt+S" ? (PP.command_run("site_view"), true) : back_run(),
    }),
  },
  events: { share_received, reply_changed },
});
