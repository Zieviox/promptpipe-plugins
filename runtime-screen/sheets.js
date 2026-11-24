"use strict";
// The sheets, drawn from the schemas where they can be (strategy 1): Settings and its sections,
// the chat sheet, moving chats, model and options, Quick edit, profiles and their blocks, the
// prompt library, plugins, credentials, the storage check, history, help, and the outside-change
// dialog (D7). Each is a function from the State to its rows.

const { html, item_render: item, switch_render: toggle } = PP;
const set = (fields) => PP.apply_try((s) => PP.record_set(s, { collection: "settings", fields }));
const label = (text) => html`<div class="label">${text}</div>`;

// What a sheet reads when it opens (the page's models, the history, the log): loaded once into
// ui.loads under a key starting with the sheet's name (opening the sheet again reads it again);
// undefined while it's on its way. `loading` only stops a second read starting meanwhile.
const loading = new Set();
// The types of log entry that count as errors (marked, and a dot on Settings while unseen).
const LOG_ERRORS = ["error", "send", "site", "history"];

const load_get = (state, key, load) => {
  const loads = state.ui.loads || {};
  if (!(key in loads) && !loading.has(key)) {
    loading.add(key);
    Promise.resolve()
      .then(load)
      .catch((e) => ({ error: e.message }))
      .then((value) => {
        loading.delete(key);
        PP.ui_set((ui) => ({ loads: { ...(ui.loads || {}), [key]: value } }));
      });
  }
  return loads[key];
};
const load_clear = (key) =>
  PP.ui_set((ui) => ({
    loads: Object.fromEntries(Object.entries(ui.loads || {}).filter(([k]) => !k.startsWith(key))),
  }));

// One setting as a form row, by its type (toggle, choice, number, text).
const field_render = (state, def, value, on_set) => {
  if (def.type === "toggle")
    return item({
      key: def.key,
      label: def.label,
      sub: def.description,
      right: toggle(value, def.label, on_set),
      onClick: () => on_set(!value),
    });
  // Choices as the wireframe's segments (up to four) or chips; UI scale as its four choices.
  const scale_choices =
    def.key === "look.scale"
      ? [90, 100, 115, 130].map((v) => ({ value: v, label: `${v}%` }))
      : null;
  if (def.type === "choice" || scale_choices) {
    const choices = scale_choices || def.choices || choices_get(state, def.choices_from);
    const buttons = choices.map(
      (c) =>
        html`<button key=${String(c.value)} class=${c.value === value ? "on" : ""} onClick=${() => on_set(c.value)}>${c.label}</button>`,
    );
    const odd =
      scale_choices && !scale_choices.some((c) => c.value === value)
        ? html`<small>Now ${value}% (Ctrl+= and Ctrl+- change it 5% at a time)</small>`
        : null;
    return html`<div class="item col" key=${def.key} data-lit=${def.label}>
      <span class="grow">${def.label}${def.description ? html`<small>${def.description}</small>` : null}</span>
      ${choices.length <= 4 ? html`<div class="seg">${buttons}</div>` : html`<div class="chips choose">${buttons}</div>`}${odd}
    </div>`;
  }
  return html`<label class="item" key=${def.key} data-lit=${def.label}
    ><span class="grow"
      >${def.label}${def.description ? html`<small>${def.description}</small>` : null}</span
    >
    <input
      class="field"
      style="width:9em"
      type=${def.type === "number" ? "number" : "text"}
      value=${value ?? ""}
      onChange=${(e) => on_set(def.type === "number" ? Number(e.target.value) : e.target.value)}
  /></label>`;
};

const choices_get = (state, from) => {
  const tagged = (tag) =>
    state.plugins
      .filter((p) => (p.manifest.tags || []).includes(tag))
      .map((p) => ({ value: p.id, label: p.manifest.name }));
  if (from === "profiles")
    return state.config.profiles.map((p) => ({ value: p.id, label: p.name }));
  if (from === "providers") return tagged("provider");
  if (from === "themes") return [{ value: "", label: "None" }, ...tagged("theme")];
  if (from === "screens") return tagged("ui");
  return [];
};

// What a block is, for the line under its name.
const block_type_format = (b) =>
  b.type === "message" ? "Your text goes here" : b.type === "prompt" ? "System prompt" : "Plugin";

// A profile's blocks in order: drag or the arrows reorder the profile; the switch turns a block on
// or off, in the chat's own toggles (`chat`) or in the profile itself (no chat). `open` opens a
// block's own sheet when its name is tapped.
const block_rows = (state, profile, chat, open) => {
  const blocks = state.config.blocks.filter((b) => b.profile === profile.id);
  const move = (id, index) =>
    PP.apply_try((s) => PP.record_move(s, { collection: "blocks", id, index }));
  const flip = (b, v) =>
    chat
      ? PP.apply_try(
          (s) =>
            PP.record_set(s, {
              collection: "chats",
              id: chat.id,
              fields: { own: { toggles: { [b.id]: v } } },
            }),
          `toggles: ${chat.name}`,
        )
      : PP.apply_try((s) =>
          PP.record_set(s, { collection: "blocks", id: b.id, fields: { on: v } }),
        );
  const on = (b) => (chat ? PP.block_on_get(state, chat, b) : b.on !== false);
  return html`<div class="list" ref=${PP.sortable_ref(({ id, index }) => move(id, index))}>
    ${blocks.map(
      (
        b,
        i,
      ) => html`<div class=${`item blk${b.type === "message" || on(b) ? "" : " off"}`} key=${b.id} data-id=${b.id}>
        <span class="grip">${PP.icon_svg("grip")}</span>
        <button class="grow" onClick=${() => open && b.type !== "message" && open(b)}>${PP.block_name_get(state, b)}<small>${block_type_format(b)}</small></button>
        <span class="mv">
          ${PP.icon_render("up", "Move up", () => i > 0 && move(b.id, i - 1), false, "act")}
          ${PP.icon_render("down", "Move down", () => i < blocks.length - 1 && move(b.id, i + 1), false, "act")}
        </span>
        ${b.type === "message" ? null : toggle(on(b), "On or off", (v) => flip(b, v))}
      </div>`,
    )}
  </div>`;
};

// A profile becomes the open chat's (its own toggles start over) and the one new chats start with.
const profile_pick = (chat, id) =>
  PP.apply_try(
    (s) => {
      const set_default = (x) =>
        PP.record_set(x, { collection: "settings", fields: { "chats.profile": id } });
      if (!chat) return set_default(s);
      const own = PP.record_set(s, {
        collection: "chats",
        id: chat.id,
        fields: { own: { profile: id, toggles: null } },
      });
      if (own.error) return own;
      const next = set_default(own.state);
      return { ...next, targets: [...own.targets, ...next.targets] };
    },
    chat ? `profile: ${chat.name}` : undefined,
  );

// The profile dropdown (Quick edit, the profile editor): the profile and a line under it; open,
// every profile with Edit, + New, Import…, Export this, Export all. `pick` runs on a choice.
// `edit`: the Edit button beside it (off where the sheet already has "Edit profile").
const profile_dropdown = (state, current, sub, pick, edit = true) => {
  const open = state.ui.profile_menu;
  const toggle_open = () => PP.ui_set((ui) => ({ profile_menu: !ui.profile_menu }));
  return html`<div class="dd">
    <div class="ddrow">
      <button class="item grow" onClick=${toggle_open}><span class="grow">${current.name}<small>${sub}</small></span><span class="ch">${PP.icon_svg(open ? "up" : "down")}</span></button>
      ${edit ? html`<button class="pill big" onClick=${() => PP.sheet_open("profile", { id: current.id })}>${PP.icon_svg("edit")} Edit</button>` : null}
    </div>
    ${
      open
        ? html`<div class="ddlist">
          ${state.config.profiles.map(
            (p) => html`<div class="ddrow" key=${p.id}>
              <button class="item grow" onClick=${() => (PP.ui_set(() => ({ profile_menu: false })), pick(p))}>
                <span class=${`radio${p.id === current.id ? " on" : ""}`}></span><span class="grow">${p.name}</span>
              </button>
              <button class="pill" onClick=${() => PP.sheet_open("profile", { id: p.id })}>Edit</button>
            </div>`,
          )}
          <div class="chips">
            <button class="pill" onClick=${() => PP.command_run("profiles")}>+ New</button>
            <button class="pill" onClick=${() => PP.command_run("profiles_import")}>Import…</button>
            <button class="pill" onClick=${() => PP.command_run("profiles_export", { ids: [current.id] })}>Export this</button>
            <button class="pill" onClick=${() => PP.command_run("profiles_export")}>Export all</button>
          </div>
        </div>`
        : null
    }
  </div>`;
};

// The groups of Settings: name, the line under it, its own sheet (else its section), its icon.
const GROUPS = [
  ["Plugins", "Profile blocks and the plugin library", "plugins", "plugins"],
  ["Prompt library", "System prompts you keep and link", "prompts", "prompt"],
  ["Look", "Theme, accent, quick actions", null, "look"],
  ["Sites", "Pages at once, waiting for replies", null, "sites"],
  ["Chats and storage", "Chat folder, move chats, storage check", null, "storage"],
  ["Git", "History and backup", null, "retry"],
  ["Credentials", "API keys, tokens, passwords", "credentials", "char"],
  ["Import and export", "Profiles, prompts, name clashes", null, "impexp"],
  ["Local API", "Address, token, folder", null, "api"],
  ["Advanced", "Reset, safe mode, logs", null, "adv"],
  ["Help", "Shortcuts, quick start", null, "help"],
];

// Making a plugin with an AI, one section wherever it's offered (the Plugin guide, Install a
// plugin): copy the guide with a request to fill in first, which AI works well, and the guide
// itself folded under it.
const ai_make_rows = (state) => {
  const text = load_get(state, "plugin_guide", () =>
    fetch("/docs/PLUGINS.md").then((r) => (r.ok ? r.text() : "Guide not found.")),
  );
  const guide = typeof text === "string" ? text : "";
  const request = `${guide}\n\n---\n\nUsing the guide above, write a promptpipe plugin that: <describe what it should do>.\nGive every file, each with its name on the line before its code block.`;
  return [
    item({
      icon: "copy",
      label: "Copy the guide for an AI",
      sub: "The plugin guide and a request: paste it, then say what the plugin should do",
      cls: "prim",
      onClick: () =>
        PP.call_try(
          "clipboard_write",
          { text: request },
          "Copied: paste it to an AI and describe your plugin",
        ),
    }),
    html`<small>Claude (claude.ai) writes these well, even on the free plan.</small>`,
    html`<details class="guidebox"><summary>Read the guide</summary>${guide ? PP.markdown_render(guide) : html`<small>Loading…</small>`}</details>`,
  ];
};

const SHEETS = {
  settings: (state) => {
    const updates = ((state.catalogue && state.catalogue.updates) || []).length;
    return {
      title: "Settings",
      rows: GROUPS.map(([name, sub, sheet, icon]) =>
        item({
          key: name,
          icon,
          label: name,
          sub,
          right: name === "Plugins" && updates ? html`<span class="badge">${updates}</span>` : "›",
          onClick: () => PP.sheet_open(sheet || "section", { name }),
        }),
      ),
    };
  },

  section: (state, { name }) => ({
    title: name,
    rows: [
      ...state.schemas.settings
        .filter((d) => d.section === name && !d.hidden)
        .map((d) =>
          field_render(state, d, PP.setting_get(state, d.key), (v) => set({ [d.key]: v })),
        ),
      ...(SECTION_EXTRAS[name] ? SECTION_EXTRAS[name](state) : []),
      ...(PP.plugin_commands || [])
        .filter((c) => c.place === `Settings › ${name}`)
        .map((c) => item({ key: c.id, label: c.label, onClick: () => PP.command_run(c.id) })),
    ],
  }),

  chat: (state) => {
    const chat = PP.chat_get(state);
    if (!chat)
      return {
        title: "Chat",
        rows: [item({ label: "New chat", sub: "Saved with its first message" })],
      };
    const pinned = ((state.folders.find((f) => f.id === "") || {}).pinned || []).includes(chat.id);
    return {
      title: "Chat",
      rows: [
        item({
          label: chat.name,
          sub: "Rename",
          onClick: () =>
            PP.dialog_open({
              title: "Rename the chat",
              value: chat.name,
              ok: "Rename",
              command: "chat_rename",
            }),
        }),
        html`<div class="chips">
          ${(chat.tags || []).map(
            (t) =>
              html`<button
                class=${`tag${t.endsWith("#") ? " counter" : ""}`}
                key=${t}
                onClick=${() => PP.confirm_open(`Remove the tag #${t} from this chat?`, "Remove", "chat_tag_remove", { tag: t })}
              >
                #${t}
              </button>`,
          )} <button class="tag" onClick=${() => PP.command_run("chat_tag")}>+ tag</button>
        </div>`,
        label("Actions"),
        item({ label: "Copy the whole chat", onClick: () => PP.command_run("chat_copy") }),
        item({
          label: "Remove repeated messages",
          sub: "Copies of the same message and reply, keeping the first",
          onClick: async () => {
            const before = PP.state_get().turns.filter((t) => t.chat === chat.id).length;
            await PP.apply_try(
              (s) => PP.turns_repeated_remove(s, { chat: chat.id }),
              `repeated messages removed: ${chat.name}`,
            );
            const removed = before - PP.state_get().turns.filter((t) => t.chat === chat.id).length;
            if (removed)
              PP.toast(
                `${removed} repeated message${removed === 1 ? "" : "s"} removed`,
                false,
                null,
                {
                  label: "Undo",
                  command: "undo",
                },
              );
            else PP.toast("No repeated messages in this chat");
          },
        }),
        item({ label: "Share or export…", onClick: () => PP.command_run("chat_share") }),
        item({
          label: "Pin to top",
          sub: pinned ? "Pinned" : "Not pinned",
          right: pinned ? html`<span class="ondot"></span>` : null,
          onClick: () =>
            PP.chats_move(
              [chat.id],
              pinned
                ? {
                    folder: chat.file.includes("/")
                      ? chat.file.slice(0, chat.file.lastIndexOf("/"))
                      : "",
                  }
                : { pinned: 0 },
              pinned ? `unpinned: ${chat.name}` : `pinned: ${chat.name}`,
            ),
        }),
        item({
          label: "Move to folder…",
          sub: chat.file.includes("/")
            ? `In ${chat.file.slice(0, chat.file.lastIndexOf("/"))}`
            : "Top level",
          right: "›",
          onClick: () => PP.sheet_open("move", { ids: [chat.id] }),
        }),
        ...(PP.plugin_commands || [])
          .filter((c) => c.place === "Chat")
          .map((c) => item({ key: c.id, label: c.label, onClick: () => PP.command_run(c.id) })),
        label("History"),
        item({
          label: `Saved ${new Date(chat.updated || chat.created || Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })} · ${state.turns.filter((t) => t.chat === chat.id).length} messages`,
          sub: "The chat's commits",
          right: "›",
          onClick: () => PP.sheet_open("history", { path: chat.file }),
        }),
        item({
          label: "Delete this chat",
          cls: "danger",
          sub: "It stays in the history",
          onClick: () => PP.chats_delete_ask([chat.id]),
        }),
      ],
    };
  },

  // A folder: rename it, or delete it (its chats go to the top level).
  folder: (state, { path }) => {
    const count = state.chats.filter((c) => c.file.startsWith(`${path}/`)).length;
    const name = path.split("/").pop();
    return {
      title: name,
      rows: [
        html`<div class="search">${PP.icon_svg("folder")}<input aria-label="Folder name" value=${state.ui.folder_name ?? name}
          onInput=${(e) => PP.ui_set(() => ({ folder_name: e.target.value }))} /></div>`,
        item({
          label: "Rename",
          cls: "prim",
          onClick: () =>
            PP.folder_rename_run(path, state.ui.folder_name ?? name).then(
              (r) =>
                r && PP.ui_set((ui) => ({ folder_name: null, sheets: ui.sheets.slice(0, -1) })),
            ),
        }),
        item({
          label: "Delete folder",
          cls: "danger",
          sub: count
            ? `Its ${count} chat${count === 1 ? "" : "s"} move to the top level`
            : "It's empty",
          onClick: () =>
            PP.confirm_open(
              `Delete the folder “${name}”?${count ? ` Its ${count} chat${count === 1 ? "" : "s"} move to the top level.` : ""}`,
              "Delete",
              "folder_delete",
              { path },
            ),
        }),
      ],
    };
  },

  move: (state, { ids }) => {
    const folders = PP.folder_list(state);
    const to = (folder) =>
      PP.chats_move(
        ids || [state.ui.chat],
        { folder },
        `moved to ${folder || "the top level"}`,
      ).then(() => PP.sheet_close());
    return {
      title: "Move to folder",
      rows: [
        item({ label: "Top level (no folder)", onClick: () => to("") }),
        ...folders.map((f) => item({ key: f, label: f, onClick: () => to(f) })),
        item({ label: "New folder…", onClick: () => PP.command_run("folder_new") }),
      ],
    };
  },

  models: (state) => {
    const chat = PP.chat_get(state);
    const read = load_get(state, "models", () => PP.model_list(state, chat));
    const own = (fields) =>
      PP.apply_try((s) =>
        chat
          ? PP.record_set(s, { collection: "chats", id: chat.id, fields: { own: fields } })
          : PP.record_set(s, {
              collection: "provider_choices",
              id: PP.provider_get(s, null),
              fields,
            }),
      );
    const model = PP.model_get(state, chat);
    const options = PP.options_get(state, chat);
    if (!read)
      return {
        title: "Model and options",
        rows: [item({ label: "Reading the site's model list…" })],
      };
    if (read.error)
      return {
        title: "Model and options",
        rows: [
          item({
            label: "Couldn't read the page",
            sub: `${read.error} · tap to try again`,
            onClick: () => load_clear("models"),
          }),
        ],
      };
    return {
      title: "Model and options",
      rows: [
        ...(read.models.length
          ? read.models.map((m) =>
              item({
                key: m,
                label: m,
                sub: m === read.model ? "On the page now" : "",
                right: m === (model || read.model) ? "●" : "○",
                onClick: () => own({ model: m }),
              }),
            )
          : [
              item({
                label: "Couldn't read the model list",
                sub: `Pick it on the site itself. On the page now: ${read.model || "?"}`,
              }),
            ]),
        label("Options"),
        ...read.options.map((o) =>
          item({
            key: o.name,
            label: o.name,
            sub: o.found ? "" : "Not found on the page",
            right: toggle(options[o.name] ?? o.on, o.name, (v) =>
              own({ options: { [o.name]: v } }),
            ),
          }),
        ),
        label("More"),
        item({
          label: "Choose on the site",
          onClick: () => (own({ model: null }), PP.command_run("site_view")),
        }),
        item({ label: "Read the page again", onClick: () => load_clear("models") }),
        html`<small>Saved for this provider and set on the page before each message.</small>`,
      ],
    };
  },

  provider: (state) => ({
    title: "Profile and provider",
    rows: [
      item({
        label: PP.profile_get(state, PP.chat_get(state)).name,
        sub: "This chat's profile · tap to switch",
        right: "›",
        onClick: () => PP.sheet_open("profiles"),
      }),
      item({
        label: "Model and options",
        sub: PP.model_get(state, PP.chat_get(state)) || "As the site has it",
        right: "›",
        onClick: () => PP.command_run("models"),
      }),
      ...["site_link", "site_import", "site_newest", "site_decode"].map((id) =>
        item({
          key: id,
          label: PP.COMMANDS.find((c) => c.id === id).label,
          onClick: () => PP.command_run(id),
        }),
      ),
      item({
        label: "Copy page report (to fix a site)",
        onClick: () => PP.page_report_copy(state.pages[0] && state.pages[0].id),
      }),
    ],
  }),

  // Quick edit (wireframe): the chat's profile by name (tap to rename), Edit profile, the profile
  // dropdown, its blocks, and what can be added to your message.
  quick: (state) => {
    const chat = PP.chat_get(state);
    const profile = PP.profile_get(state, chat);
    const own = (chat && chat.own && chat.own.toggles) || {};
    const naming = state.ui.profile_name !== undefined && state.ui.profile_name !== null;
    const name_save = () =>
      PP.command_run("profile_rename", { id: profile.id, value: state.ui.profile_name }).then(() =>
        PP.ui_set(() => ({ profile_name: null })),
      );
    return {
      short: true,
      title: profile.name,
      title_node: naming
        ? html`<span class="grow namefield">
            <input aria-label="Profile name" ref=${PP.focus_ref} value=${state.ui.profile_name}
              onInput=${(e) => PP.ui_set(() => ({ profile_name: e.target.value }))} onKeyDown=${(e) => e.key === "Enter" && name_save()} />
            <button class="pill on" onClick=${name_save}>Save</button>
          </span>`
        : html`<button class="grow titlebtn" aria-label="Rename profile" onClick=${() => PP.ui_set(() => ({ profile_name: profile.name }))}>
            ${profile.name}<small>Quick edit · tap the name to rename</small>
          </button>`,
      head_extra: html`<button class="pill big" onClick=${() => PP.sheet_open("profile", { id: profile.id })}>${PP.icon_svg("edit")} Edit profile</button>`,
      rows: [
        // The whole profile on or off: off, your message goes alone, as typed.
        item({
          label: "Use the profile",
          sub: PP.raw_get(state)
            ? "Off: your message goes alone, as typed"
            : "Its blocks go with your message",
          right: PP.switch_render(!PP.raw_get(state), "Use the profile", (on) =>
            PP.raw_set(state, !on),
          ),
          onClick: () => PP.raw_set(state, !PP.raw_get(state)),
          cls: PP.raw_get(state) ? "off" : "",
        }),
        profile_dropdown(
          state,
          profile,
          chat ? "This chat's profile · tap to switch" : "New chats start with it · tap to switch",
          (p) => profile_pick(chat, p.id),
          false,
        ),
        html`<small>Switch on or off, drag to reorder.</small>`,
        html`<div class=${PP.raw_get(state) ? "dimmed" : ""}>${block_rows(state, profile, chat, (b) => PP.sheet_open("block", { id: b.id }))}</div>`,
        Object.keys(own).length
          ? item({
              label: "Use the profile's toggles",
              sub: `${Object.keys(own).length} differ in this chat`,
              onClick: () =>
                PP.apply_try((s) =>
                  PP.record_set(s, {
                    collection: "chats",
                    id: chat.id,
                    fields: { own: { toggles: null } },
                  }),
                ),
            })
          : null,
        label("Add to your message"),
        item({
          icon: "quote",
          label: "Text file",
          sub: "Put its text in the box",
          onClick: () => PP.command_run("text_file"),
        }),
        item({
          icon: "copy",
          label: "Several text files",
          sub: "One after another, in the box",
          onClick: () => PP.command_run("text_files"),
        }),
        item({
          icon: "plus",
          label: "Attach files",
          sub: "Kept with the chat, sent to providers that take them",
          onClick: () => PP.command_run("attach"),
        }),
      ],
    };
  },

  profiles: (state) => {
    const active = PP.setting_get(state, "chats.profile");
    return {
      title: "Profiles",
      rows: [
        ...state.config.profiles.map((p) =>
          item({
            key: p.id,
            label: p.name,
            sub: p.id === active ? "Active" : "",
            right: "›",
            onClick: () => PP.sheet_open("profile", { id: p.id }),
          }),
        ),
        label("New from a template"),
        ...PP.template_list(state).map((t) =>
          item({
            key: t.id,
            label: t.name,
            sub: `${t.blocks.filter((b) => b.type !== "message").length} blocks`,
            onClick: () =>
              PP.apply_try((s) =>
                PP.profile_create(s, { template: t.id, name: t.name, id: PP.id_create() }),
              ),
          }),
        ),
        item({ label: "Import a profile…", onClick: () => PP.command_run("profiles_import") }),
        item({ label: "Export all profiles", onClick: () => PP.command_run("profiles_export") }),
      ],
    };
  },

  profile: (state, { id }) => {
    const profile = state.config.profiles.find((p) => p.id === id);
    if (!profile)
      return { title: "Profile", rows: [item({ label: "This profile isn't here any more" })] };
    return {
      title: profile.name,
      rows: [
        profile_dropdown(state, profile, "The profile you're editing · tap to change", (p) =>
          PP.ui_set((ui) => ({
            sheets: [...ui.sheets.slice(0, -1), { name: "profile", data: { id: p.id } }],
          })),
        ),
        label("Sent top to bottom"),
        block_rows(state, profile, null, (b) => PP.sheet_open("block", { id: b.id })),
        item({
          label: "Add a block",
          sub: "System prompts and plugins",
          right: "›",
          onClick: () => PP.sheet_open("block_add", { id }),
        }),
        label("This profile"),
        item({
          label: "Use this profile",
          sub: "For the open chat, and new chats start with it",
          onClick: () => profile_pick(PP.chat_get(state), id),
        }),
        item({
          label: "Rename",
          sub: profile.name,
          onClick: () =>
            PP.dialog_open({
              title: "Rename the profile",
              value: profile.name,
              ok: "Rename",
              command: "profile_rename",
              data: { id },
            }),
        }),
        item({
          label: "Duplicate",
          onClick: () =>
            PP.apply_try((s) =>
              PP.record_copy(s, { collection: "profiles", id, new_id: PP.id_create() }),
            ),
        }),
        item({
          label: "What will be sent",
          right: "›",
          onClick: () => PP.sheet_open("preview", { id }),
        }),
        item({
          label: "Export this",
          onClick: () => PP.command_run("profiles_export", { ids: [id] }),
        }),
        state.config.profiles.length > 1
          ? item({
              label: "Delete this profile",
              cls: "danger",
              onClick: () =>
                PP.confirm_open(
                  `Delete the profile “${profile.name}”?`,
                  "Delete",
                  "profile_delete",
                  { id },
                ),
            })
          : null,
      ],
    };
  },

  block: (state, { id }) => {
    const b = state.config.blocks.find((x) => x.id === id);
    if (!b)
      return {
        title: "Block",
        rows: [item({ label: "This block isn't in the profile any more" })],
      };
    const save = (fields) =>
      PP.apply_try((s) => PP.record_set(s, { collection: "blocks", id, fields }));
    const sends = [
      ["every", "Every message"],
      ["first", "First message of a site chat"],
      ["every_n", "Every N messages"],
      ["depth", "At depth N"],
      ["off", "Off"],
    ];
    const scopes = [
      ["above", "Everything above it"],
      ["message", "Only your message"],
      ["picked", "Only the blocks I pick"],
    ];
    return {
      title: PP.block_name_get(state, b),
      rows:
        b.type === "message"
          ? [
              item({
                label: "Your message",
                sub: "Your text goes here. Move it to put blocks before or after it.",
              }),
            ]
          : [
              item({ label: "On", right: toggle(b.on !== false, "On", (v) => save({ on: v })) }),
              ...(b.type === "prompt" && !b.link
                ? [
                    html`<input
                      class="field"
                      aria-label="Name"
                      value=${b.name || ""}
                      onChange=${(e) => save({ name: e.target.value })}
                    />`,
                    html`<textarea
                      class="field"
                      aria-label="Text"
                      placeholder="What to send. An empty one isn't sent."
                      onChange=${(e) => save({ text: e.target.value })}
                    >
${b.text || ""}</textarea
                    >`,
                  ]
                : []),
              ...(b.type === "prompt"
                ? [
                    label("Send it"),
                    ...sends.map(([v, l]) =>
                      item({
                        key: v,
                        label: l,
                        right: b.send === v ? "●" : "○",
                        onClick: () => save({ send: v }),
                      }),
                    ),
                  ]
                : []),
              ...(b.type === "prompt" && ["every_n", "depth"].includes(b.send)
                ? [
                    field_render(
                      state,
                      {
                        key: "number",
                        type: "number",
                        label:
                          b.send === "depth"
                            ? "Messages up from the newest"
                            : "Every how many messages",
                      },
                      b.number,
                      (v) => save({ number: v }),
                    ),
                  ]
                : []),
              ...(b.type === "plugin"
                ? [
                    label("It changes"),
                    ...scopes.map(([v, l]) =>
                      item({
                        key: v,
                        label: l,
                        right: (b.scope || "above") === v ? "●" : "○",
                        onClick: () => save({ scope: v }),
                      }),
                    ),
                  ]
                : []),
              item({
                label: "Take it out of this profile",
                cls: "danger",
                onClick: () =>
                  PP.apply_try((s) => PP.record_delete(s, { collection: "blocks", id })).then(() =>
                    PP.sheet_close(),
                  ),
              }),
            ],
    };
  },

  block_add: (state, { id }) => {
    const add = (fields) =>
      PP.apply_try((s) =>
        PP.record_create(s, {
          collection: "blocks",
          id: PP.id_create(),
          fields: { profile: id, on: true, ...fields },
          index: state.config.blocks
            .filter((b) => b.profile === id)
            .findIndex((b) => b.type === "message"),
        }),
      ).then(() => PP.sheet_close());
    const plugins = state.plugins.filter(
      (p) =>
        !(p.manifest.tags || []).some((t) =>
          ["provider", "theme", "passive", "runtime"].includes(t),
        ),
    );
    return {
      title: "Add a block",
      rows: [
        label("System prompts"),
        item({
          label: "New system prompt",
          sub: "Write one for this profile",
          onClick: () =>
            add({ type: "prompt", name: "New system prompt", text: "", send: "every", number: 5 }),
        }),
        ...state.prompts.map((p) =>
          item({
            key: p.id,
            label: `${p.pinned ? "Pinned · " : ""}${p.name || p.text.slice(0, 40)}`,
            sub: "Linked from the library",
            onClick: () => add({ type: "prompt", link: p.id, send: "every", number: 5 }),
          }),
        ),
        label("Plugins"),
        ...plugins.map((p) =>
          item({
            key: p.id,
            label: p.manifest.name,
            onClick: () => add({ type: "plugin", plugin: p.id, scope: "above" }),
          }),
        ),
      ],
    };
  },

  text: (state, { title, text }) => ({ title, rows: [PP.markdown_render(text)] }),

  // A box where picking a part of a reply is easy (long-press works on the reply too).

  preview: (state, { id }) => ({
    title: "What will be sent",
    rows: [html`<pre>${PP.preview_build(state, { id }, true) || "(nothing)"}</pre>`],
  }),

  prompts: (state) => ({
    title: "Prompt library",
    rows: [
      html`<small
        >System prompts you keep. A profile links one as a block: change it here and every profile
        that links it sends the new text.</small
      >`,
      ...[...state.prompts]
        .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0))
        .map((p) =>
          item({
            key: p.id,
            label: `${p.pinned ? "Pinned · " : ""}${p.name || p.text.split("\n")[0].slice(0, 40)}`,
            sub: p.text.replace(/\s+/g, " ").slice(0, 90),
            right: "›",
            onClick: () => PP.sheet_open("prompt", { id: p.id }),
          }),
        ),
      label("Manage"),
      item({
        label: "New system prompt",
        onClick: () =>
          PP.apply_try(
            (s) =>
              PP.record_create(s, {
                collection: "prompts",
                id: PP.id_create(),
                fields: { name: "", text: "New prompt", pinned: false, updated: PP.time_get() },
              }),
            "prompt library: added",
          ),
      }),
      item({
        label: "Import prompts…",
        sub: ".md or .txt files, or a library file",
        onClick: () => PP.command_run("prompts_import"),
      }),
      item({ label: "Export the whole library", onClick: () => PP.command_run("prompts_export") }),
    ],
  }),

  prompt: (state, { id }) => {
    const p = state.prompts.find((x) => x.id === id);
    if (!p)
      return {
        title: "Prompt",
        rows: [item({ label: "This prompt isn't in the library any more" })],
      };
    const save = (fields) =>
      PP.apply_try(
        (s) =>
          PP.record_set(s, {
            collection: "prompts",
            id,
            fields: { ...fields, updated: PP.time_get() },
          }),
        `prompt library: edited ${p.name || "a prompt"}`,
      );
    const users = state.config.profiles.filter((pr) =>
      state.config.blocks.some((b) => b.profile === pr.id && b.link === id),
    );
    return {
      title: p.name || "Prompt",
      rows: [
        html`<input
          class="field"
          placeholder="Name (optional)"
          value=${p.name}
          onChange=${(e) => save({ name: e.target.value })}
        />`,
        html`<textarea class="field" rows="9" onChange=${(e) => save({ text: e.target.value })}>
${p.text}</textarea
        >`,
        html`<small
          >${
            users.length
              ? `Linked by ${users.map((u) => u.name).join(", ")}: they send the new text.`
              : "No profile links it yet."
          }</small
        >`,
        item({
          label: p.pinned ? "Unpin" : "Pin to the top",
          onClick: () => save({ pinned: !p.pinned }),
        }),
        item({
          label: "Copy the text",
          onClick: () => PP.call_try("clipboard_write", { text: p.text }, "Copied"),
        }),
        item({
          label: "Delete from the library",
          cls: "danger",
          onClick: () =>
            PP.apply_try(
              (s) => PP.record_delete(s, { collection: "prompts", id }),
              "prompt library: deleted",
            ).then(() => PP.sheet_close()),
        }),
      ],
    };
  },

  // Plugins (wireframe): Profile (the profile's blocks, as in the editor) | Library (what's
  // installed, by type, with updates; more from the catalogue; sources; installing).
  plugins: (state, { tab = "profile", filter = "all" }) => {
    const reopen = (data) =>
      PP.ui_set((ui) => ({
        sheets: [...ui.sheets.slice(0, -1), { name: "plugins", data: { tab, filter, ...data } }],
      }));
    const catalogue =
      state.catalogue || load_get(state, "plugins:catalogue", () => PP.catalogue_load(state));
    const updates = (catalogue && catalogue.updates) || [];
    const tabs = html`<div class="tabs">
      <button class=${tab === "profile" ? "on" : ""} onClick=${() => reopen({ tab: "profile" })}>Profile</button>
      <button class=${tab === "library" ? "on" : ""} onClick=${() => reopen({ tab: "library" })}>Library${updates.length ? html` <span class="badge">${updates.length}</span>` : null}</button>
    </div>`;
    const head_extra = PP.icon_render("play", "Plugin guide", () => PP.sheet_open("plugin_guide"));
    if (tab === "profile") {
      const editing =
        state.config.profiles.find((p) => p.id === state.ui.plugins_profile) ||
        PP.profile_get(state, PP.chat_get(state));
      return {
        title: "Plugins",
        head_extra,
        rows: [
          tabs,
          profile_dropdown(state, editing, "The profile you're editing · tap to change", (p) =>
            PP.ui_set(() => ({ plugins_profile: p.id })),
          ),
          label("Sent top to bottom"),
          block_rows(state, editing, null, (b) => PP.sheet_open("block", { id: b.id })),
          item({
            label: "Add a block",
            sub: "System prompts and plugins",
            right: "›",
            onClick: () => PP.sheet_open("block_add", { id: editing.id }),
          }),
        ],
      };
    }
    const types = [
      ["all", "All"],
      ["provider", "Providers"],
      ["plugin", "Message"],
      ["theme", "Themes"],
      ["passive", "Passive"],
    ];
    const type_get = (tags = []) =>
      tags.includes("runtime")
        ? "runtime"
        : ["provider", "theme", "passive"].find((t) => tags.includes(t)) || "plugin";
    const shown = (tags) =>
      filter === "all" ? type_get(tags) !== "runtime" : type_get(tags) === filter;
    const update_of = (id) => updates.find((u) => u.id === id);
    const installed = state.plugins.filter((p) => shown(p.manifest.tags));
    const offers = ((catalogue && catalogue.offers) || []).filter(
      (o) => !o.installed && shown(o.tags),
    );
    const type_format = (tags) => ["Plugin", ...(tags || [])].join(" · ");
    return {
      title: "Plugins",
      head_extra,
      rows: [
        tabs,
        html`<div class="chips">${types.map(([k, l]) => html`<button class=${`pill${k === filter ? " on" : ""}`} key=${k} onClick=${() => reopen({ filter: k })}>${l}</button>`)}</div>`,
        updates.length
          ? item({
              label: "Update all",
              cls: "prim",
              sub: `${updates.length} update${updates.length === 1 ? "" : "s"}`,
              onClick: () =>
                PP.call_try("plugin_update", {}, "Updated. Restart the app to use them."),
            })
          : null,
        ...installed.map((p) =>
          item({
            key: p.id,
            label: p.manifest.name,
            sub: `${type_format(p.manifest.tags)} · ${p.manifest.version} · ${p.copy.replace("_", "-")}${p.status !== "loaded" ? ` · ${p.status.replace("_", " ")}` : ""}`,
            right: update_of(p.id) ? html`<span class="badge">Update</span>` : "›",
            onClick: () => PP.sheet_open("plugin", { id: p.id }),
          }),
        ),
        catalogue ? null : item({ label: "Checking the sources…" }),
        offers.length ? label("Get more") : null,
        ...offers.map((o) =>
          item({
            key: `${o.source.id}/${o.id}`,
            label: o.name,
            sub: `${type_format(o.tags)} · ${o.version}${o.app_too_old ? ` · needs app ${o.min_app}` : ""}`,
            right: html`<span class="pill">Get</span>`,
            onClick: () => PP.command_run("plugin_install", { entry: o }),
          }),
        ),
        ...((catalogue && catalogue.failed) || []).map((f) =>
          item({
            key: f.source.id || f.source.url,
            label: `Couldn't load ${f.source.url}`,
            sub: f.error.message,
            cls: "danger",
          }),
        ),
        label("Sources"),
        item({
          label: "Official",
          sub: "Zieviox/promptpipe-plugins · signed with the key built into the app",
        }),
        ...state.config.sources.map((src) =>
          item({
            key: src.id,
            label: src.url.replace("https://github.com/", ""),
            sub: `Key ${src.key.slice(0, 8)}… · tap to remove`,
            right: toggle(src.on, "On", (on) =>
              PP.apply_try((x) =>
                PP.record_set(x, { collection: "sources", id: src.id, fields: { on } }),
              ),
            ),
            onClick: () =>
              PP.confirm_open(
                `Remove ${src.url}? Plugins installed from it stay.`,
                "Remove",
                "source_remove",
                { id: src.id },
              ),
          }),
        ),
        item({
          label: "Add a source…",
          sub: "A friend's plugin repository, with a signed catalogue",
          onClick: () =>
            PP.dialog_open({
              title: "GitHub repository of the source",
              ok: "Check",
              command: "source_add",
            }),
        }),
        label("Install"),
        item({
          icon: "impexp",
          label: "Install from a file",
          sub: "A plugin's .zip",
          onClick: () => PP.command_run("plugin_file_install"),
        }),
        item({
          icon: "plus",
          label: "Install from a link or an AI's answer",
          right: "›",
          onClick: () => PP.sheet_open("install"),
        }),
        filter === "all"
          ? html`<details><summary>Runtime plugins (${state.plugins.filter((p) => type_get(p.manifest.tags) === "runtime").length})</summary>
          ${state.plugins.filter((p) => type_get(p.manifest.tags) === "runtime").map((p) => item({ key: p.id, label: p.manifest.name, sub: `${p.manifest.version} · ${p.copy.replace("_", "-")}`, right: update_of(p.id) ? html`<span class="badge">Update</span>` : "›", onClick: () => PP.sheet_open("plugin", { id: p.id }) }))}
        </details>`
          : null,
      ],
    };
  },

  // The Plugin guide: making a plugin with an AI (the same section the install sheet has), and
  // installing what comes back.
  plugin_guide: (state) => ({
    title: "Plugin guide",
    rows: [
      ...ai_make_rows(state),
      item({
        icon: "plus",
        label: "Install the result",
        sub: "Paste the AI's whole answer",
        right: "›",
        onClick: () => PP.sheet_open("install"),
      }),
    ],
  }),

  plugin: (state, { id }) => {
    const p = state.plugins.find((x) => x.id === id);
    if (!p)
      return { title: "Plugin", rows: [item({ label: "This plugin isn't installed any more" })] };
    const m = p.manifest;
    return {
      title: m.name,
      rows: [
        item({
          label: m.name,
          sub: `${["Plugin", ...(m.tags || [])].join(" · ")} · version ${m.version} · ${p.copy.replace("_", "-")}`,
        }),
        p.error ? item({ label: "It didn't load", sub: p.error, cls: "danger" }) : null,
        p.status === "changed_outside"
          ? item({
              label: "Changed outside the app",
              sub: "It won't run until you choose",
              cls: "danger",
            })
          : null,
        m.description ? html`<small>${m.description}</small>` : null,
        m.guide
          ? item({
              label: "Guide",
              right: "›",
              onClick: () =>
                PP.sheet_open("text", { title: m.name, text: PP.content_read(p.id, m.guide) }),
            })
          : null,
        (m.settings || []).length
          ? item({
              label: "Settings",
              right: "›",
              onClick: () => PP.sheet_open("plugin_settings", { id }),
            })
          : null,
        ((state.catalogue && state.catalogue.updates) || []).some((u) => u.id === id)
          ? item({
              label: "Update",
              cls: "prim",
              sub: "A newer version is in the catalogue",
              onClick: () =>
                PP.call_try("plugin_update", { ids: [id] }, "Updated. Restart the app to use it."),
            })
          : null,
        p.other_copies.length
          ? item({
              label: "Go back to the previous copy",
              onClick: () =>
                PP.call_try(
                  "plugin_update",
                  { ids: [id], previous: true },
                  "Done. Restart the app to use it.",
                ),
            })
          : null,
        p.copy === "built_in" && !state.app.safe_mode
          ? item({
              label: "Copy to edit",
              sub: "Into your plugin folder; your copy replaces this one",
              onClick: () => PP.call_try("plugin_copy", { plugin: id }, "Copied"),
            })
          : null,
        p.copy !== "built_in"
          ? item({
              label: "Remove",
              cls: "danger",
              onClick: () =>
                PP.confirm_open(
                  `Remove ${m.name}? Restart the app afterwards.`,
                  "Remove",
                  "plugin_remove",
                  { plugin: id, copy: p.copy },
                ),
            })
          : item({ label: "Built in", sub: "Take it out of a profile instead." }),
      ],
    };
  },

  plugin_settings: (state, { id }) => {
    const p = state.plugins.find((x) => x.id === id);
    const chat = PP.chat_get(state);
    const provider = (p.manifest.tags || []).includes("provider");
    const save = (key, value) =>
      PP.apply_try((s) => {
        if (provider)
          return PP.record_set(s, {
            collection: "provider_choices",
            id,
            fields: { settings: { [key]: value } },
          });
        const profile = PP.profile_get(s, chat);
        return PP.record_set(s, {
          collection: "profiles",
          id: profile.id,
          fields: { plugin_settings: { [id]: { [key]: value } } },
        });
      });
    return {
      title: `${p.manifest.name} · settings`,
      rows: (p.manifest.settings || [])
        .filter((d) => !d.hidden)
        .map((d) =>
          field_render(state, d, PP.plugin_setting_get(state, chat, id, d.key), (v) =>
            save(d.key, v),
          ),
        ),
    };
  },

  install: (state) => ({
    title: "Install a plugin",
    rows: [
      label("Make one with an AI"),
      ...ai_make_rows(state),
      html`<textarea
        class="field"
        rows="6"
        placeholder="Paste the AI's whole answer: each file's name on the line before its code block"
        onChange=${(e) => PP.ui_set(() => ({ install_answer: e.target.value }))}
      ></textarea>`,
      item({
        label: "Install the answer",
        cls: "prim",
        onClick: () =>
          PP.command_run("plugin_install", {
            files: PP.answer_parse(state.ui.install_answer || ""),
          }),
      }),
      label("Or from a link"),
      html`<input
        class="field"
        placeholder="GitHub folder, plugin.json or .zip"
        aria-label="Plugin link"
        onChange=${(e) => PP.ui_set(() => ({ install_link: e.target.value }))}
      />`,
      item({
        label: "Install from the link",
        onClick: () => PP.command_run("plugin_install", { url: state.ui.install_link }),
      }),
    ],
  }),

  credentials: (state) => ({
    title: "Credentials",
    rows: [
      html`<small
        >Kept encrypted on this phone. A write-only one is only ever sent to its hosts.</small
      >`,
      ...state.credentials.map((c) =>
        item({
          key: c.name,
          label: c.name,
          sub: [
            c.access === "read_write" ? "read-write" : "write-only",
            (c.hosts || []).join(", "),
            `…${c.last4}`,
            ...(c.tags || []).map((t) => `#${t}`),
          ]
            .filter(Boolean)
            .join(" · "),
          right: html`<span class="pill">Remove</span>`,
          onClick: () => PP.credential_delete(c.name),
        }),
      ),
      item({
        label: "Add a credential",
        cls: "prim",
        onClick: () => PP.sheet_open("credential_add"),
      }),
    ],
  }),

  credential_add: (state) => {
    const form = state.ui.credential_form || {
      access: "write_only",
      header: "Authorization",
      prefix: "Bearer",
    };
    const put = (key) => (e) =>
      PP.ui_set((ui) => ({ credential_form: { ...form, [key]: e.target.value } }));
    return {
      title: "Add a credential",
      rows: [
        ...[
          ["name", "Name (e.g. git token)"],
          ["value", "The secret"],
          ["hosts", "Hosts it may go to, comma-separated"],
          ["header", "Header"],
          ["prefix", "Prefix"],
          ["tags", "Tags, comma-separated"],
        ].map(
          ([k, p]) =>
            html`<input
              class="field"
              key=${k}
              type=${k === "value" ? "password" : "text"}
              placeholder=${p}
              value=${form[k] || ""}
              onInput=${put(k)}
            />`,
        ),
        item({
          label: "Write-only",
          sub: "Plugins can use it, never read it",
          right: toggle(form.access !== "read_write", "Write-only", (v) =>
            PP.ui_set(() => ({
              credential_form: { ...form, access: v ? "write_only" : "read_write" },
            })),
          ),
        }),
        item({ label: "Save", cls: "prim", onClick: () => PP.credential_create(form) }),
      ],
    };
  },

  storage_check: (state) => {
    const tests = load_get(state, "storage_check", () => PP.call_send("storage_verify", {}));
    return {
      title: "Storage check",
      rows: (tests || [{ name: "Checking…", ok: true }]).map((s) =>
        item({ key: s.name, label: `${s.ok ? "✓" : "✕"} ${s.name}`, sub: s.why }),
      ),
    };
  },

  history: (state, { path }) => {
    const folder = PP.setting_get(state, "storage.chats_folder");
    const read = () => PP.call_send("commit_list", { folder, path, count: path ? 200 : 30 });
    const commits = load_get(state, `history:${path || ""}`, read);
    return {
      title: "History",
      rows: (commits && commits.error ? [] : commits || []).map((c) =>
        item({
          key: c.id,
          label: c.message,
          sub: `${new Date(c.time).toLocaleString()} · ${c.id}`,
        }),
      ),
    };
  },

  // One place for all logs: what's in the app's log (newest first, by type), and the core's log
  // and the platform's crash record from their files.
  log: (state) => {
    const log = state.log || { entries: [], seen_at: "" };
    const type = state.ui.log_type || "all";
    const KINDS = [
      ["all", "All"],
      ["errors", "Errors"],
      ["send", "Sends"],
      ["site", "Sites"],
      ["history", "History"],
      ["import", "Imports"],
      ["notice", "Notices"],
    ];
    const shown = log.entries
      .filter(
        (e) =>
          type === "all" || e.type === type || (type === "errors" && LOG_ERRORS.includes(e.type)),
      )
      .slice()
      .reverse();
    const text = shown
      .map(
        (e) =>
          `${new Date(e.at).toLocaleString()} · ${e.type}: ${e.text}${e.detail ? `\n  ${e.detail}` : ""}`,
      )
      .join("\n");
    return {
      title: "Logs",
      rows: [
        html`<div class="chips choose">
          ${KINDS.map(
            ([k, label]) =>
              html`<button key=${k} class=${`pill${k === type ? " on" : ""}`} onClick=${() => PP.ui_set(() => ({ log_type: k }))}>${label}</button>`,
          )}
        </div>`,
        shown.length
          ? html`<div class="logs">
              ${shown.slice(0, 200).map(
                (
                  e,
                  i,
                ) => html`<div key=${`${e.at}-${i}`} class=${`logrow${LOG_ERRORS.includes(e.type) ? " err" : ""}`}>
                  <small>${new Date(e.at).toLocaleString()} · ${e.type}</small>
                  <div>${e.text}</div>
                  ${e.detail ? html`<details><summary>Details</summary><pre>${e.detail}</pre></details>` : null}
                </div>`,
              )}
            </div>`
          : html`<small>Nothing here yet.</small>`,
        html`<div class="chips">
          <button class="pill" onClick=${() => PP.call_try("clipboard_write", { text }, "Copied")}>Copy</button>
          <button class="pill" onClick=${() => PP.confirm_open("Clear the log?", "Clear", "log_clear")}>Clear</button>
        </div>`,
        item({
          label: "The core's log",
          sub: "What the app's server wrote",
          right: "›",
          onClick: () =>
            PP.sheet_open("log_file", {
              root: "app",
              path: "logs/core.log",
              title: "The core's log",
            }),
        }),
        item({
          label: "The crash record",
          sub: "Written when the app crashes (Download/promptpipe-crash.txt)",
          right: "›",
          onClick: () =>
            PP.sheet_open("log_file", {
              root: "device",
              path: "/storage/emulated/0/Download/promptpipe-crash.txt",
              title: "The crash record",
            }),
        }),
      ],
    };
  },

  // A log kept in a file, shown as it is.
  log_file: (state, { root, path, title }) => {
    const file = load_get(state, `file:${root}:${path}`, () =>
      PP.call_send("file_read", { root, path }).then((f) => (f[0] ? f[0].data : "")),
    );
    const text =
      typeof file === "string" ? file || "Empty, or not there yet." : file ? file.error : "…";
    return {
      title,
      rows: [
        html`<pre class="logfile">${text.length > 60000 ? `…${text.slice(-60000)}` : text}</pre>`,
        item({ label: "Copy", onClick: () => PP.call_try("clipboard_write", { text }, "Copied") }),
      ],
    };
  },

  help: () => ({
    title: "Shortcuts and help",
    rows: [
      label("Keys"),
      ...PP.COMMANDS.filter((c) => c.key).map((c) =>
        item({ key: c.id, label: c.label, right: html`<small>${c.key}</small>` }),
      ),
      label("Touch"),
      ...[
        "Swipe a reply right: quote it",
        "Swipe a reply left: copy it",
        "Press and hold a chat: select",
        "Drag a grip: reorder",
        "Back: closes what is on top",
      ].map((t) => item({ key: t, label: t })),
      item({ label: "Quick start", right: "›", onClick: () => PP.command_run("quick_start") }),
      item({
        label: "Plugin guide",
        right: "›",
        onClick: () => PP.sheet_open("guide", { name: "PLUGINS.md" }),
      }),
    ],
  }),

  quick_start: (state) => ({
    title: "Quick start",
    rows: [
      ...PP.GUIDES.map((g) =>
        item({
          key: g.id,
          label: g.title,
          sub: `${g.stages.length} tips`,
          right: (PP.setting_get(state, "help.seen") || []).includes(g.id) ? "Seen" : "New",
          onClick: () => PP.tour_start(g.id),
        }),
      ),
      item({
        label: "Read the quick start",
        right: "›",
        onClick: () => PP.sheet_open("guide", { name: "QUICKSTART.md" }),
      }),
      item({ label: "Show every guide again", onClick: () => set({ "help.seen": [] }) }),
    ],
  }),

  guide: (state, { name }) => {
    const text = load_get(state, `guide:${name}`, () =>
      fetch(`/docs/${name}`).then((r) => (r.ok ? r.text() : "Guide not found.")),
    );
    return {
      title: name.replace(".md", ""),
      rows: [PP.markdown_render(typeof text === "string" ? text : "")],
    };
  },

  site_chats: (state) => {
    const page = state.pages[0];
    const read = () => (page ? PP.call_send("site_chat_list", { page: page.id }) : []);
    const chats = load_get(state, "site_chats", read);
    const open = (c) =>
      PP.call_try("site_chat_open", {
        provider: page.provider,
        url: c.url,
        name: c.name,
        id: PP.id_create(),
        at: PP.time_get(),
      });
    return {
      title: "On the site",
      rows: [
        ...(chats && chats.error ? [item({ label: chats.error, cls: "danger" })] : []),
        ...(Array.isArray(chats) ? chats : []).map((c) =>
          item({ key: c.url, label: c.name, onClick: () => open(c) }),
        ),
        item({ label: "Refresh", onClick: () => load_clear("site_chats") }),
      ],
    };
  },

  turn: (state, { id }) => {
    const turn = state.turns.find((t) => t.id === id);
    if (!turn) return { title: "Message", rows: [] };
    return {
      title: "Message",
      rows: [
        item({
          label: "Copy your message",
          onClick: () => PP.call_try("clipboard_write", { text: turn.message }, "Copied"),
        }),
        item({
          label: "Edit and send again",
          onClick: () => (PP.draft_set(turn.message, { replaces: turn.id }), PP.sheet_close()),
        }),
        item({
          label: "Run the reply plugins again",
          sub: "From what came back, with this chat's profile (decodes a Base64 reply, say)",
          onClick: async () => {
            PP.sheet_close();
            const r = await PP.call_try("turn_redo", { turn: turn.id });
            if (r)
              PP.toast(
                r.status === "updated" ? "Done" : r.status === "same" ? "Nothing changed" : r.why,
                r.status === "missing",
              );
          },
        }),
        item({
          label: "Check against the site",
          sub: "Takes the site's version of this reply if it's different (one cut short, say)",
          onClick: () => (PP.sheet_close(), PP.turn_check_run(turn.id)),
        }),
        item({
          label: "Copy the thinking",
          onClick: () => PP.call_try("clipboard_write", { text: turn.thinking }, "Copied"),
        }),
        item({
          label: "Tag this message",
          onClick: () =>
            PP.dialog_open({
              title: "Tag this message (name# numbers it)",
              ok: "Add",
              command: "turn_tag_add",
              data: { id: turn.id },
            }),
        }),
        item({
          label: "Delete this message and reply",
          cls: "danger",
          onClick: () => (
            PP.sheet_close(),
            PP.dialog_open({
              title: "Delete this message and its reply? It stays in the chat's history.",
              choices: [["yes", "Delete"]],
              command: "turn_delete",
              data: { id: turn.id },
            })
          ),
        }),
        ...(PP.plugin_commands || [])
          .filter((c) => c.place === "Reply")
          .map((c) =>
            item({ key: c.id, label: c.label, onClick: () => PP.command_run(c.id, { turn }) }),
          ),
        label("Sent with"),
        html`<small>${(turn.blocks || []).join(", ") || "Your message only"}</small>`,
        ...(turn.notes || []).map((n) => html`<small key=${n}>${n}</small>`),
        live_render(turn),
        html`<details>
          <summary class="muted">What went out and what came back</summary>
          <pre>${turn.sent}</pre>
          <pre>${turn.received}</pre>
        </details>`,
      ],
    };
  },
};

// How the reply came in, in numbers (never text): the page's own log of the reply growing, and
// how many progress updates the page sent and the app got. For finding where live updates stop.
const live_render = (turn) => {
  const d = turn.diagnostics || {};
  if (!d.log) return null;
  const rows = d.log.map(
    (e) =>
      `${String(e.at_s).padStart(4)} s  reply ${String(e.reply_length).padStart(5)}  thinking ${String(e.thinking_length).padStart(5)}${e.thinking_from ? ` (from ${e.thinking_from})` : ""}  stop ${e.stop ? "yes" : "no "}  hidden ${e.hidden ? "yes" : "no"}`,
  );
  const drawn = PP.draws_get(turn.id);
  const head = `Updates: the page sent ${d.sent}, the app got ${d.got}${drawn === undefined ? "" : `, the screen drew ${drawn} times`}`;
  const report = [head, ...rows].join("\n");
  return html`<details>
    <summary class="muted">Live updates: ${head.replace("Updates: ", "")}</summary>
    <pre>${report}</pre>
    <button class="pill" onClick=${() => PP.call_try("clipboard_write", { text: report }, "Copied")}>
      Copy
    </button>
  </details>`;
};

// The rows some settings sections have besides their settings.
const SECTION_EXTRAS = {
  "Chats and storage": (state) => [
    item({
      label: "Remove the old app's nested history folders",
      sub: "Copies the old app made of its chats folder inside itself, hundreds of levels deep",
      onClick: async () => {
        const deep = await PP.call_send("file_list", {
          root: "chats",
          folder: "history/history",
        }).catch(() => null);
        if (!deep) return PP.toast("There are none in the chats folder");
        PP.toast("Removing them, level by level…");
        const r = await PP.call_try("folder_deep_remove", { folder: "history" });
        if (!r) return;
        if (r.chats)
          return PP.toast(
            `${r.chats} chats still live in there. Remove chats imported twice first (Settings › Chats and storage), then try again.`,
            true,
          );
        PP.toast(`Removed (${r.removed} folders)`);
      },
    }),
    item({
      label: "Move all chats to another folder…",
      onClick: () =>
        PP.dialog_open({
          title: "Folder path (it moves the chats and uses it)",
          value: PP.setting_get(state, "storage.chats_folder"),
          ok: "Move",
          command: "chats_folder_move",
        }),
    }),
    item({
      label: "Allow all files access",
      sub: "Then restart the app",
      onClick: () => PP.call_try("storage_access_open", {}),
    }),
    item({ label: "Storage check", right: "›", onClick: () => PP.sheet_open("storage_check") }),
  ],
  Git: (state) => [
    item({
      label: "Push now",
      onClick: () =>
        PP.call_try(
          "repo_push",
          {
            folder: PP.setting_get(state, "storage.chats_folder"),
            remote: PP.setting_get(state, "git.remote"),
          },
          "Pushed",
        ),
    }),
    item({
      label: "Pull",
      onClick: () =>
        PP.call_try(
          "repo_pull",
          {
            folder: PP.setting_get(state, "storage.chats_folder"),
            remote: PP.setting_get(state, "git.remote"),
          },
          "Pulled",
        ),
    }),
    item({ label: "All commits", right: "›", onClick: () => PP.sheet_open("history", {}) }),
  ],
  "Local API": (state) => [
    item({
      label: "Address",
      sub: `http://127.0.0.1:${state.app.port || 7790}/v1`,
      onClick: () =>
        PP.call_try(
          "clipboard_write",
          { text: `http://127.0.0.1:${state.app.port || 7790}/v1` },
          "Copied",
        ),
    }),
    item({
      label: "API token",
      sub: state.ui.token ? state.ui.token : "••••  · Show or Copy",
      onClick: () =>
        PP.call_try("credential_read", { name: "local API token" }).then(
          (t) => t && PP.ui_set(() => ({ token: t })),
        ),
    }),
    item({
      label: "Make a new token",
      sub: "Apps using the old one need the new one",
      onClick: () => PP.call_try("api_token_create", {}, "New API token made"),
    }),
  ],
  Advanced: (state) => [
    item({
      label: "Reset to first launch",
      sub: "Shows the welcome again. Chats, profiles and plugins stay.",
      onClick: () =>
        PP.confirm_open(
          "Reset to first launch? The welcome shows again; your chats, profiles and plugins stay.",
          "Reset",
          "first_launch_reset",
        ),
    }),
    item({
      label: state.app.safe_mode ? "Leave safe mode" : "Restart in safe mode",
      onClick: () => PP.call_try("app_start", { mode: state.app.safe_mode ? "normal" : "safe" }),
    }),
    item({
      label: "Logs",
      sub: "Every notice and error, failed sends, site problems; the core's log and crash record",
      right: "›",
      onClick: () => PP.command_run("logs"),
    }),
    item({ label: "Stop background service", onClick: () => PP.call_try("service_stop", {}) }),
    item({
      label: "Version",
      sub: state.app.version || "?",
      onClick: () => PP.call_try("clipboard_write", { text: state.app.version || "" }, "Copied"),
    }),
  ],
  "Import and export": () =>
    PP.COMMANDS.filter((c) => c.place === "Settings › Import and export").map((c) =>
      item({ key: c.id, label: c.label, onClick: () => PP.command_run(c.id) }),
    ),
  Help: () => [
    item({ label: "Shortcuts", right: "›", onClick: () => PP.command_run("help") }),
    item({ label: "Quick start", right: "›", onClick: () => PP.command_run("quick_start") }),
  ],
};

// The top sheet, with back (when there's one under it) and close.
const sheet_render = (state) => {
  const top = state.ui.sheets[state.ui.sheets.length - 1];
  const make = SHEETS[top.name] || (PP.plugin_sheets || {})[top.name];
  if (top.name === "find") return frame(state, "Find", PP.find_render(state));
  const sheet = make
    ? make(state, top.data || {})
    : { title: top.name, rows: [item({ label: "Not available" })] };
  return frame(state, sheet.title, sheet.rows, !sheet.short, sheet.title_node, sheet.head_extra);
};

// Sheets are tall (nearly the whole screen), as in the wireframe; a short one fits its rows.
const frame = (state, title, rows, tall = true, title_node = null, head_extra = null) =>
  html`<div class="layer">
    <div class="scrim" onClick=${() => PP.ui_set(() => ({ sheets: [] }))}></div>
    <section class=${`sheet${tall ? " tall" : ""}`} role="dialog" aria-label=${title}>
      <h2>
        ${state.ui.sheets.length > 1 ? PP.icon_render("back", "Back", PP.sheet_close) : null}${title_node || html`<span style="flex:1">${title}</span>`}${head_extra}${PP.setting_get(state, "help.button") ? PP.icon_render("help", "Help: explain things", () => PP.command_run("help_mode"), state.ui.help) : null}${PP.icon_render("close", "Close", () => PP.ui_set(() => ({ sheets: [] })))}
      </h2>
      <div class="body">${rows}</div>
    </section>
  </div>`;

// An outside change, answered once (D7): keep theirs, keep the app's, or keep both.
const change_render = (state) => {
  const change = state.changes[0];
  const answer = (choice) => () => PP.call_try("change_resolve", { change, choice });
  return html`<div class="layer dialog">
    <div class="scrim"></div>
    <section class="sheet" role="alertdialog" aria-label="Changed outside the app">
      <h2>Changed outside the app</h2>
      <p>${change.path} changed since the app last wrote it.</p>
      <div class="chips">
        <button class="pill" onClick=${answer("theirs")}>Keep the outside change</button>
        <button class="pill" onClick=${answer("ours")}>Keep the app's</button
        ><button class="pill on" onClick=${answer("both")}>Keep both</button>
      </div>
    </section>
  </div>`;
};

PP.plugin_set({
  functions: { sheet_render, change_render, field_render, profile_pick, LOG_ERRORS },
});
