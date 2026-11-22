"use strict";
// A stand-in core for the screen in Chromium: the core's calls answered from memory (files by
// "root/path", the plugins as built in) and a server for the real loader and plugins. Used by
// test_screen.js and scripts/screens.js.
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const LOADER =
  process.env.PP_LOADER || path.join(ROOT, "..", "app", "app", "src", "main", "assets", "ui");

// The core's calls, from memory: files by "root/path", and the runtime plugins as built in.
// `pick` chooses which plugin folders count as installed (the runtime ones by default).
const core_build = (pick = (id) => id.startsWith("runtime-")) => {
  const files = {};
  let n = 0;
  const plugins = fs
    .readdirSync(ROOT)
    .filter((id) => pick(id) && fs.existsSync(path.join(ROOT, id, "plugin.json")))
    .map((id) => ({
      id,
      copy: "built_in",
      other_copies: [],
      manifest: JSON.parse(fs.readFileSync(path.join(ROOT, id, "plugin.json"), "utf8")),
    }));
  return {
    files,
    plugin_list: () => plugins,
    file_read: ({ root, path: p, pattern }) => {
      if (pattern) {
        const re = new RegExp(`^${pattern.replace(/[.]/g, "\\.").replace(/\*/g, "[^/]*")}$`);
        return Object.keys(files)
          .filter((k) => k.startsWith(`${root}/`) && re.test(k.slice(root.length + 1)))
          .map((k) => ({ path: k, data: files[k], revision: "r" }));
      }
      return files[`${root}/${p}`] === undefined
        ? []
        : [{ path: p, data: files[`${root}/${p}`], revision: "r" }];
    },
    file_write: ({ root, path: p, data }) => (
      (files[`${root}/${p}`] = data), { revision: `r${(n += 1)}` }
    ),
    file_delete: ({ root, path: p }) => (delete files[`${root}/${p}`], {}),
    chats_folder_get: () => ({ folder: "/phone/chats", default: "/phone/chats" }),
  };
};

const server_start = (core) =>
  new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://x");
      const send = (type, body) => (res.writeHead(200, { "content-type": type }), res.end(body));
      if (url.pathname === "/")
        return send("text/html", fs.readFileSync(path.join(LOADER, "index.html")));
      if (url.pathname.startsWith("/ui/"))
        return send("text/javascript", fs.readFileSync(path.join(LOADER, url.pathname.slice(4))));
      if (url.pathname.startsWith("/plugins/")) {
        const file = path.join(ROOT, url.pathname.slice(9));
        const type = file.endsWith(".css")
          ? "text/css"
          : file.endsWith(".js")
            ? "text/javascript"
            : "text/plain";
        return fs.existsSync(file)
          ? send(type, fs.readFileSync(file))
          : (res.writeHead(404), res.end());
      }
      if (url.pathname === "/events")
        return res.writeHead(200, { "content-type": "text/event-stream" });
      if (url.pathname === "/call") {
        let body = "";
        req.on("data", (c) => (body += c));
        return req.on("end", () => {
          const e = JSON.parse(body);
          const answer = core[e.name];
          const reply = answer
            ? { type: "reply", id: e.id, data: answer(e.data) }
            : { type: "reply", id: e.id, error: { code: "unimplemented", message: e.name } };
          send("application/json", JSON.stringify(reply));
        });
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });

const at = (m) => `2026-11-21T0${m}:00:00.000Z`;

// The wireframe's chats, folders, profile and two exchanges, as the app's own files.
const sample_put = (core) => {
  const put = (root, file, data) => (core.files[`${root}/${file}`] = JSON.stringify(data));
  const blocks = [
    {
      id: "b1",
      profile: "p1",
      type: "prompt",
      name: "Story voice",
      text: "Write in a quiet, close voice.",
      send: "every",
      number: 5,
      on: true,
    },
    { id: "b2", profile: "p1", type: "plugin", plugin: "memory", scope: "above", on: true },
    {
      id: "b3",
      profile: "p1",
      type: "prompt",
      name: "No clichés",
      text: "Avoid clichés.",
      send: "every",
      number: 5,
      on: true,
    },
    { id: "b4", profile: "p1", type: "message" },
  ];
  put("app", "config.json", {
    version: 1,
    settings: { "chats.profile": "p1", "chats.provider": "qwen-chat", "help.seen": ["welcome"] },
    profiles: [{ id: "p1", name: "Story writing", plugin_settings: {} }],
    blocks,
    groups: [],
    templates: [],
    provider_choices: { "qwen-chat": { model: "Qwen3-Max" } },
    connections: [],
    sources: [],
  });
  put("chats", ".promptpipe/folders.json", [
    { id: "", order: [], pinned: ["c1"] },
    { id: "Worlds", order: [] },
    { id: "Drafts", order: [] },
  ]);
  const chats = [
    ["c1", "Harbour story draft", "Harbour story draft.md", ["story", "draft", "rp"]],
    ["c2", "Character sheet: Ilse", "Worlds/Character sheet Ilse.md", ["rp", "characters"]],
    ["c3", "Plot knots", "Worlds/Plot knots.md", ["story"]],
    ["c4", "Feedback on chapter 3", "Feedback on chapter 3.md", ["feedback", "draft"]],
    ["c5", "Plain test", "Plain test.md", []],
  ];
  chats.forEach(([id, name, file, tags], i) =>
    put("chats", `.promptpipe/chats/${id}/meta.json`, {
      id,
      name,
      file,
      tags,
      own: {},
      created: at(i + 1),
      updated: at(i + 1),
    }),
  );
  const turn = (id, message, reply, tags = []) => ({
    id,
    chat: "c1",
    at: at(1),
    message,
    reply,
    thinking: "Shorter, darker, keep the rock.",
    thought_ms: 14000,
    sent: message,
    received: reply,
    tags,
    profile: "Story writing",
    model: "Qwen3-Max",
    page_url: "https://chat.qwen.ai/c/1",
    blocks: ["Story voice", "Memory", "No clichés", "Your message"],
    notes: [],
  });
  put("chats", ".promptpipe/chats/c1/turns.json", [
    turn(
      "t1",
      "Make the second paragraph shorter and darker.",
      "It was low and salt-grey. Warm, which the rock never was.",
    ),
    turn("t2", "Good. Now the door.", "The door had no handle, only a hum.", [
      "draft",
      "story",
      "rp",
    ]),
  ]);
};

module.exports = { core_build, server_start, sample_put, ROOT };
