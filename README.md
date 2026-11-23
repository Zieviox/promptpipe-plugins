# promptpipe plugins

The plugins of [promptpipe](https://github.com/Zieviox/promptpipe). Each plugin is a folder with
a `plugin.json` and its files; how to write one is in the app's
[plugin guide](https://github.com/Zieviox/promptpipe/blob/main/app/src/main/assets/docs/PLUGINS.md).

- **The application** (tag `runtime`): `runtime-records` (records, settings, saving),
  `runtime-chats` (chat files, tags, Find, folders), `runtime-profiles` (profiles and what's
  sent), `runtime-send` (queues, site pages, side requests, the local API's jobs),
  `runtime-plugins` (catalogues and installing), `runtime-storage` (start, outside changes,
  tokens), `runtime-site` (the default way of using a site, run in its page), `runtime-screen`
  (the screen).
- **Providers**: DeepSeek, Qwen Chat, OpenAI-style API. **Block plugins**: Memory, Sub-chats,
  Base64. **Themes**: Ember, Paper. **Once**: Old app import (removable). **Diagnostics**: Typing
  trace (records what happens around the message box while its Record setting is on).
- **Libraries** are pinned in each plugin's `vendor/` with their licences: Preact, htm,
  markdown-it, SortableJS, fflate, Turndown.

## The catalogue

`catalogue.json` lists every plugin with the SHA-256 of each file. `catalogue.json.sig` is its
signature, which the app checks against the keys built into it. After changing a plugin:

```sh
python3 scripts/catalogue_build.py
python3 scripts/catalogue_sign.py        # where the key is: your phone (Termux) or computer
```

`scripts/catalogue_sign.py --new-key` makes the keys once (the app repo's `scripts/keys_make.sh`
runs it for you); `--backup` signs with the backup key.

## Tests

`npm test` (Node's built-in runner, Playwright's Chromium for the screen and the site routine):
the application without a phone, against stand-ins for the core and the platform.
