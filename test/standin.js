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

module.exports = { core_build, server_start, ROOT };
