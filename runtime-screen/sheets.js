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
  if (def.type === "choice") {
    const choices = def.choices || choices_get(state, def.choices_from);
    const next =
      choices[(choices.findIndex((c) => c.value === value) + 1) % Math.max(1, choices.length)] ||
      {};
    const shown = (choices.find((c) => c.value === value) || {}).label || "—";
    return item({ key: def.key, label: def.label, sub: shown, onClick: () => on_set(next.value) });
  }
  return html`<label class="item" key=${def.key}
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

const GROUPS = [
  ["Plugins", "Profile blocks and the plugin library", "plugins"],
  ["Prompt library", "System prompts you keep and link", "prompts"],
  ["Look", "Theme, accent, quick actions"],
  ["Sites", "Pages at once, waiting for replies"],
  ["Chats and storage", "Chat folder, move chats, Git"],
  ["Git", "History and backup"],
  ["Credentials", "API keys, tokens, passwords", "credentials"],
  ["Import and export", "Profiles, prompts, name clashes"],
  ["Local API", "Address, token, folder"],
  ["Advanced", "Reset, safe mode, core log"],
  ["Help", "Shortcuts, quick start"],
];

const SHEETS = {
  settings: () => ({
    title: "Settings",
    rows: GROUPS.map(([name, sub, sheet]) =>
      item({
        key: name,
        label: name,
        sub,
        right: "›",
        onClick: () => PP.sheet_open(sheet || "section", { name }),
      }),
    ),
  }),

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
                onClick=${() => PP.chat_tag_remove(state, t)}
              >
                #${t} ✕
              </button>`,
          )} <button class="tag" onClick=${() => PP.command_run("chat_tag")}>+ tag</button>
        </div>`,
        label("Actions"),
        item({ label: "Copy the whole chat", onClick: () => PP.command_run("chat_copy") }),
        item({ label: "Share or export…", onClick: () => PP.command_run("chat_share") }),
        item({
          label: "Pin to top",
          sub: pinned ? "Pinned" : "Not pinned",
          onClick: () =>
            PP.apply_try((s) =>
              PP.folder_move(
                s,
                [chat.id],
                pinned
                  ? {
                      folder: chat.file.includes("/")
                        ? chat.file.slice(0, chat.file.lastIndexOf("/"))
                        : "",
                    }
                  : { pinned: 0 },
              ),
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
          label: `${state.turns.filter((t) => t.chat === chat.id).length} messages`,
          sub: "The chat's commits",
          right: "›",
          onClick: () => PP.sheet_open("history", { path: chat.file }),
        }),
        item({
          label: "Delete this chat",
          cls: "danger",
          sub: "It stays in the history",
          onClick: () => PP.chats_delete([chat.id]),
        }),
      ],
    };
  },

  move: (state, { ids }) => {
    const folders = PP.folder_list(state);
    const to = (folder) =>
      PP.apply_try((s) => PP.folder_move(s, ids || [state.ui.chat], { folder })).then(() =>
        PP.sheet_close(),
      );
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

  quick: (state) => {
    const chat = PP.chat_get(state);
    const profile = PP.profile_get(state, chat);
    const blocks = state.config.blocks.filter((b) => b.profile === profile.id);
    const own = (chat && chat.own && chat.own.toggles) || {};
    const flip = (b, v) =>
      chat &&
      PP.apply_try(
        (s) =>
          PP.record_set(s, {
            collection: "chats",
            id: chat.id,
            fields: { own: { toggles: { [b.id]: v } } },
          }),
        `toggles: ${chat.name}`,
      );
    return {
      title: profile.name,
      rows: [
        html`<small
          >Toggles are this chat's own; a new chat starts with the profile's. Drag to reorder the
          profile.</small
        >`,
        html`<div
          ref=${PP.sortable_ref((id, index) =>
            PP.apply_try((s) => PP.record_move(s, { collection: "blocks", id, index })),
          )}
        >
          ${blocks.map(
            (b) =>
              html`<div
                class=${`item${PP.block_on_get(state, chat, b) || b.type === "message" ? "" : " off"}`}
                key=${b.id}
                data-id=${b.id}
              >
                <span class="grip">⋮⋮</span
                ><span class="grow">${PP.block_name_get(state, b)}</span> ${
                  b.type === "message"
                    ? null
                    : toggle(PP.block_on_get(state, chat, b), "On or off in this chat", (v) =>
                        flip(b, v),
                      )
                }
              </div>`,
          )}
        </div>`,
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
          label: "Text file",
          sub: "Put its text in the box",
          onClick: () => PP.command_run("text_file"),
        }),
        item({
          label: "Several text files",
          sub: "One after another, in the box",
          onClick: () => PP.command_run("text_files"),
        }),
        item({
          label: "Attach files",
          sub: "Kept with the chat, sent to providers that take them",
          onClick: () => PP.command_run("attach"),
        }),
        item({ label: "Edit profile", right: "›", onClick: () => PP.command_run("profile_edit") }),
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
    const blocks = state.config.blocks.filter((b) => b.profile === id);
    return {
      title: profile.name,
      rows: [
        label("Sent top to bottom"),
        html`<div
          ref=${PP.sortable_ref((bid, index) =>
            PP.apply_try((s) => PP.record_move(s, { collection: "blocks", id: bid, index })),
          )}
        >
          ${blocks.map(
            (b) =>
              html`<div class=${`item${b.on === false ? " off" : ""}`} key=${b.id} data-id=${b.id}>
                <span class="grip">⋮⋮</span
                ><button class="grow" onClick=${() => PP.sheet_open("block", { id: b.id })}>
                  ${PP.block_name_get(state, b)}<small
                    >${b.type === "prompt" ? b.send : b.type}</small
                  >
                </button>
                ${
                  b.type === "message"
                    ? null
                    : toggle(b.on !== false, "On or off", (v) =>
                        PP.apply_try((s) =>
                          PP.record_set(s, { collection: "blocks", id: b.id, fields: { on: v } }),
                        ),
                      )
                }
              </div>`,
          )}
        </div>`,
        item({
          label: "Add a block",
          sub: "System prompts and plugins",
          right: "›",
          onClick: () => PP.sheet_open("block_add", { id }),
        }),
        label("This profile"),
        item({ label: "Use this profile", onClick: () => set({ "chats.profile": id }) }),
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
                PP.apply_try((s) => PP.record_delete(s, { collection: "profiles", id })).then(() =>
                  PP.sheet_close(),
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
            label: `${p.pinned ? "📌 " : ""}${p.name || p.text.slice(0, 40)}`,
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
            label: `${p.pinned ? "📌 " : ""}${p.name || p.text.split("\n")[0].slice(0, 40)}`,
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

  plugins: (state, { tab = "installed", filter = "" }) => {
    const catalogue =
      tab === "catalogue" &&
      (state.catalogue || load_get(state, "plugins:catalogue", () => PP.catalogue_load(state)));
    const type = (tags) => ["Plugin", ...(tags || [])].join(" · ");
    const tabs = html`<div class="chips">
      ${[
        ["installed", "Profile and installed"],
        ["catalogue", "Catalogue"],
      ].map(
        ([t, l]) =>
          html`<button
            class=${`pill${t === tab ? " on" : ""}`}
            key=${t}
            onClick=${() =>
              PP.ui_set((ui) => ({
                sheets: [...ui.sheets.slice(0, -1), { name: "plugins", data: { tab: t } }],
              }))}
          >
            ${l}
          </button>`,
      )}
    </div>`;
    if (tab === "catalogue") {
      const offers = ((catalogue && catalogue.offers) || []).filter(
        (o) => !filter || (o.tags || []).includes(filter),
      );
      return {
        title: "Plugins",
        rows: [
          tabs,
          ...(catalogue ? [] : [item({ label: "Checking the sources…" })]),
          ...(catalogue && (catalogue.updates || []).length
            ? [
                item({
                  label: "Update all",
                  cls: "prim",
                  sub: `${(catalogue.updates || []).length} updates available`,
                  onClick: () =>
                    PP.call_try("plugin_update", {}, "Updated. Restart the app to use them."),
                }),
              ]
            : []),
          ...offers.map((o) =>
            item({
              key: `${o.source.id}/${o.id}`,
              label: o.name,
              sub: `${type(o.tags)} · ${o.version}${o.installed ? " · installed" : ""}${o.app_too_old ? ` · needs app ${o.min_app}` : ""}`,
              right: o.installed ? null : html`<span class="pill">Get</span>`,
              onClick: () => PP.command_run("plugin_install", { entry: o }),
            }),
          ),
          ...((catalogue && catalogue.failed) || []).map((f) =>
            item({
              key: f.source.id,
              label: `Couldn't load ${f.source.url}`,
              sub: f.error.message,
              cls: "danger",
            }),
          ),
          item({
            label: "Install from a file, a link or an AI's answer",
            right: "›",
            onClick: () => PP.sheet_open("install"),
          }),
          label("Sources"),
          item({ label: "Promptpipe's own", sub: "Signed with the key built into the app" }),
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
                PP.dialog_open({
                  title: `Remove ${src.url}? Plugins installed from it stay.`,
                  choices: [["yes", "Remove"]],
                  command: "source_remove",
                  data: { id: src.id },
                }),
            }),
          ),
          item({
            label: "Add a source…",
            sub: "Someone else's plugin repository with a signed catalogue",
            onClick: () =>
              PP.dialog_open({
                title: "GitHub repository of the source",
                ok: "Check",
                command: "source_add",
              }),
          }),
        ],
      };
    }
    return {
      title: "Plugins",
      rows: [
        tabs,
        ...state.plugins.map((p) =>
          item({
            key: p.id,
            label: p.manifest.name,
            sub: `${type(p.manifest.tags)} · ${p.manifest.version} · ${p.copy.replace("_", "-")}${p.status !== "loaded" ? ` · ${p.status.replace("_", " ")}` : ""}`,
            right: "›",
            onClick: () => PP.sheet_open("plugin", { id: p.id }),
          }),
        ),
      ],
    };
  },

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
                PP.call_try(
                  "plugin_remove",
                  { plugin: id, copy: p.copy },
                  "Removed. Restart the app.",
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
      html`<input
        class="field"
        placeholder="GitHub folder, plugin.json or .zip"
        aria-label="Plugin link"
        onChange=${(e) => PP.ui_set(() => ({ install_link: e.target.value }))}
      />`,
      item({
        label: "Install from the link",
        cls: "prim",
        onClick: () => PP.command_run("plugin_install", { url: state.ui.install_link }),
      }),
      html`<textarea
        class="field"
        rows="6"
        placeholder="Or paste an AI's whole answer: each file's name on the line before its code block"
        onChange=${(e) => PP.ui_set(() => ({ install_answer: e.target.value }))}
      ></textarea>`,
      item({
        label: "Install the answer",
        onClick: () =>
          PP.command_run("plugin_install", {
            files: PP.answer_parse(state.ui.install_answer || ""),
          }),
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

  log: (state) => {
    const log = load_get(state, "log", () => PP.call_send("log_read", {}).then((r) => r.text));
    return {
      title: "Core log",
      rows: [
        html`<pre>${typeof log === "string" ? log : log ? log.error : "…"}</pre>`,
        item({
          label: "Copy",
          onClick: () => PP.call_try("clipboard_write", { text: log }, "Copied"),
        }),
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
        ...(PP.plugin_commands || [])
          .filter((c) => c.place === "Reply")
          .map((c) =>
            item({ key: c.id, label: c.label, onClick: () => PP.command_run(c.id, { turn }) }),
          ),
        label("Sent with"),
        html`<small>${(turn.blocks || []).join(", ") || "Your message only"}</small>`,
        ...(turn.notes || []).map((n) => html`<small key=${n}>${n}</small>`),
        html`<details>
          <summary class="muted">What went out and what came back</summary>
          <pre>${turn.sent}</pre>
          <pre>${turn.received}</pre>
        </details>`,
      ],
    };
  },
};

// The rows some settings sections have besides their settings.
const SECTION_EXTRAS = {
  "Chats and storage": (state) => [
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
      onClick: () => set({ "help.seen": [] }),
    }),
    item({
      label: state.app.safe_mode ? "Leave safe mode" : "Restart in safe mode",
      onClick: () => PP.call_try("app_start", { mode: state.app.safe_mode ? "normal" : "safe" }),
    }),
    item({ label: "Core log", right: "›", onClick: () => PP.sheet_open("log") }),
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
  return frame(state, sheet.title, sheet.rows);
};

const frame = (state, title, rows) =>
  html`<div class="layer">
    <div class="scrim" onClick=${() => PP.ui_set(() => ({ sheets: [] }))}></div>
    <section class="sheet" role="dialog" aria-label=${title}>
      <h2>
        ${state.ui.sheets.length > 1 ? PP.icon_render("‹", "Back", PP.sheet_close) : null}<span
          style="flex:1"
          >${title}</span
        >${PP.icon_render("✕", "Close", () => PP.ui_set(() => ({ sheets: [] })))}
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

PP.plugin_set({ functions: { sheet_render, change_render, field_render } });
